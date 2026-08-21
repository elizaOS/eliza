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

	it("cancels a declared-oversize body before clearing the request deadline", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array([1]));
			},
			cancel() {
				cancelled = true;
			},
		});

		await expect(
			fetchRemoteMedia({
				url: "https://example.com/declared-bomb.png",
				maxBytes: 1,
				lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
				pinnedFetchImpl: async () =>
					new Response(body, {
						headers: { "content-length": "2" },
					}),
			}),
		).rejects.toMatchObject({ code: "max_bytes" });
		expect(cancelled).toBe(true);
	});

	it("bounds and cancels diagnostic bodies on HTTP errors", async () => {
		let cancelled = false;
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(new Uint8Array(128));
			},
			cancel() {
				cancelled = true;
			},
		});

		await expect(
			fetchRemoteMedia({
				url: "https://example.com/error",
				maxBytes: 1,
				lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
				pinnedFetchImpl: async () => new Response(body, { status: 500 }),
			}),
		).rejects.toMatchObject({ code: "http_error" });
		expect(cancelled).toBe(true);
		expect(pulls).toBeLessThanOrEqual(3);
	});

	it("rejects response metadata before consuming the body", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});

		await expect(
			fetchRemoteMedia({
				url: "https://example.com/avatar.png",
				requiredContentTypePrefix: "image/",
				rejectContentEncoding: true,
				lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
				pinnedFetchImpl: async () =>
					new Response(body, {
						headers: {
							"content-encoding": "gzip",
							"content-type": "image/png",
						},
					}),
			}),
		).rejects.toMatchObject({ code: "invalid_response" });
		expect(cancelled).toBe(true);
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

	it("keeps surrogate pairs intact in diagnostic error snippets", async () => {
		const { readErrorBodySnippet } = await import("./fetch.ts");
		const emojiBody = `${"a".repeat(50)}🦊${"b".repeat(50)}`;
		const res = new Response(emojiBody);
		const snippet = await readErrorBodySnippet(res, 200);
		expect(snippet).toBeDefined();
		expect(snippet?.isWellFormed()).toBe(true);
		expect(snippet?.length).toBeLessThanOrEqual(200);
	});

	it("sanitizes lone surrogates in diagnostic error bodies", async () => {
		const { readErrorBodySnippet } = await import("./fetch.ts");
		const lone = `bad ${String.fromCharCode(0xd800)} body`;
		const res = new Response(lone);
		const snippet = await readErrorBodySnippet(res, 200);
		expect(snippet).toBe("bad \uFFFD body");
		expect(snippet?.isWellFormed()).toBe(true);
	});

	it("preserves a fitting emoji without truncation", async () => {
		const { readErrorBodySnippet } = await import("./fetch.ts");
		const body = `${"a".repeat(50)}🦊`;
		const res = new Response(body);
		const snippet = await readErrorBodySnippet(res, 200);
		expect(snippet).toBe(body);
		expect(snippet?.isWellFormed()).toBe(true);
	});

	it("never splits surrogate at the 200-char budget via well-formed helper", async () => {
		const { truncateWellFormed, toWellFormedUnicode } = await import(
			"../utils/well-formed.ts"
		);
		const text = `${"a".repeat(199)}🦊tail`;
		const wellFormed = toWellFormedUnicode(text);
		const budget = 199;
		const truncated = `${truncateWellFormed(wellFormed, budget).trimEnd()}…`;
		expect(truncated.isWellFormed()).toBe(true);
		expect(truncated.length).toBeLessThanOrEqual(200);
	});
});
