/**
 * Verifies the shared attachment-byte boundary rejects local-path spoofing,
 * applies one remote budget, and aborts stalled loopback reads.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const { fetchRemoteMediaMock } = vi.hoisted(() => ({
	fetchRemoteMediaMock: vi.fn(),
}));
vi.mock("./fetch.ts", async (importActual) => ({
	...(await importActual<typeof import("./fetch.ts")>()),
	fetchRemoteMedia: fetchRemoteMediaMock,
}));

import { logger } from "../logger.ts";
import type { IAgentRuntime } from "../types/runtime.ts";
import {
	ATTACHMENT_MEDIA_MAX_BYTES,
	ATTACHMENT_MEDIA_TIMEOUT_MS,
	fetchAttachmentMediaBytes,
} from "./attachment-bytes.ts";

afterEach(() => {
	vi.restoreAllMocks();
	fetchRemoteMediaMock.mockReset();
});

describe("fetchAttachmentMediaBytes", () => {
	it("rejects a userinfo-style local URL before runtime.fetch", async () => {
		const runtimeFetch = vi.fn();
		await expect(
			fetchAttachmentMediaBytes(
				{ fetch: runtimeFetch } as Pick<IAgentRuntime, "fetch">,
				"@169.254.169.254/latest/meta-data",
			),
		).rejects.toMatchObject({
			name: "MediaFetchError",
			code: "fetch_failed",
		});
		expect(runtimeFetch).not.toHaveBeenCalled();
		expect(fetchRemoteMediaMock).not.toHaveBeenCalled();
	});

	it("routes remote URLs through the SSRF guard with the canonical budget", async () => {
		fetchRemoteMediaMock.mockResolvedValue({
			buffer: Buffer.from("audio"),
			contentType: "audio/wav",
		});

		await fetchAttachmentMediaBytes(
			{} as Pick<IAgentRuntime, "fetch">,
			"https://example.test/audio.wav",
		);

		expect(fetchRemoteMediaMock).toHaveBeenCalledWith({
			url: "https://example.test/audio.wav",
			maxBytes: ATTACHMENT_MEDIA_MAX_BYTES,
			timeoutMs: ATTACHMENT_MEDIA_TIMEOUT_MS,
		});
	});

	it("normalizes an untyped remote response-read failure", async () => {
		const cause = new Error("remote body read exploded");
		fetchRemoteMediaMock.mockRejectedValue(cause);

		await expect(
			fetchAttachmentMediaBytes(
				{} as Pick<IAgentRuntime, "fetch">,
				"https://example.test/broken.wav",
			),
		).rejects.toMatchObject({
			name: "MediaFetchError",
			code: "fetch_failed",
			cause,
		});
	});

	it("preserves a typed remote failure by name across module duplication", async () => {
		const typed = Object.assign(new Error("bounded remote failure"), {
			name: "MediaFetchError",
			code: "max_bytes",
		});
		fetchRemoteMediaMock.mockRejectedValue(typed);

		await expect(
			fetchAttachmentMediaBytes(
				{} as Pick<IAgentRuntime, "fetch">,
				"https://example.test/large.wav",
			),
		).rejects.toBe(typed);
	});

	it("bounds stalled loopback fetches without awaiting rejected-body teardown", async () => {
		const controller = new AbortController();
		const timeoutSpy = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(controller.signal);
		let observedSignal: AbortSignal | null = null;
		const runtimeFetch = vi.fn(
			(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
				observedSignal = init?.signal as AbortSignal;
				return new Promise((_resolve, reject) => {
					observedSignal?.addEventListener(
						"abort",
						() => reject(observedSignal?.reason),
						{ once: true },
					);
				});
			},
		);
		const pending = fetchAttachmentMediaBytes(
			{ fetch: runtimeFetch } as Pick<IAgentRuntime, "fetch">,
			`/api/media/${"a".repeat(64)}.wav`,
		);

		await vi.waitFor(() => expect(observedSignal).toBe(controller.signal));
		controller.abort(new Error("test timeout"));

		await expect(pending).rejects.toMatchObject({
			name: "MediaFetchError",
			code: "fetch_failed",
		});
		expect(timeoutSpy).toHaveBeenCalledWith(ATTACHMENT_MEDIA_TIMEOUT_MS);

		let signalCancelStarted: (() => void) | undefined;
		const cancelStarted = new Promise<void>((resolve) => {
			signalCancelStarted = resolve;
		});
		const oversize = fetchAttachmentMediaBytes(
			{
				fetch: async () =>
					new Response(
						new ReadableStream<Uint8Array>({
							cancel() {
								signalCancelStarted?.();
								return new Promise<void>(() => undefined);
							},
						}),
						{
							headers: {
								"content-length": String(ATTACHMENT_MEDIA_MAX_BYTES + 1),
							},
						},
					),
			} as Pick<IAgentRuntime, "fetch">,
			`/api/media/${"b".repeat(64)}.wav`,
		);
		let outcome: unknown;
		void oversize.then(
			() => {
				outcome = new Error("oversize fetch unexpectedly succeeded");
			},
			(error) => {
				outcome = error;
			},
		);
		await cancelStarted;
		await vi.waitFor(() =>
			expect(outcome).toMatchObject({
				name: "MediaFetchError",
				code: "max_bytes",
			}),
		);

		const cancelError = new Error("late cancellation rejection");
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
		try {
			await expect(
				fetchAttachmentMediaBytes(
					{
						fetch: async () =>
							new Response(
								new ReadableStream<Uint8Array>({
									cancel: () => Promise.reject(cancelError),
								}),
								{
									headers: {
										"content-length": String(ATTACHMENT_MEDIA_MAX_BYTES + 1),
									},
								},
							),
					} as Pick<IAgentRuntime, "fetch">,
					`/api/media/${"c".repeat(64)}.wav`,
				),
			).rejects.toMatchObject({ code: "max_bytes" });
			await vi.waitFor(() =>
				expect(warn).toHaveBeenCalledWith(
					expect.objectContaining({ err: cancelError }),
					"[MediaFetch] Failed to cancel rejected media stream",
				),
			);
		} finally {
			warn.mockRestore();
		}
	});
});
