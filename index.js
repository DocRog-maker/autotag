const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { PDFNet } = require('@pdftron/pdfnet-node');

function parseArgs(argv) {
  const args = {
    input: null,
    output: null,
    report: null,
    licenseKey: process.env.APRYSE_LICENSE_KEY || null,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') {
      args.input = argv[i + 1];
      i += 1;
    } else if (arg === '--output') {
      args.output = argv[i + 1];
      i += 1;
    } else if (arg === '--report') {
      args.report = argv[i + 1];
      i += 1;
    } else if (arg === '--license') {
      args.licenseKey = argv[i + 1];
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printUsage() {
  console.log(
    [
      'Usage:',
      '  node index.js --input <source.pdf> --output <retagged.pdf> [--report <report.json>] [--license <APRYSE_KEY>]',
      '',
      'Environment:',
      '  APRYSE_LICENSE_KEY can be used instead of --license',
    ].join('\n')
  );
}

async function ensureReadableFile(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Input path is not a file: ${filePath}`);
  }
}

async function collectFigureElements(doc, onlyWithAltText) {
  const stree = await doc.getStructTree();
  const figures = [];

  if (!stree || !(await stree.isValid())) {
    return figures;
  }

  async function getPageIndexFromContentItem(contentItem) {
    const page = await contentItem.getPage();
    if (!page) {
      return null;
    }
    return await page.getIndex();
  }

  async function walkElement(elem, pathSegments) {
    let firstPageIndex = null;
    const numKids = await elem.getNumKids();

    for (let i = 0; i < numKids; i += 1) {
      if (await elem.isContentItem(i)) {
        const contentItem = await elem.getAsContentItem(i);
        if (firstPageIndex === null) {
          firstPageIndex = await getPageIndexFromContentItem(contentItem);
        }
      } else {
        const child = await elem.getAsStructElem(i);
        const childFirstPageIndex = await walkElement(child, [...pathSegments, i]);
        if (firstPageIndex === null && childFirstPageIndex !== null) {
          firstPageIndex = childFirstPageIndex;
        }
      }
    }

    const type = await elem.getType();
    if (type === 'Figure') {
      const hasAlt = await elem.hasAlt();
      const altText = hasAlt ? await elem.getAlt() : null;
      const include = !onlyWithAltText || (hasAlt && altText && altText.trim().length > 0);

      if (include) {
        const sdfObj = await elem.getSDFObj();
        const objNum = await sdfObj.getObjNum();
        figures.push({
          element: elem,
          path: pathSegments.join('/'),
          objNum,
          pageIndex: firstPageIndex,
          altText: altText || '',
        });
      }
    }

    return firstPageIndex;
  }

  const rootKids = await stree.getNumKids();
  for (let i = 0; i < rootKids; i += 1) {
    const elem = await stree.getKid(i);
    await walkElement(elem, [i]);
  }

  return figures;
}

function groupByPageInOrder(figures) {
  const grouped = new Map();
  for (const figure of figures) {
    const key = String(figure.pageIndex === null ? 'unresolved' : figure.pageIndex);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(figure);
  }
  return grouped;
}

async function applyAltTextMappings(sourceFigures, retaggedFigures) {
  const sourceByPage = groupByPageInOrder(sourceFigures);
  const targetByPage = groupByPageInOrder(retaggedFigures);
  const unmatched = [];
  const applied = [];

  for (const [pageKey, sourceList] of sourceByPage.entries()) {
    const targetList = targetByPage.get(pageKey) || [];
    for (let i = 0; i < sourceList.length; i += 1) {
      const sourceFigure = sourceList[i];
      const targetFigure = targetList[i];

      if (!targetFigure) {
        unmatched.push({
          sourcePath: sourceFigure.path,
          sourceObjNum: sourceFigure.objNum,
          pageIndex: sourceFigure.pageIndex,
          altText: sourceFigure.altText,
          reason: 'No corresponding retagged Figure found on same page position.',
        });
        continue;
      }

      const targetObj = await targetFigure.element.getSDFObj();
      await targetObj.putText('Alt', sourceFigure.altText);

      applied.push({
        sourceObjNum: sourceFigure.objNum,
        targetObjNum: targetFigure.objNum,
        pageIndex: sourceFigure.pageIndex,
        altText: sourceFigure.altText,
      });
    }
  }

  return { unmatched, applied };
}

async function run() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
    return;
  }

  if (!args.input || !args.output) {
    printUsage();
    throw new Error('Missing required arguments --input and/or --output.');
  }

  const inputPath = path.resolve(args.input);
  const outputPath = path.resolve(args.output);
  const reportPath = path.resolve(args.report || `${outputPath}.alt-text-report.json`);

  await ensureReadableFile(inputPath);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });

  const tempOutputPath = path.join(
    os.tmpdir(),
    `autotag-${Date.now()}-${Math.random().toString(16).slice(2)}.pdf`
  );

  try {
    await PDFNet.initialize(args.licenseKey || undefined);
PDFNet.addResourceSearchPath( "./Lib");
    const sourceDoc = await PDFNet.PDFDoc.createFromFilePath(inputPath);
    await sourceDoc.initSecurityHandler();
    const sourceFiguresWithAlt = await collectFigureElements(sourceDoc, true);
 const pdf_ua = await PDFNet.PDFUAConformance.create()
    await pdf_ua.autoConvert(inputPath, tempOutputPath);

    const retaggedDoc = await PDFNet.PDFDoc.createFromFilePath(tempOutputPath);
    await retaggedDoc.initSecurityHandler();
    const retaggedFigureElements = await collectFigureElements(retaggedDoc, false);

    const { unmatched, applied } = await applyAltTextMappings(
      sourceFiguresWithAlt,
      retaggedFigureElements
    );

    await retaggedDoc.save(outputPath, 0);

    const report = {
      input: inputPath,
      output: outputPath,
      generatedAt: new Date().toISOString(),
      sourceFigureAltTextCount: sourceFiguresWithAlt.length,
      retaggedFigureCount: retaggedFigureElements.length,
      reappliedCount: applied.length,
      unmatchedCount: unmatched.length,
      unmatched,
    };
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

    console.log(`Retagged PDF created: ${outputPath}`);
    console.log(`Alt-text report written: ${reportPath}`);
    if (unmatched.length > 0) {
      console.log(`Unmatched alt-text entries: ${unmatched.length}`);
    }
  } finally {
    try {
      await fs.rm(tempOutputPath, { force: true });
      PDFNet.shutdown();
    } catch (cleanupErr) {
      console.error(`Warning: could not delete temp file ${tempOutputPath}: ${cleanupErr.message}`);
    }
  }
}

run().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
});
