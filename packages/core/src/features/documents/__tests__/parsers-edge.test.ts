import { describe, expect, it } from "vitest";
import {
	convertPdfToTextFromBuffer,
	extractTextFromFileBuffer,
} from "./parsers.edge.ts";

describe("edge parsers (fail-closed)", () => {
	it("extractTextFromFileBuffer throws with context", async () => {
		await expect(
			extractTextFromFileBuffer(Buffer.alloc(0), "application/pdf", "doc.pdf"),
		).rejects.toThrow(/unavailable on the edge runtime/i);
		await expect(
			extractTextFromFileBuffer(Buffer.alloc(0), "text/plain", "note.txt"),
		).rejects.toThrow(/text\/plain/);
	});

	it("convertPdfToTextFromBuffer throws with filename", async () => {
		await expect(
			convertPdfToTextFromBuffer(Buffer.alloc(0), "report.pdf"),
		).rejects.toThrow(/unavailable on the edge runtime/i);
		await expect(
			convertPdfToTextFromBuffer(Buffer.alloc(0), "report.pdf"),
		).rejects.toThrow(/report\.pdf/);
	});

	it("convertPdfToTextFromBuffer works without a filename", async () => {
		await expect(convertPdfToTextFromBuffer(Buffer.alloc(0))).rejects.toThrow(
			/unavailable on the edge runtime/i,
		);
	});
});
