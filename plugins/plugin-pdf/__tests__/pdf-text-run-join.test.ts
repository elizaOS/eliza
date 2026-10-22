/**
 * Real unpdf output for one word that a font change splits into two text runs.
 * The parser reports `Re` and `port` as separate items, so every extraction
 * path must join the runs without inserting a space.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { PdfService } from "../index";

const SPLIT_WORD_STREAM =
	"BT /F1 12 Tf 72 720 Td (Re) Tj /F2 12 Tf (port) Tj ET";
const TWO_LINES_STREAM =
	"BT /F1 12 Tf 72 720 Td (Project schedule) Tj 0 -18 Td (Monday: prepare report) Tj ET";
const WORD_GAP_STREAM =
	"BT /F1 12 Tf 72 720 Td [(Hello) -1000 (world)] TJ ET";

function buildPdf(stream: string): Buffer {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
	];

	let body = "%PDF-1.4\n";
	const offsets: number[] = [];
	for (let index = 0; index < objects.length; index += 1) {
		offsets.push(Buffer.byteLength(body));
		body += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
	}

	const xrefStart = Buffer.byteLength(body);
	body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets) {
		body += `${String(offset).padStart(10, "0")} 00000 n \n`;
	}
	body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
	body += `startxref\n${xrefStart}\n%%EOF\n`;
	return Buffer.from(body);
}

describe("PDF text run joining", () => {
	it("keeps a word that a font change divides whole in document info", async () => {
		const service = new PdfService({} as IAgentRuntime);
		const info = await service.getDocumentInfo(buildPdf(SPLIT_WORD_STREAM));

		expect(info.text).toBe("Report");
		expect(info.pages[0].text).toBe("Report");
	});

	it("keeps a word that a font change divides whole in complete extraction", async () => {
		const vision = {
			useModel: async () => ({ description: "Report" }),
		} as unknown as IAgentRuntime;
		const service = new PdfService(vision);

		const document = await service.extractCompleteDocument(
			buildPdf(SPLIT_WORD_STREAM),
		);

		expect(document.pages[0].nativeText).toBe("Report");
		expect(document.pages[0].text.split("\n")[0]).toBe("Report");
	});

	it("still separates words and lines that the parser marks as separate", async () => {
		const service = new PdfService({} as IAgentRuntime);

		expect((await service.getDocumentInfo(buildPdf(WORD_GAP_STREAM))).text).toBe(
			"Hello world",
		);
		expect((await service.getDocumentInfo(buildPdf(TWO_LINES_STREAM))).text).toBe(
			"Project schedule Monday: prepare report",
		);
	});
});
