/**
 * SSRF coverage for the bionic IMAGE_DESCRIPTION image fetch (W5-018).
 *
 * `imageUrlToBase64` resolves caller-influenced image URLs for the on-device
 * vision describe loop on a bionic-delegated phone. URL-kind images must load
 * through the shared `fetchRemoteMedia` guard (DNS pinning, byte cap, timeout)
 * so the phone cannot be turned into an internal-network fetch oracle or an
 * unbounded memory sink. Deterministic — `fetchRemoteMedia` is mocked except
 * in the real-guard block, which asserts blocked literals never reach fetch.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const mediaMocks = vi.hoisted(() => ({
	fetchRemoteMedia: vi.fn(),
	useRealFetchRemoteMedia: false,
	realFetchRemoteMedia: null as
		| null
		| ((...args: unknown[]) => Promise<unknown>),
}));

vi.mock("@elizaos/core", async (importActual) => {
	const actual = await importActual<typeof import("@elizaos/core")>();
	mediaMocks.realFetchRemoteMedia = actual.fetchRemoteMedia as (
		...args: unknown[]
	) => Promise<unknown>;
	return {
		...actual,
		fetchRemoteMedia: (...args: unknown[]) => {
			if (
				mediaMocks.useRealFetchRemoteMedia &&
				mediaMocks.realFetchRemoteMedia
			) {
				return mediaMocks.realFetchRemoteMedia(...args);
			}
			return mediaMocks.fetchRemoteMedia(...args);
		},
	};
});

import { imageUrlToBase64 } from "./image-url-to-base64";

afterEach(() => {
	mediaMocks.useRealFetchRemoteMedia = false;
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe("imageUrlToBase64", () => {
	it("returns the base64 payload of a data URL without fetching", async () => {
		const payload = Buffer.from("hello bionic").toString("base64");
		await expect(
			imageUrlToBase64(`data:image/png;base64,${payload}`),
		).resolves.toBe(payload);
		expect(mediaMocks.fetchRemoteMedia).not.toHaveBeenCalled();
	});

	it("loads http(s) URLs through fetchRemoteMedia with the vision bounds", async () => {
		const bytes = Buffer.from([9, 8, 7, 6]);
		mediaMocks.fetchRemoteMedia.mockResolvedValue({
			buffer: bytes,
			contentType: "image/png",
			fileName: "i.png",
		});

		await expect(imageUrlToBase64("https://example.test/i.png")).resolves.toBe(
			bytes.toString("base64"),
		);
		expect(mediaMocks.fetchRemoteMedia).toHaveBeenCalledWith({
			url: "https://example.test/i.png",
			maxBytes: 20 * 1024 * 1024,
			timeoutMs: 15_000,
			maxRedirects: 5,
		});
	});

	it("wraps a guarded-fetch failure with handler context and preserves the cause", async () => {
		const cause = new Error("SSRF blocked");
		mediaMocks.fetchRemoteMedia.mockRejectedValue(cause);

		const err = await imageUrlToBase64(
			"http://169.254.169.254/latest/meta-data",
		).then(
			() => {
				throw new Error("expected imageUrlToBase64 to reject");
			},
			(caught: unknown) => caught,
		);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain(
			"[mobile-device-bridge] IMAGE_DESCRIPTION failed to fetch http://169.254.169.254/latest/meta-data: SSRF blocked",
		);
		expect((err as Error).cause).toBe(cause);
	});
});

describe("imageUrlToBase64 SSRF policy (real fetchRemoteMedia)", () => {
	it.each([
		"http://127.0.0.1/secret.png",
		"http://[::1]/secret.png",
		"http://169.254.169.254/latest/meta-data/",
		"http://localhost/internal.png",
		"http://10.0.0.5/intranet.png",
		"http://192.168.1.1/router.png",
		"http://198.18.0.1/benchmark.png",
		"file:///etc/passwd",
	])(
		"fails closed for blocked image URL %s without calling global fetch",
		async (url) => {
			mediaMocks.useRealFetchRemoteMedia = true;
			const fetchMock = vi.fn();
			vi.spyOn(globalThis, "fetch").mockImplementation(
				fetchMock as typeof fetch,
			);

			await expect(imageUrlToBase64(url)).rejects.toThrow(
				/Failed to fetch media|not allowed|blocked|private|loopback|link-local|Invalid URL|SSRF/i,
			);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);
});
