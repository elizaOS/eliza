/**
 * Whole-document reads through the real unpdf parser. A PDF text item is a
 * font run, not a word, so these tests check that the run list is joined with
 * an empty string and that the parser's end-of-line marker is kept.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { PdfService } from "../index";

/** One page, two fonts, and the given content stream. */
function buildPdf(stream: string): Buffer {
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 7 0 R >> >> >>",
		`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
		"<< >>",
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

const FONT_RUNS = "BT /F1 12 Tf 72 720 Td (Re) Tj /F2 12 Tf (port) Tj ET";
const THREE_LINES =
	"BT /F1 12 Tf 72 720 Td (Project schedule) Tj 0 -18 Td (Monday: prepare report) Tj 0 -18 Td (Tuesday: publish report) Tj ET";

describe("PdfService whole-document text boundaries", () => {
	const vision = {
		useModel: async () => ({ description: "Project schedule transcribed." }),
	} as unknown as IAgentRuntime;

	it("keeps a word that the parser splits across two font runs", async () => {
		const service = new PdfService(vision);
		const bytes = buildPdf(FONT_RUNS);

		expect((await service.getDocumentInfo(bytes)).text).toBe("Report");
		expect(
			(await service.extractCompleteDocument(bytes)).pages[0]?.nativeText
		).toBe("Report");
	});

	it("keeps the paragraph line breaks of the parsed page", async () => {
		const service = new PdfService(vision);
		const bytes = buildPdf(THREE_LINES);
		const expected =
			"Project schedule\nMonday: prepare report\nTuesday: publish report";

		expect((await service.getDocumentInfo(bytes)).text).toBe(expected);
		expect(
			(await service.extractCompleteDocument(bytes)).pages[0]?.nativeText
		).toBe(expected);
	});
});
