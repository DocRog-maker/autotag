const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { PDFNet } = require('@pdftron/pdfnet-node');

// Accept small position/size differences between original and retagged image tags.
const MIN_MATCH_OVERLAP_RATIO = 0.85;
// Ignore tiny image tags that are usually artifacts/decorative fragments.
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

async function collectTagCandidates(doc, options) {
  const { onlyWithAltText, includeImageTags } = options;
  const stree = await doc.getStructTree();
  const elements = [];

  if (!stree || !(await stree.isValid())) {
    return elements;
  }

  async function getContentItemLocation(contentItem) {
    const page = await contentItem.getPage();
    const pageIndex = page ? await page.getIndex() : null;
    return { pageIndex };
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
    const numKids = await elem.getNumKids();

    for (let i = 0; i < numKids; i += 1) {
      if (await elem.isContentItem(i)) {
        const contentItem = await elem.getAsContentItem(i);
        const contentLocation = await getContentItemLocation(contentItem);
        if (firstPageIndex === null) {
          firstPageIndex = contentLocation.pageIndex;
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
    const hasAlt = await elem.hasAlt();
    const altText = hasAlt ? await elem.getAlt() : '';
    const hasNonEmptyAltText = hasAlt && altText.trim().length > 0;
    const isImageTag = isImageTagType(type);
    const includeByType = includeImageTags && isImageTag;
    const includeByAltText = onlyWithAltText ? hasNonEmptyAltText : hasAlt;

    if (includeByType || includeByAltText) {
      const sdfObj = await elem.getSDFObj();
      const objNum = await sdfObj.getObjNum();
      elements.push({
        element: elem,
        type,
        path: pathSegments.join('/'),
        objNum,
        pageIndex: firstPageIndex,
        pageNumber: firstPageIndex && firstPageIndex > 0 ? firstPageIndex : null,
        rect: await getElementRectFromSdfObj(sdfObj),
        hasAlt,
        altText,
        hasNonEmptyAltText,
      });
    }

    return firstPageIndex;
  }

  const rootKids = await stree.getNumKids();
  for (let i = 0; i < rootKids; i += 1) {
    const elem = await stree.getKid(i);
    await walkElement(elem, [i]);
  }

  return elements;
}

function groupByPageInOrder(tags) {
  const grouped = new Map();
  for (const tag of tags) {
    const key = String(tag.pageIndex === null ? 'unresolved' : tag.pageIndex);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(tag);
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

async function applyAltTextMappings(sourceTagsWithAlt, retaggedImageTags) {
  const sourceByPage = groupByPageInOrder(sourceTagsWithAlt);
  const targetByPage = groupByPageInOrder(retaggedImageTags);
  const unmatched = [];
  const applied = [];
  const skippedArtifacts = [];

  const usedTargetObjNums = new Set();

  for (const [pageKey, sourceList] of sourceByPage.entries()) {
    const targetList = targetByPage.get(pageKey) || [];
    for (const sourceTag of sourceList) {
      const sourceArea = rectArea(sourceTag.rect);
      if (sourceArea > 0 && sourceArea < MIN_IMAGE_RECT_AREA) {
        skippedArtifacts.push({
          sourceType: sourceTag.type,
          sourcePath: sourceTag.path,
          sourceObjNum: sourceTag.objNum,
          pageIndex: sourceTag.pageIndex,
          pageNumber: sourceTag.pageNumber,
          sourceRect: sourceTag.rect,
          altText: sourceTag.altText,
          reason: `Skipped as likely artifact: area ${sourceArea.toFixed(2)} < ${MIN_IMAGE_RECT_AREA}.`,
        });
        continue;
      }

      let targetTag = null;
      let matchMethod = 'none';
      let overlapRatio = null;

      const candidateTargets = targetList.filter(
        (candidate) =>
          !usedTargetObjNums.has(candidate.objNum) &&
          (rectArea(candidate.rect) <= 0 || rectArea(candidate.rect) >= MIN_IMAGE_RECT_AREA)
      );

      if (sourceTag.rect) {
        let bestMatch = null;
        let bestScore = 0;
        for (const candidate of candidateTargets) {
          if (!candidate.rect) {
            continue;
          }
          const score = getRectSimilarityScore(sourceTag.rect, candidate.rect);
          if (score > bestScore) {
            bestScore = score;
            bestMatch = candidate;
          }
        }
        if (bestMatch && bestScore >= MIN_MATCH_OVERLAP_RATIO) {
          targetTag = bestMatch;
          matchMethod = 'rect-overlap';
          overlapRatio = bestScore;
        }
      }

      if (!targetTag && !sourceTag.rect) {
        targetTag = candidateTargets[0] || null;
        if (targetTag) {
          matchMethod = 'order-fallback-no-source-rect';
        }
      }

      if (!targetTag) {
        unmatched.push({
          sourceType: sourceTag.type,
          sourcePath: sourceTag.path,
          sourceObjNum: sourceTag.objNum,
          pageIndex: sourceTag.pageIndex,
          pageNumber: sourceTag.pageNumber,
          sourceRect: sourceTag.rect,
          altText: sourceTag.altText,
          reason:
            sourceTag.rect
              ? `No retagged image tag met location overlap threshold (${Math.round(
                  MIN_MATCH_OVERLAP_RATIO * 100
                )}%).`
              : 'No corresponding retagged image tag available for fallback matching.',
        });
        continue;
      }

      usedTargetObjNums.add(targetTag.objNum);

      const targetObj = await targetTag.element.getSDFObj();
      await targetObj.putText('Alt', sourceTag.altText);

      applied.push({
        sourceObjNum: sourceTag.objNum,
        sourcePath: sourceTag.path,
        targetObjNum: targetTag.objNum,
        targetPath: targetTag.path,
        pageIndex: sourceTag.pageIndex,
        pageNumber: sourceTag.pageNumber,
        sourceRect: sourceTag.rect,
        targetRect: targetTag.rect,
        matchMethod,
        overlapRatio,
        altText: sourceTag.altText,
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
      `  - ${tag.type} obj=${tag.objNum} ${pageLabel} path=${tag.path} rect=${JSON.stringify(
        tag.rect
      )} alt=${altSummary}`
    );
    console.log(`    Alt: ${tag.hasNonEmptyAltText ? tag.altText : '[no alt text]'}`);
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

  if (inputPath === outputPath) {
    throw new Error(
      'Input and output path are the same. That would overwrite the source file, so stopping.'
    );
  }

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
    const sourceTagCandidates = await collectTagCandidates(sourceDoc, {
      onlyWithAltText: false,
      includeImageTags: true,
    });
    const sourceImageTagsWithAlt = sourceTagCandidates.filter(
      (tag) => isImageTagType(tag.type) && tag.hasNonEmptyAltText
    );

    logTagLocations('Original document tag locations (image tag or has Alt)', sourceTagCandidates);

    const pdfUaConformance = await PDFNet.PDFUAConformance.create();
    await pdfUaConformance.autoConvert(inputPath, tempOutputPath);

    const retaggedDoc = await PDFNet.PDFDoc.createFromFilePath(tempOutputPath);
    await retaggedDoc.initSecurityHandler();
    const retaggedTagCandidates = await collectTagCandidates(retaggedDoc, {
      onlyWithAltText: false,
      includeImageTags: true,
    });
    const retaggedImageTags = retaggedTagCandidates.filter((tag) => isImageTagType(tag.type));

    logTagLocations('Retagged document tag locations (image tag or has Alt)', retaggedTagCandidates);

    const { unmatched, applied, skippedArtifacts } = await applyAltTextMappings(
      sourceImageTagsWithAlt,
      retaggedImageTags
    );

    await retaggedDoc.save(outputPath, 0);

    const report = {
      input: inputPath,
      output: outputPath,
      generatedAt: new Date().toISOString(),
      sourceTagLocationCount: sourceTagCandidates.length,
      retaggedTagLocationCount: retaggedTagCandidates.length,
      sourceTagLocations: sourceTagCandidates.map(toTagLocationLogEntry),
      retaggedTagLocations: retaggedTagCandidates.map(toTagLocationLogEntry),
      sourceFigureAltTextCount: sourceImageTagsWithAlt.length,
      retaggedFigureCount: retaggedImageTags.length,
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
    } catch (cleanupErr) {
      console.error(`Warning: could not delete temp file ${tempOutputPath}: ${cleanupErr.message}`);
    }
    try {
      PDFNet.shutdown();
    } catch (shutdownErr) {
      console.error(`Unable to shutdown ${shutdownErr.message}`);
    }
  }
}

run().catch((err) => {
  console.error(`Failed: ${err.message}`);
  process.exitCode = 1;
});
