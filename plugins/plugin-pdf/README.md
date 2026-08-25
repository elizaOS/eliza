# @elizaos/plugin-pdf

PDF text extraction plugin for elizaOS.

Adds `PdfService` to an Eliza agent runtime so that PDF buffers can be parsed and their text content extracted. The service is available to any action, provider, or agent code via `runtime.getService(ServiceType.PDF)`.

## Installation

```bash
elizaos plugins add @elizaos/plugin-pdf
```

or with bun directly:

```bash
bun add @elizaos/plugin-pdf
```

## Configuration

No environment variables or configuration required. Uses [`unpdf`](https://github.com/unjs/unpdf) for local, self-contained PDF processing.

## Enabling the Plugin

Add the package name to the `plugins` array in your character file:

```typescript
const character: Partial<Character> = {
  name: "MyAgent",
  plugins: ["@elizaos/plugin-pdf"],
};
```

## PdfService API

Retrieve the service instance from the runtime:

```typescript
import { ServiceType } from "@elizaos/core";
import type { PdfService } from "@elizaos/plugin-pdf";

const pdfService = runtime.getService<PdfService>(ServiceType.PDF);
```

### Methods

**`convertPdfToText(pdfBuffer: Buffer): Promise<string>`**

Extracts all text from every page as a single cleaned string.

```typescript
import * as fs from "node:fs/promises";

const buffer = await fs.readFile("document.pdf");
const text = await pdfService.convertPdfToText(buffer);
```

**`convertPdfToTextWithOptions(pdfBuffer: Buffer, options?: PdfExtractionOptions): Promise<PdfConversionResult>`**

Extracts text with control over page range, whitespace, and cleanup. Returns a result object with `success`, `text`, `pageCount`, and `error` fields.

```typescript
const result = await pdfService.convertPdfToTextWithOptions(buffer, {
  startPage: 1,
  endPage: 5,
  preserveWhitespace: false,
  cleanContent: true,
});

if (result.success) {
  console.log(result.text);
}
```

Page ranges are validated against the document. A `startPage` beyond the last
page returns `success: false` with an error naming the requested page and the
document's page count rather than silently clamping to (and returning) the last
page's text. An oversized `endPage` on an in-range `startPage` is clamped down
to the final page, so `{ startPage: 2, endPage: 99 }` on a 3-page document
extracts pages 2–3.

**`getDocumentInfo(pdfBuffer: Buffer): Promise<PdfDocumentInfo>`**

Returns full document information: page count, per-page dimensions + text, and metadata (title, author, subject, keywords, creator, producer, creation/modification dates).

`creationDate`/`modificationDate` are parsed from the PDF-spec date string that `unpdf` returns (`D:YYYYMMDDHHmmSSOHH'mm'`, ISO 32000-1 §7.9.4). When the string carries a UT relation (`Z`, `+`, or `-`) the declared offset is applied and the field is an absolute UTC `Date`. When the UT relation is omitted the document time zone is unknown and, per PDF Reference 3.8.3, the remaining fields are local time; that case is interpreted as local wall-clock time (a `Date` built with the local constructor) rather than being falsely claimed as UTC. A value that is missing or not a valid spec date is omitted (left `undefined`) rather than surfaced as an Invalid Date.

## Exported Types

```typescript
PdfConversionResult   // { success, text?, pageCount?, error? }
PdfExtractionOptions  // { startPage?, endPage?, preserveWhitespace?, cleanContent? }
PdfPageInfo           // { pageNumber, width, height, text }
PdfMetadata           // { title?, author?, subject?, keywords?, creator?, producer?, creationDate?, modificationDate? }
PdfDocumentInfo       // { pageCount, metadata, text, pages }
```

## Platform Support

Builds for both Node.js and browser environments. The `exports` field in `package.json` selects the correct entry point automatically.

## Dependencies

- [`unpdf`](https://github.com/unjs/unpdf) — PDF parsing (wraps PDF.js for Node + browser)

