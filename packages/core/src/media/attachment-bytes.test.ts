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

	it("aborts a stalled canonical loopback fetch after the shared timeout", async () => {
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
	});
});
