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

	it("rejects a declared oversized error body before reading it", async () => {
		let cancelled = false;
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(new Uint8Array(1024));
			},
			cancel() {
				cancelled = true;
			},
		});

		await expect(
			fetchRemoteMedia({
				url: "https://example.com/oversized-error",
				maxBytes: 10,
				lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
				pinnedFetchImpl: async () =>
					new Response(body, {
						status: 503,
						headers: { "content-length": "1024" },
					}),
			}),
		).rejects.toMatchObject({ code: "max_bytes" });

		// Construction may satisfy one stream pull, but the status diagnostic must
		// never acquire a reader after the declared length already violates policy.
		expect(pulls).toBeLessThanOrEqual(1);
		expect(cancelled).toBe(true);
	});

	it("cancels a chunked hostile error body as soon as the cap is crossed", async () => {
		let cancelled = false;
		let pulls = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				controller.enqueue(new Uint8Array(1024));
				if (pulls === 101) controller.close();
			},
			cancel() {
				cancelled = true;
			},
		});

		await expect(
			fetchRemoteMedia({
				url: "https://example.com/chunked-error",
				maxBytes: 10,
				lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
				pinnedFetchImpl: async () => new Response(body, { status: 503 }),
			}),
		).rejects.toMatchObject({ code: "http_error" });

		expect(cancelled).toBe(true);
		expect(pulls).toBeLessThanOrEqual(2);
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
