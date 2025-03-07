import {
	type IAgentRuntime,
	type IPdfService,
	Service,
	type ServiceType,
	ServiceTypes,
} from "@elizaos/core";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist";
import type {
	TextItem,
	TextMarkedContent,
} from "pdfjs-dist/types/src/display/api";

export class PdfService extends Service implements IPdfService {
	static serviceType: ServiceType = ServiceTypes.PDF;
	capabilityDescription = "The agent is able to convert PDF files to text";

	constructor(runtime: IAgentRuntime) {
		super();
		this.runtime = runtime;
	}

	static async start(runtime: IAgentRuntime): Promise<PdfService> {
		const service = new PdfService(runtime);
		return service;
	}

	static async stop(runtime: IAgentRuntime) {
		const service = runtime.getService(ServiceTypes.PDF);
		if (service) {
			await service.stop();
		}
	}

	async stop() {
		// do nothing
	}

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
