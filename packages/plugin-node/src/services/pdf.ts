import {
    type IAgentRuntime,
    type IPdfService,
    Service,
    ServiceType,
} from "@elizaos/core";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import type { TextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api";

export class PdfService extends Service implements IPdfService {
    static serviceType: ServiceType = ServiceType.PDF;

    constructor() {
        super();
    }

    getInstance(): IPdfService {
        return PdfService.getInstance();
    }

    async initialize(_runtime: IAgentRuntime): Promise<void> {}

    async convertPdfToText(pdfBuffer: Buffer): Promise<string> {
        // Convert Buffer to Uint8Array
        const uint8Array = new Uint8Array(pdfBuffer);

        const pdf: PDFDocumentProxy = await getDocument({ data: uint8Array })
            .promise;
        const numPages = pdf.numPages;
        const textPages: string[] = [];

        for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            const pageText = textContent.items
                .filter(isTextItem)
                .map((item) => item.str)
                .join(" ");
            textPages.push(pageText);
        }

        return textPages.join("\n");
    }
}

// Type guard function
function isTextItem(item: TextItem | TextMarkedContent): item is TextItem {
    return "str" in item;
}
