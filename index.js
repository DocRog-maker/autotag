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

async function collectAltCandidateElements(doc, options) {
  const { onlyWithAltText, includeFigureWithoutAlt } = options;
  const stree = await doc.getStructTree();
  const elements = [];

  if (!stree || !(await stree.isValid())) {
    return elements;
  }

  async function getContentItemLocation(contentItem) {
    const page = await contentItem.getPage();
    const pageIndex = page ? await page.getIndex() : null;
    const contentType = await contentItem.getType();
    const isMarkedContent =
      contentType === PDFNet.ContentItem.Type.e_MCR || contentType === PDFNet.ContentItem.Type.e_MCID;
    const mcid = isMarkedContent ? await contentItem.getMCID() : null;

    return {
      pageIndex,
      mcid,
      contentType,
    };
  }

  function dedupeNumbers(values) {
    const seen = new Set();
    const out = [];
    for (const value of values) {
      if (value === null || value === undefined) {
        continue;
      }
      const key = String(value);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(value);
      }
    }
    return out;
  }

  async function readRectArray(rectObj) {
    if (!rectObj || !(await rectObj.isArray())) {
      return null;
    }
    const size = await rectObj.size();
    if (size < 4) {
      return null;
    }
    const values = [];
    for (let i = 0; i < 4; i += 1) {
      const valueObj = await rectObj.getAt(i);
      if (!valueObj || !(await valueObj.isNumber())) {
        return null;
      }
      values.push(await valueObj.getNumber());
    }
    return {
      x1: values[0],
      y1: values[1],
      x2: values[2],
      y2: values[3],
    };
  }

  async function extractRectFromAttributes(attrObj) {
    if (!attrObj) {
      return null;
    }

    if (await attrObj.isDict()) {
      const bbox = await attrObj.findObj('BBox');
      const rect = await readRectArray(bbox);
      if (rect) {
        return rect;
      }
      return null;
    }

    if (await attrObj.isArray()) {
      const size = await attrObj.size();
      for (let i = 0; i < size; i += 1) {
        const item = await attrObj.getAt(i);
        const rect = await extractRectFromAttributes(item);
        if (rect) {
          return rect;
        }
      }
    }

    return null;
  }

  async function getElementRectFromSdfObj(sdfObj) {
    const directBBox = await sdfObj.findObj('BBox');
    const directRect = await readRectArray(directBBox);
    if (directRect) {
      return directRect;
    }

    const attrObj = await sdfObj.findObj('A');
    return extractRectFromAttributes(attrObj);
  }

  async function walkElement(elem, pathSegments) {
    let firstPageIndex = null;
    const mcids = [];
    const numKids = await elem.getNumKids();

    for (let i = 0; i < numKids; i += 1) {
      if (await elem.isContentItem(i)) {
        const contentItem = await elem.getAsContentItem(i);
        const contentLocation = await getContentItemLocation(contentItem);
        if (firstPageIndex === null) {
          firstPageIndex = contentLocation.pageIndex;
        }
        if (contentLocation.mcid !== null) {
          mcids.push(contentLocation.mcid);
        }
      } else {
        const child = await elem.getAsStructElem(i);
        const childLocation = await walkElement(child, [...pathSegments, i]);
        if (firstPageIndex === null && childLocation.firstPageIndex !== null) {
          firstPageIndex = childLocation.firstPageIndex;
        }
        mcids.push(...childLocation.mcids);
      }
    }

    const type = await elem.getType();
    const hasAlt = await elem.hasAlt();
    const altText = hasAlt ? await elem.getAlt() : '';
    const hasNonEmptyAltText = hasAlt && altText.trim().length > 0;
    const isFigure = type === 'Figure';
    const includeByFigureType = includeFigureWithoutAlt && isFigure;
    const includeByAltText = onlyWithAltText ? hasNonEmptyAltText : hasAlt;

    if (includeByFigureType || includeByAltText) {
      const sdfObj = await elem.getSDFObj();
      const objNum = await sdfObj.getObjNum();
      elements.push({
        element: elem,
        type,
        path: pathSegments.join('/'),
        objNum,
        pageIndex: firstPageIndex,
        pageNumber: firstPageIndex && firstPageIndex > 0 ? firstPageIndex : null,
        mcids: dedupeNumbers(mcids),
        rect: await getElementRectFromSdfObj(sdfObj),
        hasAlt,
        altText,
        hasNonEmptyAltText,
      });
    }

    return {
      firstPageIndex,
      mcids: dedupeNumbers(mcids),
    };
  }

  const rootKids = await stree.getNumKids();
  for (let i = 0; i < rootKids; i += 1) {
    const elem = await stree.getKid(i);
    await walkElement(elem, [i]);
  }

  return elements;
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
          sourceType: sourceFigure.type,
          sourcePath: sourceFigure.path,
          sourceObjNum: sourceFigure.objNum,
          pageIndex: sourceFigure.pageIndex,
          pageNumber: sourceFigure.pageNumber,
          sourceMcids: sourceFigure.mcids,
          sourceRect: sourceFigure.rect,
          altText: sourceFigure.altText,
          reason: 'No corresponding retagged Figure found on same page position.',
        });
        continue;
      }

      const targetObj = await targetFigure.element.getSDFObj();
      await targetObj.putText('Alt', sourceFigure.altText);

      applied.push({
        sourceObjNum: sourceFigure.objNum,
        sourcePath: sourceFigure.path,
        targetObjNum: targetFigure.objNum,
        targetPath: targetFigure.path,
        pageIndex: sourceFigure.pageIndex,
        pageNumber: sourceFigure.pageNumber,
        sourceMcids: sourceFigure.mcids,
        targetMcids: targetFigure.mcids,
        sourceRect: sourceFigure.rect,
        targetRect: targetFigure.rect,
        altText: sourceFigure.altText,
      });
    }
  }

  return { unmatched, applied };
}

function toTagLocationLogEntry(tag) {
  return {
    type: tag.type,
    objNum: tag.objNum,
    path: tag.path,
    pageIndex: tag.pageIndex,
    pageNumber: tag.pageNumber,
    mcids: tag.mcids,
    rect: tag.rect,
    hasAlt: tag.hasAlt,
    altText: tag.altText,
  };
}

function logTagLocations(label, tags) {
  console.log(`${label}: ${tags.length}`);
  if (tags.length === 0) {
    return;
  }
  for (const tag of tags) {
    const pageLabel = tag.pageNumber === null ? 'unknown-page' : `page ${tag.pageNumber}`;
    const altSummary = tag.hasNonEmptyAltText ? `"${tag.altText}"` : '[no alt text]';
    console.log(
      `  - ${tag.type} obj=${tag.objNum} ${pageLabel} path=${tag.path} mcids=${JSON.stringify(
        tag.mcids
      )} rect=${JSON.stringify(tag.rect)} alt=${altSummary}`
    );
  }
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
    await PDFNet.addResourceSearchPath('./Lib');

    const sourceDoc = await PDFNet.PDFDoc.createFromFilePath(inputPath);
    await sourceDoc.initSecurityHandler();
    const sourceAltCandidates = await collectAltCandidateElements(sourceDoc, {
      onlyWithAltText: false,
      includeFigureWithoutAlt: true,
    });
    const sourceFiguresWithAlt = sourceAltCandidates.filter(
      (tag) => tag.type === 'Figure' && tag.hasNonEmptyAltText
    );

    logTagLocations('Original document tag locations (Figure or has Alt)', sourceAltCandidates);

    const pdfUaConformance = await PDFNet.PDFUAConformance.create();
    await pdfUaConformance.autoConvert(inputPath, tempOutputPath);

    const retaggedDoc = await PDFNet.PDFDoc.createFromFilePath(tempOutputPath);
    await retaggedDoc.initSecurityHandler();
    const retaggedAltCandidates = await collectAltCandidateElements(retaggedDoc, {
      onlyWithAltText: false,
      includeFigureWithoutAlt: true,
    });
    const retaggedFigureElements = retaggedAltCandidates.filter((tag) => tag.type === 'Figure');

    logTagLocations('Retagged document tag locations (Figure or has Alt)', retaggedAltCandidates);

    const { unmatched, applied } = await applyAltTextMappings(
      sourceFiguresWithAlt,
      retaggedFigureElements
    );

    await retaggedDoc.save(outputPath, 0);

    const report = {
      input: inputPath,
      output: outputPath,
      generatedAt: new Date().toISOString(),
      sourceTagLocationCount: sourceAltCandidates.length,
      retaggedTagLocationCount: retaggedAltCandidates.length,
      sourceTagLocations: sourceAltCandidates.map(toTagLocationLogEntry),
      retaggedTagLocations: retaggedAltCandidates.map(toTagLocationLogEntry),
      sourceFigureAltTextCount: sourceFiguresWithAlt.length,
      retaggedFigureCount: retaggedFigureElements.length,
      reappliedCount: applied.length,
      unmatchedCount: unmatched.length,
      reapplied: applied,
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
