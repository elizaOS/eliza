# @elizaos/plugin-pdf

This plugin integrates PDF text extraction capabilities into the ElizaOS platform, allowing agents to read and process content from PDF documents.

## Overview

The `@elizaos/plugin-pdf` provides a service to extract text from PDF files. This enables Eliza OS agents to understand and utilize information contained within PDF documents as part of their operational workflows.

## Installation

To add this plugin to your Eliza OS project, run the following command:

```bash
elizaos plugins add @elizaos/plugin-pdf
```

```
bun add @elizaos/plugin-pdf
```

## Configuration

This plugin does not require any specific environment variables or settings beyond the standard Eliza OS setup. It uses `pdfjs-dist` for local PDF processing and does not rely on external API keys or services for its core functionality.

## Usage

To use this plugin, add its name to the `plugins` array within your character configuration object. Eliza OS will then load and initialize the plugin automatically.

**Example Character Configuration:**

```typescript
const character: Partial<Character> = {
  name: "MyAgent",
  plugins: [
    // ... other plugins
    "@elizaos/plugin-pdf",
    // ... other plugins
  ],
  settings: {
    // ... character specific settings
  },
};

// The Eliza OS runtime will automatically make the PdfService available
// when the '@elizaos/plugin-pdf' is included in the character's plugin list.
```

Once the plugin is part of the character's configuration, you can access the `PdfService` through the Eliza OS runtime to interact with PDF files.

## Services

### `PdfService`

The `PdfService` is responsible for parsing PDF files and extracting their text content.

**Capabilities:**

- Converts PDF documents (provided as a Buffer) into plain text.
- Processes multi-page PDF documents.

**Key Method:**

- `convertPdfToText(pdfBuffer: Buffer): Promise<string>`: Asynchronously converts a PDF file buffer into a single string containing the text from all pages.

**Example of using the service:**

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

The primary dependency for PDF processing is:

- `pdfjs-dist`: A general-purpose, web standards-based platform for parsing and rendering PDFs.

Ensure that your project's dependencies are correctly installed for the plugin to function.

## License

This plugin is part of the Eliza project. See the main project repository for license information.
