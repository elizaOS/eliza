/**
 * Exercises PdfService metadata and text extraction through the real unpdf parser.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { PdfService } from "../index";

function buildPdf(
	text: string,
	infoDict: string,
	stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`,
): Buffer {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 7 0 R >> >> >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		infoDict,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
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
	it.each([
		{
			name: "paragraph line breaks",
			stream:
				"BT /F1 12 Tf 72 720 Td (Project schedule) Tj 0 -18 Td (Monday: prepare report) Tj 0 -18 Td (Tuesday: publish report) Tj ET",
			expected: "Project schedule\nMonday: prepare report\nTuesday: publish report",
		},
		{
			name: "a word split across font runs",
			stream: "BT /F1 12 Tf 72 720 Td (Re) Tj /F2 12 Tf (port) Tj ET",
			expected: "Report",
		},
		{
			name: "spaces between ordinary words",
			stream: "BT /F1 12 Tf 72 720 Td (prepare the report) Tj ET",
			expected: "prepare the report",
		},
	])("preserves $name in every text extraction path", async ({ stream, expected }) => {
		const service = new PdfService({
			useModel: async () => ({ description: "Page transcribed." }),
		} as unknown as IAgentRuntime);
		const bytes = buildPdf("", "<< >>", stream);
		const original = Buffer.from(bytes);
		expect(await service.convertPdfToText(bytes)).toBe(expected);
		expect((await service.getDocumentInfo(bytes)).text).toBe(expected);
		expect((await service.extractCompleteDocument(bytes)).pages[0]?.nativeText).toBe(expected);
		expect(bytes.equals(original)).toBe(true);
	});

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

	describe("complete extraction of a page the vision model reports as blank", () => {
		// A scanned blank back side: the page draws only a white fill, no text.
		const whitePage = () => buildPdf("", "<< >>", "1 1 1 rg 0 0 612 792 re f");
		const blankVision = {
			useModel: async () => ({ description: "[BLANK PAGE]" }),
		} as unknown as IAgentRuntime;

		it("accepts the page when OCR ran and read no text", async () => {
			const service = new PdfService(blankVision);
			const document = await service.extractCompleteDocument(whitePage(), {
				ocrPage: async () => "",
			});
			expect(document.pages.map((page) => page.method)).toEqual(["blank"]);
		});

		it("still rejects the page when no OCR ran", async () => {
			const service = new PdfService(blankVision);
			await expect(service.extractCompleteDocument(whitePage())).rejects.toThrow(
				/conflicts with native or OCR evidence/,
			);
		});

		it("still rejects the page when OCR read text", async () => {
			const service = new PdfService(blankVision);
			await expect(
				service.extractCompleteDocument(whitePage(), {
					ocrPage: async () => "Signed: A. Parent",
				}),
			).rejects.toThrow(/conflicts with native or OCR evidence/);
		});
	});
});
