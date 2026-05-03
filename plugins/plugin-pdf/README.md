# @elizaos/plugin-pdf

PDF text extraction plugin for ElizaOS.

## Installation

To add this plugin to your Eliza OS project, run the following command:

```bash
elizaos plugins add @elizaos/plugin-pdf
```

```
bun add @elizaos/plugin-pdf
```

## Configuration

No configuration required. Uses `pdfjs-dist` for local PDF processing.

## Usage

To use this plugin, add its name to the `plugins` array within your character configuration object. Eliza OS will then load and initialize the plugin automatically.

```typescript
const character: Partial<Character> = {
  name: "MyAgent",
  plugins: ["@elizaos/plugin-pdf"],
};
```

## Usage

### `PdfService`

Extracts text from PDF files.

**Methods:**

- `convertPdfToText(pdfBuffer: Buffer): Promise<string>` - Convert PDF buffer to text
- `convertPdfToTextWithOptions(pdfBuffer: Buffer, options): Promise<PdfConversionResult>` - Convert with options
- `getDocumentInfo(pdfBuffer: Buffer): Promise<PdfDocumentInfo>` - Get full document information

**Example:**

```typescript
import * as fs from "node:fs/promises";
import { ServiceType, type IPdfService } from "@elizaos/core"; // Assuming ServiceType and IPdfService are available

async function extractTextFromPdf(runtime: IAgentRuntime, filePath: string) {
  try {
    // Obtain the PdfService instance from the runtime
    const pdfService = runtime.getService<IPdfService>(ServiceType.PDF);

    if (!pdfService) {
      console.error("PdfService not found. Ensure the plugin is registered.");
      return;
    }

    // Read the PDF file into a buffer
    const pdfBuffer = await fs.readFile(filePath);

    // Convert the PDF buffer to text
    const textContent = await pdfService.convertPdfToText(pdfBuffer);
    console.log("Extracted Text:", textContent);
    return textContent;
  } catch (error) {
    console.error("Error extracting text from PDF:", error);
  }
}

// Assuming 'agentRuntime' is your initialized IAgentRuntime instance
// extractTextFromPdf(agentRuntime, 'path/to/your/document.pdf');
```

## Dependencies

- `pdfjs-dist` - PDF parsing and rendering

## License

MIT
