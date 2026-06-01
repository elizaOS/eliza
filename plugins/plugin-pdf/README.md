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

**`getDocumentInfo(pdfBuffer: Buffer): Promise<PdfDocumentInfo>`**

Returns full document information: page count, per-page dimensions + text, and metadata (title, author, subject, keywords, creator, producer, creation/modification dates).

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

## License

MIT
