# autotag

Node.js CLI app that uses Apryse SDK to:

1. read existing `Figure` tags that already contain Alt-text
2. retag the PDF for accessibility (PDF/UA auto-convert)
3. reapply captured Alt-text onto retagged `Figure` elements
4. generate a JSON report listing unmatched Alt-text entries

Matching uses same-page rectangle overlap (85% minimum), and very small image rectangles are skipped as likely artifacts.

## Requirements

- Node.js 18+
- Apryse license key

## Install

```bash
npm install
```

## Run

```bash
node index.js --input input.pdf --output output.pdf --report report.json
```

Options:

- `--input` (required): source PDF path
- `--output` (required): output retagged PDF path
- `--report` (optional): report path (default: `<output>.alt-text-report.json`)
- `--license` (optional): Apryse key (or set `APRYSE_LICENSE_KEY`)

## Report format

The report includes:

- source and retagged tag locations (type, page, structure path, rect, alt-text)
- number of source figure tags with Alt-text
- number of retagged figure tags found
- number successfully reapplied
- unmatched entries including Alt-text and source info for manual reapplication
