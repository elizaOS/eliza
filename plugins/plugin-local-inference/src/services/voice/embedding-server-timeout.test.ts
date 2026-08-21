/**
 * Exercises distinct embedding-server health and embed deadlines through
 * injectable HTTP boundaries.
 */
import { describe, expect, it } from "vitest";
import {
	EMBEDDING_SERVER_EMBED_TIMEOUT_MS,
	EMBEDDING_SERVER_HEALTH_TIMEOUT_MS,
	embedWithFetch,
	probeEmbeddingServerHealthWithFetch,
} from "./embedding-server";

const HEALTH_URL = "http://127.0.0.1:9/health";
const BASE_URL = "http://127.0.0.1:9";
const VECTOR = Array.from({ length: 64 }, () => 1);

function stallUntilAborted(): typeof fetch {
	return ((_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("expected embedding-server abort signal");
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		})) as typeof fetch;
}

describe("embedding-server probe vs embed deadlines", () => {
	it("keeps a short health budget separate from the longer embed hop", () => {
		expect(EMBEDDING_SERVER_HEALTH_TIMEOUT_MS).toBe(2_000);
		expect(EMBEDDING_SERVER_EMBED_TIMEOUT_MS).toBe(30_000);
		expect(EMBEDDING_SERVER_HEALTH_TIMEOUT_MS).toBeLessThan(
			EMBEDDING_SERVER_EMBED_TIMEOUT_MS,
		);
	});

	it("treats a stalled health probe as not-ready after the injected deadline", async () => {
		await expect(
			probeEmbeddingServerHealthWithFetch(HEALTH_URL, stallUntilAborted(), 10),
		).resolves.toBe(false);
	});

	it("treats a completed health probe error as not-ready", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("", { status: 503, statusText: "Service Unavailable" });

		await expect(
			probeEmbeddingServerHealthWithFetch(HEALTH_URL, fetchImpl, 1_000),
		).resolves.toBe(false);
	});

	it("uses the injected fetch for a successful health probe", async () => {
		const signals: AbortSignal[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			return new Response("ok", { status: 200 });
		};

		await expect(
			probeEmbeddingServerHealthWithFetch(HEALTH_URL, fetchImpl, 1_000),
		).resolves.toBe(true);
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
	});

	it("aborts a stalled embed POST at the injected deadline", async () => {
		await expect(
			embedWithFetch(BASE_URL, ["hello"], 64, stallUntilAborted(), 10),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("surfaces a provider error from a completed embed POST", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("busy", { status: 502, statusText: "Bad Gateway" });

		await expect(
			embedWithFetch(BASE_URL, ["hello"], 64, fetchImpl, 1_000),
		).rejects.toThrow("502");
	});

	it("preserves caller cancellation during embedding", async () => {
		const controller = new AbortController();
		const reason = new DOMException("voice turn stopped", "AbortError");
		const pending = embedWithFetch(
			BASE_URL,
			["hello"],
			64,
			stallUntilAborted(),
			1_000,
			controller.signal,
		);

		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
	});

	it("uses the injected fetch for a successful embed POST", async () => {
		const signals: AbortSignal[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			return Response.json({
				data: [{ embedding: VECTOR }],
			});
		};

		const rows = await embedWithFetch(
			BASE_URL,
			["hello"],
			64,
			fetchImpl,
			1_000,
		);

		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toHaveLength(64);
	});
});
