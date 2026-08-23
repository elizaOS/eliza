/**
 * Unit tests for SSRF-safe URL document ingestion and content classification.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	__setDocumentUrlFetchImplForTests,
	fetchDocumentFromUrl,
	isYouTubeUrl,
} from "./url-ingest.js";

describe("url-ingest", () => {
	beforeEach(() => {
		__setDocumentUrlFetchImplForTests(null);
	});

	afterEach(() => {
		__setDocumentUrlFetchImplForTests(null);
	});

	it("identifies youtube URL patterns", () => {
		expect(isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
			true,
		);
		expect(isYouTubeUrl("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
		expect(isYouTubeUrl("https://example.com/video")).toBe(false);
	});

	it("rejects invalid URL formats and unsafe local protocols", async () => {
		await expect(fetchDocumentFromUrl("invalid-url")).rejects.toThrow(
			"Invalid URL format",
		);
		await expect(
			fetchDocumentFromUrl("ftp://example.com/file"),
		).rejects.toThrow("Only http:// and https:// URLs are allowed");
		await expect(
			fetchDocumentFromUrl("http://localhost:3000/api"),
		).rejects.toThrow(/blocked for security reasons/);
	});

	it("fetches and parses HTML content to plain text using mock fetch", async () => {
		__setDocumentUrlFetchImplForTests(async () => {
			const html =
				"<html><body><h1>Doc Title</h1><p>First paragraph.</p><p>Second paragraph.</p></body></html>";
			return new Response(html, {
				status: 200,
				headers: { "Content-Type": "text/html; charset=utf-8" },
			});
		});

		const result = await fetchDocumentFromUrl("https://8.8.8.8/article.html");

		expect(result.contentType).toBe("html");
		expect(result.filename).toBe("article.html");
		expect(result.content).toContain("Doc Title");
		expect(result.content).toContain("First paragraph.");
		expect(result.content).toContain("Second paragraph.");
	});

	it("fetches binary documents as base64", async () => {
		const binaryData = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
		__setDocumentUrlFetchImplForTests(async () => {
			return new Response(binaryData, {
				status: 200,
				headers: { "Content-Type": "application/pdf" },
			});
		});

		const result = await fetchDocumentFromUrl("https://8.8.8.8/manual.pdf");

		expect(result.contentType).toBe("binary");
		expect(result.filename).toBe("manual.pdf");
		expect(result.mimeType).toBe("application/pdf");
		expect(result.content).toBe(Buffer.from(binaryData).toString("base64"));
	});

	it("rejects redirects and non-200 responses", async () => {
		__setDocumentUrlFetchImplForTests(async () => {
			return new Response(null, {
				status: 301,
				headers: { Location: "https://other.com" },
			});
		});

		await expect(
			fetchDocumentFromUrl("https://8.8.8.8/redirect"),
		).rejects.toThrow("URL redirects are not allowed");
	});

	it.each([
		"https://youtube.com/embed/dQw4w9WgXcQ",
		"http://youtube.com/v/dQw4w9WgXcQ",
	])("recognizes additional supported YouTube URL forms", (url) => {
		expect(isYouTubeUrl(url)).toBe(true);
	});

	it.each([
		["http://127.0.0.1/secret", 'URL host "127.0.0.1" is blocked'],
		[
			"http://metadata.google.internal/latest/meta-data",
			'URL host "metadata.google.internal" is blocked',
		],
	])("blocks unsafe host %s before pinned fetch", async (url, message) => {
		let fetchCalled = false;
		__setDocumentUrlFetchImplForTests(async () => {
			fetchCalled = true;
			return new Response("unused");
		});

		await expect(fetchDocumentFromUrl(url)).rejects.toThrow(message);
		expect(fetchCalled).toBe(false);
	});

	it("pins public literal addresses and translates aborts into timeout errors", async () => {
		__setDocumentUrlFetchImplForTests(async (input) => {
			expect(input.target.hostname).toBe("8.8.8.8");
			expect(input.target.pinnedAddress).toBe("8.8.8.8");
			expect(input.timeoutMs).toBe(15_000);
			throw new DOMException("Aborted", "AbortError");
		});

		await expect(fetchDocumentFromUrl("https://8.8.8.8/doc")).rejects.toThrow(
			"URL fetch timed out after 15000ms",
		);
	});

	it("reports unsuccessful HTTP responses with status details", async () => {
		__setDocumentUrlFetchImplForTests(
			async () => new Response("missing", { status: 404, statusText: "Not Found" }),
		);

		await expect(fetchDocumentFromUrl("https://8.8.8.8/missing")).rejects.toThrow(
			"Failed to fetch URL: 404 Not Found",
		);
	});

	it.each([
		["https://8.8.8.8/", "document"],
		["https://8.8.8.8/a%20note.txt", "a note.txt"],
		["https://8.8.8.8/bad%ZZ.txt", "bad%ZZ.txt"],
	])("derives the filename for %s", async (url, filename) => {
		__setDocumentUrlFetchImplForTests(
			async () =>
				new Response("text", {
					headers: { "Content-Type": "text/plain; charset=utf-8" },
				}),
		);

		await expect(fetchDocumentFromUrl(url)).resolves.toMatchObject({ filename });
	});

	it("removes raw-text HTML elements and decodes basic entities", async () => {
		__setDocumentUrlFetchImplForTests(
			async () =>
				new Response(
					"<h1>Title &amp; More</h1><script>secret()</script><style>.hidden{}</style><p>Hello<br>world</p>",
					{ headers: { "Content-Type": "text/html" } },
				),
		);

		const result = await fetchDocumentFromUrl("https://8.8.8.8/page.html");

		expect(result.content).toBe("Title & More\n Hello\nworld");
		expect(result.content).not.toContain("secret");
		expect(result.content).not.toContain("hidden");
	});

	it.each([
		"application/msword",
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		"image/png",
	])("classifies %s payloads as binary", async (mimeType) => {
		__setDocumentUrlFetchImplForTests(
			async () =>
				new Response(new Uint8Array([0, 1, 2, 255]), {
					headers: { "Content-Type": mimeType },
				}),
		);

		await expect(fetchDocumentFromUrl("https://8.8.8.8/file.bin")).resolves.toMatchObject({
			content: "AAEC/w==",
			contentType: "binary",
			mimeType,
		});
	});

	it("defaults missing content types to octet-stream text", async () => {
		__setDocumentUrlFetchImplForTests(
			async () => new Response(new TextEncoder().encode("raw text")),
		);

		await expect(fetchDocumentFromUrl("https://8.8.8.8/raw")).resolves.toEqual({
			filename: "raw",
			content: "raw text",
			contentType: "text",
			mimeType: "application/octet-stream",
		});
	});

	it("rejects declared bodies larger than the import limit", async () => {
		const maximumBytes = 10 * 1024 * 1024;
		__setDocumentUrlFetchImplForTests(
			async () =>
				new Response("small", {
					headers: { "Content-Length": String(maximumBytes + 1) },
				}),
		);

		await expect(fetchDocumentFromUrl("https://8.8.8.8/large.txt")).rejects.toThrow(
			`URL content exceeds maximum size of ${maximumBytes} bytes`,
		);
	});

	it("rejects YouTube URLs without an eleven-character video id", async () => {
		await expect(fetchDocumentFromUrl("https://youtu.be/short")).rejects.toThrow(
			"Invalid YouTube URL: could not extract video ID",
		);
	});
});
