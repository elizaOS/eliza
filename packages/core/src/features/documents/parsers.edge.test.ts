/**
 * Contract for the edge-target document parser stub: both entry points must
 * fail closed with a named, actionable error rather than returning empty text,
 * so a caller that reaches them on workerd gets a diagnosable failure instead of
 * a silent capability hole (#21327). Runs the real stub module; no mocks.
 */
import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";

import {
	convertPdfToTextFromBuffer,
	extractTextFromFileBuffer,
} from "./parsers.edge.ts";

describe("edge document parser stubs", () => {
	it("fails closed on DOCX extraction instead of returning empty text", async () => {
		await expect(
			extractTextFromFileBuffer(
				Buffer.from("PK"),
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				"quarterly-report.docx",
			),
		).rejects.toThrow(/unavailable on the edge runtime/i);
	});

	it("names the requested document in the DOCX failure", async () => {
		await expect(
			extractTextFromFileBuffer(
				Buffer.from("PK"),
				"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
				"quarterly-report.docx",
			),
		).rejects.toThrow(/quarterly-report\.docx/);
	});

	it("fails closed on PDF conversion instead of returning empty text", async () => {
		await expect(
			convertPdfToTextFromBuffer(Buffer.from("%PDF-1.7"), "invoice.pdf"),
		).rejects.toThrow(/unavailable on the edge runtime/i);
	});

	it("still fails closed when no filename is supplied", async () => {
		await expect(
			convertPdfToTextFromBuffer(Buffer.from("%PDF-1.7")),
		).rejects.toThrow(/unavailable on the edge runtime/i);
	});
});
