/**
 * Tests the runtime-owned media resolver with a mocked local transport and no
 * backend substitution. Remote URLs remain untouched for the real SSRF layer.
 */

import { getLocalServerUrl, type IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	prepareVisionImageInput,
	VISION_IMAGE_MAX_BYTES,
} from "./image-input.js";

const HASH = "a".repeat(64);
const MEDIA_PATH = `/api/media/${HASH}.png`;

function runtimeWithFetch(fetchImpl: typeof fetch): IAgentRuntime {
	return { fetch: fetchImpl } as unknown as IAgentRuntime;
}

describe("prepareVisionImageInput", () => {
	it("loads a canonical relative media-store handle through runtime.fetch", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(Uint8Array.from([1, 2, 3]), {
					headers: { "content-type": "image/png" },
				}),
		) as unknown as typeof fetch;

		await expect(
			prepareVisionImageInput(runtimeWithFetch(fetchImpl), {
				kind: "url",
				url: MEDIA_PATH,
			}),
		).resolves.toEqual({
			kind: "bytes",
			bytes: Uint8Array.from([1, 2, 3]),
			mimeType: "image/png",
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			getLocalServerUrl(MEDIA_PATH),
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
	});

	it("loads the same canonical handle when it uses the exact local origin", async () => {
		const fetchImpl = vi.fn(
			async () => new Response(Uint8Array.from([9])),
		) as unknown as typeof fetch;

		await expect(
			prepareVisionImageInput(runtimeWithFetch(fetchImpl), {
				kind: "url",
				url: getLocalServerUrl(MEDIA_PATH),
			}),
		).resolves.toMatchObject({
			kind: "bytes",
			bytes: Uint8Array.from([9]),
		});
	});

	it("leaves public and private remote URLs for the SSRF-guarded backend", async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		const runtime = runtimeWithFetch(fetchImpl);
		for (const url of [
			"https://example.test/image.png",
			"http://127.0.0.1/private.png",
			"/tmp/local-image.png",
		]) {
			await expect(
				prepareVisionImageInput(runtime, { kind: "url", url }),
			).resolves.toEqual({ kind: "url", url });
		}
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each([
		"/api/media/not-a-content-hash.png",
		`${MEDIA_PATH}?download=1`,
		`${MEDIA_PATH}/../secret`,
	])("rejects malformed local media-store path %s", async (url) => {
		const fetchImpl = vi.fn() as unknown as typeof fetch;
		await expect(
			prepareVisionImageInput(runtimeWithFetch(fetchImpl), {
				kind: "url",
				url,
			}),
		).rejects.toThrow("local media URL is not canonical");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("rejects an oversized local response before reading its body", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(Uint8Array.from([1]), {
					headers: {
						"content-length": String(VISION_IMAGE_MAX_BYTES + 1),
					},
				}),
		) as unknown as typeof fetch;

		await expect(
			prepareVisionImageInput(runtimeWithFetch(fetchImpl), {
				kind: "url",
				url: MEDIA_PATH,
			}),
		).rejects.toThrow(`exceeds ${VISION_IMAGE_MAX_BYTES} bytes`);
	});
});
