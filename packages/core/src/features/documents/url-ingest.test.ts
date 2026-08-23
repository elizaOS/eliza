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
});
