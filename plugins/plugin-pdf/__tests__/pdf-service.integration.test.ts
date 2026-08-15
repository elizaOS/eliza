/**
 * Exercises PdfService metadata and text extraction through the real unpdf parser.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { PdfService } from "../services/pdf";

function buildPdfWithHostileMetadata(text: string): Buffer {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${text.length + 25} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		"<< /Title 123 /Author (Ada) /CreationDate 0 /ModDate false >>",
	];

	let body = "%PDF-1.4\n";
	const offsets = [0];
	for (let index = 0; index < objects.length; index += 1) {
		offsets.push(Buffer.byteLength(body));
		body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}

	const xrefStart = Buffer.byteLength(body);
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) {
		body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	}
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\n`;
	body += `startxref\n${xrefStart}\n%%EOF\n`;
	return Buffer.from(body);
}

describe("PdfService real unpdf boundary", () => {
	it("extracts text while omitting numeric and boolean metadata dates", async () => {
		const service = new PdfService({} as IAgentRuntime);
		const info = await service.getDocumentInfo(
			buildPdfWithHostileMetadata("real parser boundary")
		);

		expect(info.text).toBe("real parser boundary");
		expect(info.metadata.author).toBe("Ada");
		expect(info.metadata.title).toBeUndefined();
		expect(info.metadata.creationDate).toBeUndefined();
		expect(info.metadata.modificationDate).toBeUndefined();
	});
});
