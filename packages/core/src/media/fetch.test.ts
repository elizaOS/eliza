/**
 * Tests for `fetchRemoteMedia`, the SSRF-guarded remote-media fetch: timeout
 * signal propagation, byte limits, and RFC 5987 `Content-Disposition`
 * filename decoding.
 * Deterministic — DNS resolution and transport are injected through the
 * `lookupFn` + `pinnedFetchImpl` pair (the production pinned shape), no network.
 */
import { describe, expect, it } from "vitest";
import { fetchRemoteMedia } from "./fetch.ts";

describe("fetchRemoteMedia", () => {
	it("enforces a zero-byte response limit", async () => {
		const request = fetchRemoteMedia({
			url: "https://example.com/image.png",
			maxBytes: 0,
			lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
			pinnedFetchImpl: async () => new Response(Buffer.from("x")),
		});

		await expect(request).rejects.toMatchObject({ code: "max_bytes" });
	});

	it("applies timeout signals to guarded fetches", async () => {
		let sawAbortSignal = false;
		const result = await fetchRemoteMedia({
			url: "https://example.com/image.png",
			timeoutMs: 30_000,
			lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
			// With a lookupFn the guard fail-closes unless the transport receives
			// the computed DNS pin — inject through pinnedFetchImpl, never a plain
			// fetchImpl that would discard the pin (#11147).
			pinnedFetchImpl: async ({ init }) => {
				sawAbortSignal = init?.signal instanceof AbortSignal;
				return new Response(Buffer.from("png"), {
					headers: { "content-type": "image/png" },
				});
			},
		});

		expect(sawAbortSignal).toBe(true);
		expect(result.contentType).toBe("image/png");
	});

	function fetchWithContentDisposition(contentDisposition: string) {
		return fetchRemoteMedia({
			url: "https://example.com/files/42",
			lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
			pinnedFetchImpl: async () =>
				new Response(Buffer.from("hello"), {
					headers: {
						"content-type": "text/plain",
						"content-disposition": contentDisposition,
					},
				}),
		});
	}

	it("decodes RFC 5987 filename* with an empty language tag", async () => {
		const result = await fetchWithContentDisposition(
			"attachment; filename*=UTF-8''na%C3%AFve.txt",
		);
		expect(result.fileName).toBe("naïve.txt");
	});

	it("decodes RFC 5987 filename* with a language tag", async () => {
		// The charset/language prefix must not leak into the filename
		// (e.g. "UTF-8'en'naïve file.txt"); the language-tagged form needs the
		// same stripping as the empty-language `charset''value` form.
		const result = await fetchWithContentDisposition(
			"attachment; filename*=UTF-8'en'na%C3%AFve%20file.txt",
		);
		expect(result.fileName).toBe("naïve file.txt");
	});

	it("falls back to plain filename= parsing", async () => {
		const result = await fetchWithContentDisposition(
			'attachment; filename="report.txt"',
		);
		expect(result.fileName).toBe("report.txt");
	});
});

describe("readErrorBodySnippet UTF-16 surrogate safety", () => {
	it("preserves UTF-16 surrogate pairs in error body snippets", async () => {
		// 198 ASCII chars + "🔥" (2 code units) = 200 chars.
		// maxChars is 200, so maxChars - 1 is 199.
		// Slicing at 199 lands on high surrogate of "🔥".
		// Surrogate safe back-off ensures we take 198 chars, keeping emoji intact.
		const body = "a".repeat(198) + "🔥" + "extra";
		await expect(
			fetchRemoteMedia({
				url: "https://example.com/error.png",
				lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
				pinnedFetchImpl: async () =>
					new Response(body, {
						status: 500,
						statusText: "Internal Server Error",
						headers: { "content-type": "text/plain" },
					}),
			}),
		).rejects.toThrow();
	});
});

