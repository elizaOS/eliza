import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";
import { MAX_PDF_BUFFER_BYTES, PdfService } from "../services/pdf";

const getDocumentProxyMock = vi.hoisted(() => vi.fn());

vi.mock("unpdf", () => ({
	getDocumentProxy: getDocumentProxyMock,
}));

interface MockPageInput {
	items: unknown[];
	width?: number;
	height?: number;
}

function makePdf(
	pages: MockPageInput[],
	info: Record<string, string | undefined> = {}
) {
	return {
		numPages: pages.length,
		getPage: vi.fn(async (pageNumber: number) => {
			const page = pages[pageNumber - 1];
			if (!page) throw new Error(`Missing page ${pageNumber}`);
			return {
				getTextContent: vi.fn(async () => ({ items: page.items })),
				getViewport: vi.fn(() => ({
					width: page.width ?? 612,
					height: page.height ?? 792,
				})),
			};
		}),
		getMetadata: vi.fn(async () => ({ info })),
	};
}

function service(): PdfService {
	return new PdfService({} as IAgentRuntime);
}

function validPdfBuffer(body = "body"): Buffer {
	return Buffer.from(`%PDF-1.7\n${body}`);
}

describe("PdfService", () => {
	beforeEach(() => {
		getDocumentProxyMock.mockReset();
	});

	it("extracts text from every page, ignores non-text items, and cleans control characters", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([
				{ items: [{ str: "Hello" }, { str: "  world\u0000" }, { notText: true }] },
				{ items: [{ str: "Second\t\tpage" }] },
			])
		);

		await expect(service().convertPdfToText(validPdfBuffer())).resolves.toBe(
			"Hello world\nSecond page"
		);
		expect(getDocumentProxyMock).toHaveBeenCalledWith(expect.any(Uint8Array));
	});

	it("honors start/end page bounds and returns page count for ranged extraction", async () => {
		const pdf = makePdf([
			{ items: [{ str: "one" }] },
			{ items: [{ str: "two" }] },
			{ items: [{ str: "three" }] },
		]);
		getDocumentProxyMock.mockResolvedValue(pdf);

		await expect(
			service().convertPdfToTextWithOptions(validPdfBuffer(), {
				startPage: 2,
				endPage: 99,
			})
		).resolves.toEqual({
			success: true,
			text: "two\nthree",
			pageCount: 3,
		});
		expect(pdf.getPage).toHaveBeenCalledTimes(2);
		expect(pdf.getPage).toHaveBeenNthCalledWith(1, 2);
		expect(pdf.getPage).toHaveBeenNthCalledWith(2, 3);
	});

	it("can preserve item whitespace and skip cleanup when requested", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([{ items: [{ str: "A  " }, { str: "\u0000B" }] }])
		);

		await expect(
			service().convertPdfToTextWithOptions(validPdfBuffer(), {
				preserveWhitespace: true,
				cleanContent: false,
			})
		).resolves.toEqual({
			success: true,
			text: "A  \u0000B",
			pageCount: 1,
		});
	});

	it("returns structured errors for option-based extraction failures", async () => {
		getDocumentProxyMock.mockRejectedValue(new Error("bad pdf"));

		await expect(service().convertPdfToTextWithOptions(validPdfBuffer("bad"))).resolves.toEqual({
			success: false,
			error: "bad pdf",
		});
	});

	it("returns metadata, dimensions, per-page text, and aggregate text", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf(
				[
					{ items: [{ str: " First  page " }], width: 100, height: 200 },
					{ items: [{ str: "Second" }, { str: " page" }], width: 300, height: 400 },
				],
				{
					Title: "Spec",
					Author: "Ada",
					Subject: "Testing",
					Keywords: "pdf,unit",
					Creator: "suite",
					Producer: "vitest",
					CreationDate: "2024-01-02T03:04:05.000Z",
					ModDate: "2024-02-03T04:05:06.000Z",
				}
			)
		);

		const info = await service().getDocumentInfo(validPdfBuffer());

		expect(info).toEqual({
			pageCount: 2,
			metadata: {
				title: "Spec",
				author: "Ada",
				subject: "Testing",
				keywords: "pdf,unit",
				creator: "suite",
				producer: "vitest",
				creationDate: new Date("2024-01-02T03:04:05.000Z"),
				modificationDate: new Date("2024-02-03T04:05:06.000Z"),
			},
			text: "First page\nSecond page",
			pages: [
				{ pageNumber: 1, width: 100, height: 200, text: "First page" },
				{ pageNumber: 2, width: 300, height: 400, text: "Second page" },
			],
		});
	});

	it("normalizes whitespace without removing newlines", () => {
		expect(service().cleanUpContent(" a\t\tb \u0000\u0007\n c  \r\n\t")).toBe(
			"a b\n c"
		);
	});

	it("rejects empty and non-PDF binary inputs before extraction", async () => {
		await expect(service().convertPdfToText(Buffer.alloc(0))).rejects.toThrow(
			"PDF input is empty"
		);
		await expect(service().convertPdfToText(Buffer.from("not a pdf"))).rejects.toThrow(
			"PDF input is not a supported PDF document"
		);
		expect(getDocumentProxyMock).not.toHaveBeenCalled();
	});

	it("rejects path, URL, data URL, and MIME wrapper payloads before extraction", async () => {
		const hostilePayloads = [
			"/tmp/report.pdf",
			"file:///etc/passwd",
			"https://example.com/report.pdf",
			"data:application/pdf;base64,JVBERi0xLjcK",
			new URL("file:///tmp/report.pdf"),
			{ contentType: "application/pdf", data: validPdfBuffer() },
			{ mimeType: "application/json", buffer: Buffer.from("{}") },
		];

		for (const payload of hostilePayloads) {
			await expect(service().convertPdfToText(payload as never)).rejects.toThrow(
				"PDF input must be a Buffer or Uint8Array"
			);
		}
		expect(getDocumentProxyMock).not.toHaveBeenCalled();
	});

	it("rejects oversized PDF inputs before extraction", async () => {
		const oversizedPdf = Buffer.concat([
			Buffer.from("%PDF-1.7\n"),
			Buffer.alloc(MAX_PDF_BUFFER_BYTES),
		]);

		await expect(service().convertPdfToText(oversizedPdf)).rejects.toThrow(
			`PDF input exceeds maximum size of ${MAX_PDF_BUFFER_BYTES} bytes`
		);
		expect(getDocumentProxyMock).not.toHaveBeenCalled();
	});

	it("returns structured validation errors for malformed option-based inputs", async () => {
		await expect(service().convertPdfToTextWithOptions(Buffer.from("data"))).resolves.toEqual({
			success: false,
			error: "PDF input is not a supported PDF document",
		});
		expect(getDocumentProxyMock).not.toHaveBeenCalled();
	});

	it("accepts PDF headers after leading transport bytes within the scan window", async () => {
		getDocumentProxyMock.mockResolvedValue(makePdf([{ items: [{ str: "offset header" }] }]));
		const prefixedPdf = Buffer.concat([Buffer.from([0, 1, 2]), validPdfBuffer()]);

		await expect(service().convertPdfToText(prefixedPdf)).resolves.toBe("offset header");
	});
});
