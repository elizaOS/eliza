/**
 * Tests for `fetchRemoteMedia`, the SSRF-guarded remote-media fetch: timeout
 * signal propagation and RFC 5987 `Content-Disposition` filename decoding.
 * Deterministic — DNS resolution and transport are injected through the
 * `lookupFn` + `pinnedFetchImpl` pair (the production pinned shape), no network.
 */
import { describe, expect, it } from "vitest";
import { fetchRemoteMedia } from "./fetch.ts";

describe("fetchRemoteMedia", () => {
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

	describe("maxBytes: 0 hard zero-byte cap", () => {
		function fetchWithMaxBytes(maxBytes: number, body: string) {
			return fetchRemoteMedia({
				url: "https://example.com/image.png",
				maxBytes,
				lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
				pinnedFetchImpl: async () => new Response(Buffer.from(body)),
			});
		}

		it("rejects a non-empty body under maxBytes: 0 instead of reading unbounded", async () => {
			// A truthiness check on maxBytes used to fold 0 into "no cap",
			// giving callers relying on the documented hard-cap contract an
			// unbounded read under a zero-byte policy (#19854).
			await expect(fetchWithMaxBytes(0, "x")).rejects.toMatchObject({
				code: "max_bytes",
			});
		});

		it("admits an empty body under maxBytes: 0", async () => {
			// 0 is a cap, not a blanket rejection: zero delivered bytes comply.
			const result = await fetchWithMaxBytes(0, "");
			expect(result.buffer.length).toBe(0);
		});

		it("still reads unbounded when maxBytes is omitted", async () => {
			const result = await fetchRemoteMedia({
				url: "https://example.com/image.png",
				lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
				pinnedFetchImpl: async () =>
					new Response(Buffer.from("png"), {
						headers: { "content-type": "image/png" },
					}),
			});
			expect(result.buffer.toString()).toBe("png");
		});
	});
