/**
 * Behavioral content-pack manifest deadline. Executes
 * getContentPackManifestJsonWithFetch under abort — not a source-grep.
 * Not #21385. Not Twilio. Not payment.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/shared", () => ({
	CONTENT_PACK_MANIFEST_FILENAME: "pack.json",
	validateContentPackManifest: () => [],
}));

import {
	CONTENT_PACK_MANIFEST_FETCH_TIMEOUT_MS,
	getContentPackManifestJsonWithFetch,
} from "./load-pack";

const URL = "https://example.com/packs/cyberpunk-neon/pack.json";

function stallUntilAborted(): typeof fetch {
	return ((_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("expected content-pack abort signal");
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		})) as typeof fetch;
}

describe("load-pack manifest deadline", () => {
	it("keeps a documented UI fetch budget", () => {
		expect(CONTENT_PACK_MANIFEST_FETCH_TIMEOUT_MS).toBe(15_000);
	});

	it("aborts a stalled manifest GET at the injected deadline", async () => {
		await expect(
			getContentPackManifestJsonWithFetch(URL, stallUntilAborted(), 10),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("surfaces a provider error from a completed manifest GET", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("nope", { status: 503, statusText: "Service Unavailable" });

		await expect(
			getContentPackManifestJsonWithFetch(URL, fetchImpl, 1_000),
		).rejects.toThrow("503");
	});

	it("uses the injected fetch for a successful manifest GET", async () => {
		const signals: AbortSignal[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			return new Response(JSON.stringify({ id: "cyberpunk-neon" }), {
				status: 200,
			});
		};

		const json = await getContentPackManifestJsonWithFetch<{ id: string }>(
			URL,
			fetchImpl,
			1_000,
		);

		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
		expect(json).toEqual({ id: "cyberpunk-neon" });
	});
});
