/**
 * Tests PdfService parsing and validation with deterministic unpdf boundary mocks.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";
import {
	MAX_PDF_BUFFER_BYTES,
	MAX_PDF_PAGES,
	PdfService,
} from "../services/pdf";

const getDocumentProxyMock = vi.hoisted(() => vi.fn());

vi.mock("unpdf", () => ({
	getDocumentProxy: getDocumentProxyMock,
}));

interface MockPageInput {
	items: unknown;
	width?: number;
	height?: number;
}

function makeDeclaredPdf(numPages: number) {
	return {
		numPages,
		getPage: vi.fn(async () => ({
			getTextContent: vi.fn(async () => ({ items: [{ str: "p" }] })),
			getViewport: vi.fn(() => ({ width: 612, height: 792 })),
		})),
		getMetadata: vi.fn(async () => ({ info: {} })),
	};
}

function makePdf(
	pages: MockPageInput[],
	info: Record<string, unknown> | null | undefined = {}
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
		const parserInput = getDocumentProxyMock.mock.calls[0]?.[0];
		expect(parserInput).toBeInstanceOf(Uint8Array);
		expect(Buffer.isBuffer(parserInput)).toBe(false);
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

	it("rejects a range that begins entirely past the document instead of clamping to the last page", async () => {
		const pdf = makePdf([
			{ items: [{ str: "one" }] },
			{ items: [{ str: "two" }] },
			{ items: [{ str: "three" }] },
		]);
		getDocumentProxyMock.mockResolvedValue(pdf);

		const result = await service().convertPdfToTextWithOptions(validPdfBuffer(), {
			startPage: 5,
			endPage: 10,
		});

		expect(result.success).toBe(false);
		expect(result.text).toBeUndefined();
		expect(result.error).toBe("startPage 5 exceeds document page count 3");
		expect(pdf.getPage).not.toHaveBeenCalled();
	});

	it("names startPage as the cause when startPage exceeds page count and no endPage is supplied", async () => {
		const pdf = makePdf([
			{ items: [{ str: "one" }] },
			{ items: [{ str: "two" }] },
			{ items: [{ str: "three" }] },
		]);
		getDocumentProxyMock.mockResolvedValue(pdf);

		const result = await service().convertPdfToTextWithOptions(validPdfBuffer(), {
			startPage: 5,
		});

		expect(result.success).toBe(false);
		expect(result.error).toBe("startPage 5 exceeds document page count 3");
		expect(result.error).not.toContain("endPage");
		expect(pdf.getPage).not.toHaveBeenCalled();
	});

	it("still clamps an oversized endPage down to the last page for an in-range startPage", async () => {
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
		).resolves.toEqual({ success: true, text: "two\nthree", pageCount: 3 });
	});

	it("accepts an in-range start/end page range unchanged", async () => {
		const pdf = makePdf([
			{ items: [{ str: "one" }] },
			{ items: [{ str: "two" }] },
			{ items: [{ str: "three" }] },
		]);
		getDocumentProxyMock.mockResolvedValue(pdf);

		await expect(
			service().convertPdfToTextWithOptions(validPdfBuffer(), {
				startPage: 2,
				endPage: 3,
			})
		).resolves.toEqual({ success: true, text: "two\nthree", pageCount: 3 });
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

	it("rejects a declared page count above the page budget before getPage", async () => {
		const pdf = makeDeclaredPdf(MAX_PDF_PAGES + 1);
		getDocumentProxyMock.mockResolvedValue(pdf);

		await expect(service().convertPdfToText(validPdfBuffer())).rejects.toThrow(
			`PDF page count exceeds maximum of ${MAX_PDF_PAGES} pages`,
		);
		await expect(
			service().convertPdfToTextWithOptions(validPdfBuffer()),
		).resolves.toEqual({
			success: false,
			error: `PDF page count exceeds maximum of ${MAX_PDF_PAGES} pages`,
		});
		await expect(service().getDocumentInfo(validPdfBuffer())).rejects.toThrow(
			`PDF page count exceeds maximum of ${MAX_PDF_PAGES} pages`,
		);
		expect(pdf.getPage).not.toHaveBeenCalled();
	});

	it("extracts a last-fit document at the page budget", async () => {
		const pdf = makeDeclaredPdf(MAX_PDF_PAGES);
		getDocumentProxyMock.mockResolvedValue(pdf);

		await expect(service().convertPdfToText(validPdfBuffer())).resolves.toBe(
			Array.from({ length: MAX_PDF_PAGES }, () => "p").join("\n"),
		);
		expect(pdf.getPage).toHaveBeenCalledTimes(MAX_PDF_PAGES);
	});

	it.each([
		Number.POSITIVE_INFINITY,
		1e20,
		0,
		-1,
		1.5,
		Number.NaN,
	])("rejects a hostile declared page count before getPage: %s", async (numPages) => {
		const pdf = makeDeclaredPdf(1);
		pdf.numPages = numPages as number;
		getDocumentProxyMock.mockResolvedValue(pdf);

		await expect(service().convertPdfToText(validPdfBuffer())).rejects.toThrow(
			"PDF page count must be a positive safe integer",
		);
		expect(pdf.getPage).not.toHaveBeenCalled();
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

	it.each([
		[{ startPage: 0 }, "startPage must be a positive finite integer"],
		[{ startPage: 1.5 }, "startPage must be a positive finite integer"],
		[{ startPage: Number.NaN }, "startPage must be a positive finite integer"],
		[{ endPage: Number.POSITIVE_INFINITY }, "endPage must be a positive finite integer"],
	])("returns structured errors for hostile extraction options %#", async (options, error) => {
		getDocumentProxyMock.mockResolvedValue(makePdf([{ items: [{ str: "one" }] }]));

		await expect(
			service().convertPdfToTextWithOptions(validPdfBuffer(), options)
		).resolves.toEqual({
			success: false,
			error,
		});
	});

	it("rejects an in-range startPage with an explicit endPage below it", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([
				{ items: [{ str: "one" }] },
				{ items: [{ str: "two" }] },
				{ items: [{ str: "three" }] },
			])
		);

		await expect(
			service().convertPdfToTextWithOptions(validPdfBuffer(), { startPage: 3, endPage: 2 })
		).resolves.toEqual({
			success: false,
			error: "endPage must be greater than or equal to startPage",
		});
	});

	it("omits invalid metadata dates instead of returning Invalid Date objects", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([{ items: [{ str: "content" }] }], {
				CreationDate: "not-a-date",
				ModDate: "2024-02-03T04:05:06.000Z",
			})
		);

		const info = await service().getDocumentInfo(validPdfBuffer());

		expect(info.metadata.creationDate).toBeUndefined();
		expect(info.metadata.modificationDate).toEqual(new Date("2024-02-03T04:05:06.000Z"));
	});

	it("accepts PDF headers after leading transport bytes within the scan window", async () => {
		getDocumentProxyMock.mockResolvedValue(makePdf([{ items: [{ str: "offset header" }] }]));
		const prefixedPdf = Buffer.concat([Buffer.from([0, 1, 2]), validPdfBuffer()]);

		await expect(service().convertPdfToText(prefixedPdf)).resolves.toBe("offset header");
	});

	it("handles missing or null metadata info objects without throwing", async () => {
		getDocumentProxyMock.mockResolvedValue({
			numPages: 1,
			getPage: vi.fn(async () => ({
				getTextContent: vi.fn(async () => ({ items: [{ str: "hello" }] })),
				getViewport: vi.fn(() => ({ width: 100, height: 200 })),
			})),
			getMetadata: vi.fn(async () => ({ info: undefined })),
		});

		const info = await service().getDocumentInfo(validPdfBuffer());
		expect(info.pageCount).toBe(1);
		expect(info.metadata.title).toBeUndefined();
		expect(info.metadata.creationDate).toBeUndefined();
	});

	it("omits null metadata creationDate instead of returning epoch 1970 date", async () => {
		getDocumentProxyMock.mockResolvedValue({
			numPages: 1,
			getPage: vi.fn(async () => ({
				getTextContent: vi.fn(async () => ({ items: [{ str: "hello" }] })),
				getViewport: vi.fn(() => ({ width: 100, height: 200 })),
			})),
			getMetadata: vi.fn(async () => ({
				info: { CreationDate: null as unknown as string, Title: 123 as unknown as string },
			})),
		});

		const info = await service().getDocumentInfo(validPdfBuffer());
		expect(info.metadata.creationDate).toBeUndefined();
		expect(info.metadata.title).toBeUndefined();
	});

	it("omits non-string metadata dates instead of coercing fabricated epochs", async () => {
		getDocumentProxyMock.mockResolvedValue(
			makePdf([{ items: [{ str: "hello" }] }], {
				CreationDate: 0,
				ModDate: false,
				Title: 123,
				Author: { name: "Ada" },
			})
		);

		const info = await service().getDocumentInfo(validPdfBuffer());
		expect(info.metadata).toEqual({
			title: undefined,
			author: undefined,
			subject: undefined,
			keywords: undefined,
			creator: undefined,
			producer: undefined,
			creationDate: undefined,
			modificationDate: undefined,
		});
	});

	it("accepts finite Date metadata objects and omits invalid Date objects", async () => {
		const creationDate = new Date("2024-03-04T05:06:07.000Z");
		getDocumentProxyMock.mockResolvedValue(
			makePdf([{ items: [{ str: "hello" }] }], {
				CreationDate: creationDate,
				ModDate: new Date(Number.NaN),
			})
		);

		const info = await service().getDocumentInfo(validPdfBuffer());
		expect(info.metadata.creationDate).toBe(creationDate);
		expect(info.metadata.modificationDate).toBeUndefined();
	});

	it.each([null, undefined, {}, "not-an-array", 42])(
		"fails explicitly when unpdf returns non-array text items: %j",
		async (items) => {
			getDocumentProxyMock.mockResolvedValue(makePdf([{ items }]));
			await expect(service().convertPdfToText(validPdfBuffer())).rejects.toThrow(
				"PDF text content items must be an array"
			);

			getDocumentProxyMock.mockResolvedValue(makePdf([{ items }]));
			await expect(
				service().convertPdfToTextWithOptions(validPdfBuffer())
			).resolves.toEqual({
				success: false,
				error: "PDF text content items must be an array",
			});

			getDocumentProxyMock.mockResolvedValue(makePdf([{ items }]));
			await expect(service().getDocumentInfo(validPdfBuffer())).rejects.toThrow(
				"PDF text content items must be an array"
			);
		}
	);

	it("fails cleanup on malformed caller input instead of returning uncleaned content", () => {
		expect(() => service().cleanUpContent(null as never)).toThrow();
	});
});
