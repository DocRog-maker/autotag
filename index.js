const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { PDFNet } = require('@pdftron/pdfnet-node');

const MIN_MATCH_OVERLAP_RATIO = 0.85;
const MIN_IMAGE_RECT_AREA = 64;

function isImageTagType(type) {
  return type === 'Figure' || type === 'Image';
}

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
    const isImageTag = isImageTagType(type);
    const includeByFigureType = includeFigureWithoutAlt && isImageTag;
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

function normalizeRect(rect) {
  if (!rect) {
    return null;
  }
  const left = Math.min(rect.x1, rect.x2);
  const right = Math.max(rect.x1, rect.x2);
  const bottom = Math.min(rect.y1, rect.y2);
  const top = Math.max(rect.y1, rect.y2);
  return {
    x1: left,
    y1: bottom,
    x2: right,
    y2: top,
  };
}

function rectArea(rect) {
  const normalized = normalizeRect(rect);
  if (!normalized) {
    return 0;
  }
  const width = Math.max(0, normalized.x2 - normalized.x1);
  const height = Math.max(0, normalized.y2 - normalized.y1);
  return width * height;
}

function getRectSimilarityScore(rectA, rectB) {
  const a = normalizeRect(rectA);
  const b = normalizeRect(rectB);
  if (!a || !b) {
    return 0;
  }

  const overlapLeft = Math.max(a.x1, b.x1);
  const overlapBottom = Math.max(a.y1, b.y1);
  const overlapRight = Math.min(a.x2, b.x2);
  const overlapTop = Math.min(a.y2, b.y2);
  const overlapWidth = Math.max(0, overlapRight - overlapLeft);
  const overlapHeight = Math.max(0, overlapTop - overlapBottom);
  const overlapArea = overlapWidth * overlapHeight;
  if (overlapArea <= 0) {
    return 0;
  }

  const areaA = rectArea(a);
  const areaB = rectArea(b);
  if (areaA <= 0 || areaB <= 0) {
    return 0;
  }

  return overlapArea / Math.max(areaA, areaB);
}

async function applyAltTextMappings(sourceFigures, retaggedFigures) {
  const sourceByPage = groupByPageInOrder(sourceFigures);
  const targetByPage = groupByPageInOrder(retaggedFigures);
  const unmatched = [];
  const applied = [];
  const skippedArtifacts = [];

  const usedTargetObjNums = new Set();

  for (const [pageKey, sourceList] of sourceByPage.entries()) {
    const targetList = targetByPage.get(pageKey) || [];
    for (const sourceFigure of sourceList) {
      const sourceArea = rectArea(sourceFigure.rect);
      if (sourceArea > 0 && sourceArea < MIN_IMAGE_RECT_AREA) {
        skippedArtifacts.push({
          sourceType: sourceFigure.type,
          sourcePath: sourceFigure.path,
          sourceObjNum: sourceFigure.objNum,
          pageIndex: sourceFigure.pageIndex,
          pageNumber: sourceFigure.pageNumber,
          sourceMcids: sourceFigure.mcids,
          sourceRect: sourceFigure.rect,
          altText: sourceFigure.altText,
          reason: `Skipped as likely artifact: area ${sourceArea.toFixed(2)} < ${MIN_IMAGE_RECT_AREA}.`,
        });
        continue;
      }

      let targetFigure = null;
      let matchMethod = 'none';
      let overlapRatio = null;

      const candidateTargets = targetList.filter(
        (candidate) =>
          !usedTargetObjNums.has(candidate.objNum) &&
          (rectArea(candidate.rect) <= 0 || rectArea(candidate.rect) >= MIN_IMAGE_RECT_AREA)
      );

      if (sourceFigure.rect) {
        let bestMatch = null;
        let bestScore = 0;
        for (const candidate of candidateTargets) {
          if (!candidate.rect) {
            continue;
          }
          const score = getRectSimilarityScore(sourceFigure.rect, candidate.rect);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = candidate;
          }
        }
        if (bestMatch && bestScore >= MIN_MATCH_OVERLAP_RATIO) {
          targetFigure = bestMatch;
          matchMethod = 'rect-overlap';
          overlapRatio = bestScore;
        }
      }

      if (!targetFigure && !sourceFigure.rect) {
        targetFigure = candidateTargets[0] || null;
        if (targetFigure) {
          matchMethod = 'order-fallback-no-source-rect';
        }
      }

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
          reason:
            sourceFigure.rect
              ? `No retagged Figure met location overlap threshold (${Math.round(
                  MIN_MATCH_OVERLAP_RATIO * 100
                )}%).`
              : 'No corresponding retagged Figure available for fallback matching.',
        });
        continue;
      }

      usedTargetObjNums.add(targetFigure.objNum);

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
        matchMethod,
        overlapRatio,
        altText: sourceFigure.altText,
      });
    }
  }

  return { unmatched, applied, skippedArtifacts };
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
      (tag) => isImageTagType(tag.type) && tag.hasNonEmptyAltText
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
    const retaggedFigureElements = retaggedAltCandidates.filter((tag) => isImageTagType(tag.type));

    logTagLocations('Retagged document tag locations (Figure or has Alt)', retaggedAltCandidates);

    const { unmatched, applied, skippedArtifacts } = await applyAltTextMappings(
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
      skippedArtifactCount: skippedArtifacts.length,
      reapplied: applied,
      skippedArtifacts,
      unmatched,
    };
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');

    console.log(`Retagged PDF created: ${outputPath}`);
    console.log(`Alt-text report written: ${reportPath}`);
    if (unmatched.length > 0) {
      console.log(`Unmatched alt-text entries: ${unmatched.length}`);
    }
    if (skippedArtifacts.length > 0) {
      console.log(`Skipped likely artifact images: ${skippedArtifacts.length}`);
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
