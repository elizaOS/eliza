/**
 * Tests for `fetchRemoteMedia`, the SSRF-guarded remote-media fetch: timeout
 * signal propagation, bounded error-body reads, and RFC 5987
 * `Content-Disposition` filename decoding.
 * Deterministic — DNS resolution and transport are injected through the
 * `lookupFn` + `pinnedFetchImpl` pair (the production pinned shape), no network.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchRemoteMedia, readResponseWithLimit } from "./fetch.ts";

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

	it("aborts a remote transport that stalls past its timeout", async () => {
		let aborted = false;
		await expect(
			fetchRemoteMedia({
				url: "https://example.com/stalled.wav",
				timeoutMs: 5,
				lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
				pinnedFetchImpl: async ({ init }) =>
					new Promise<Response>((_resolve, reject) => {
						const signal = init?.signal;
						signal?.addEventListener(
							"abort",
							() => {
								aborted = true;
								reject(signal.reason);
							},
							{ once: true },
						);
					}),
			}),
		).rejects.toMatchObject({
			name: "MediaFetchError",
			code: "fetch_failed",
		});
		expect(aborted).toBe(true);
	});

	it("normalizes a DNS-pinned response stream failure as MediaFetchError", async () => {
		const body = new ReadableStream<Uint8Array>({
			pull() {
				throw new Error("response stream failed after headers");
			},
		});

		await expect(
			fetchRemoteMedia({
				url: "https://example.com/broken.wav",
				maxBytes: 1024,
				timeoutMs: 30_000,
				lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
				pinnedFetchImpl: async () => new Response(body),
			}),
		).rejects.toMatchObject({
			name: "MediaFetchError",
			code: "fetch_failed",
			message: "Failed to read fetched media response",
		});
	});

	it("throws byte-limit failures without awaiting hostile cancellation", async () => {
		let signalReaderCancelStarted: (() => void) | undefined;
		const readerCancelStarted = new Promise<void>((resolve) => {
			signalReaderCancelStarted = resolve;
		});
		const boundedRead = readResponseWithLimit(
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(1025));
					},
					cancel() {
						signalReaderCancelStarted?.();
						return new Promise<void>(() => undefined);
					},
				}),
			),
			1024,
		);
		let boundedReadOutcome: unknown;
		void boundedRead.then(
			() => {
				boundedReadOutcome = new Error("bounded read unexpectedly succeeded");
			},
			(error) => {
				boundedReadOutcome = error;
			},
		);
		await readerCancelStarted;
		await vi.waitFor(() =>
			expect(boundedReadOutcome).toMatchObject({
				name: "MediaFetchError",
				code: "max_bytes",
			}),
		);

		let signalHeaderCancelStarted: (() => void) | undefined;
		const headerCancelStarted = new Promise<void>((resolve) => {
			signalHeaderCancelStarted = resolve;
		});
		const declaredOversize = fetchRemoteMedia({
			url: "https://example.com/declared-oversize.wav",
			maxBytes: 1024,
			lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
			pinnedFetchImpl: async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel() {
							signalHeaderCancelStarted?.();
							return new Promise<void>(() => undefined);
						},
					}),
					{ headers: { "content-length": "1025" } },
				),
		});
		let declaredOutcome: unknown;
		void declaredOversize.then(
			() => {
				declaredOutcome = new Error(
					"declared oversize fetch unexpectedly succeeded",
				);
			},
			(error) => {
				declaredOutcome = error;
			},
		);
		await headerCancelStarted;
		await vi.waitFor(() =>
			expect(declaredOutcome).toMatchObject({
				name: "MediaFetchError",
				code: "max_bytes",
			}),
		);

		// HTTP diagnostics use the same bounded reader but translate its overflow
		// back to the authoritative status failure after cancelling the body.
		const chunk = new Uint8Array(1024);
		let pulls = 0;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				if (pulls > 4096) {
					controller.close();
					return;
				}
				controller.enqueue(chunk);
			},
			cancel() {
				cancelled = true;
			},
		});

		await expect(
			fetchRemoteMedia({
				url: "https://example.com/unavailable-audio",
				maxBytes: 1024,
				lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
				pinnedFetchImpl: async () =>
					new Response(body, {
						status: 503,
						statusText: "Service Unavailable",
					}),
			}),
		).rejects.toMatchObject({ name: "MediaFetchError", code: "http_error" });
		expect(cancelled).toBe(true);
		// The response offered 4096 chunks, but the bounded reader stopped on the
		// second (plus at most one stream prefetch) instead of materializing 4 MiB.
		expect(pulls).toBeLessThanOrEqual(3);
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
