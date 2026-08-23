/**
 * Exercises PdfService metadata and text extraction through the real unpdf parser.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { PdfService } from "../services/pdf";

function buildPdf(text: string, infoDict: string): Buffer {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${text.length + 25} >>\nstream\nBT /F1 12 Tf 72 720 Td (${text}) Tj ET\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		infoDict,
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

const buildPdfWithHostileMetadata = (text: string): Buffer =>
	buildPdf(text, "<< /Title 123 /Author (Ada) /CreationDate 0 /ModDate false >>");

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

	it("parses the PDF-spec `D:` creation date that unpdf actually returns", async () => {
		const service = new PdfService({} as IAgentRuntime);
		const info = await service.getDocumentInfo(
			buildPdf("utc date", "<< /CreationDate (D:20240102030405Z) >>")
		);

		const creationDate = info.metadata.creationDate;
		expect(creationDate).toBeInstanceOf(Date);
		expect(creationDate?.getUTCFullYear()).toBe(2024);
		expect(creationDate?.getUTCMonth()).toBe(0);
		expect(creationDate?.getUTCDate()).toBe(2);
		expect(creationDate?.getUTCHours()).toBe(3);
		expect(creationDate?.getUTCMinutes()).toBe(4);
		expect(creationDate?.getUTCSeconds()).toBe(5);
		expect(creationDate?.toISOString()).toBe("2024-01-02T03:04:05.000Z");
	});

	it("applies the UT offset of an offset-form `D:` date to yield an absolute instant", async () => {
		const service = new PdfService({} as IAgentRuntime);
		const info = await service.getDocumentInfo(
			buildPdf(
				"offset date",
				"<< /CreationDate (D:20200610093121-05'00') /ModDate (D:20200610093121+02'30') >>"
			)
		);

		// Local 09:31:21 at UTC-05:00 is 14:31:21Z.
		expect(info.metadata.creationDate?.toISOString()).toBe("2020-06-10T14:31:21.000Z");
		// Local 09:31:21 at UTC+02:30 is 07:01:21Z.
		expect(info.metadata.modificationDate?.toISOString()).toBe("2020-06-10T07:01:21.000Z");
	});
});
