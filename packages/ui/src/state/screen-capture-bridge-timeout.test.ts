/**
 * Behavioral screen-capture-bridge deadlines. Executes the poll GET and
 * screen-frame POST helpers under abort — not a source-grep.
 * Independent hops, separate 15s budgets. Not #21385. Not Twilio.
 */
import { describe, expect, it } from "vitest";
import {
	SCREEN_CAPTURE_POLL_TIMEOUT_MS,
	SCREEN_FRAME_POST_TIMEOUT_MS,
	getCaptureRequestsWithFetch,
	postScreenFrameWithFetch,
} from "./screen-capture-bridge";

function stallUntilAborted(): typeof fetch {
	return ((_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("expected screen-capture abort signal");
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		})) as typeof fetch;
}

describe("screen-capture-bridge poll GET deadline", () => {
	it("keeps a documented UI fetch budget", () => {
		expect(SCREEN_CAPTURE_POLL_TIMEOUT_MS).toBe(15_000);
	});

	it("aborts a stalled capture-requests GET at the injected deadline", async () => {
		await expect(
			getCaptureRequestsWithFetch(stallUntilAborted(), 10),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("surfaces a provider error from a completed capture-requests GET", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("nope", { status: 503, statusText: "Service Unavailable" });

		const response = await getCaptureRequestsWithFetch(fetchImpl, 1_000);
		expect(response.ok).toBe(false);
		expect(response.status).toBe(503);
	});

	it("uses the injected fetch for a successful capture-requests GET", async () => {
		const signals: AbortSignal[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			return new Response(JSON.stringify({ requests: [] }), { status: 200 });
		};

		const response = await getCaptureRequestsWithFetch(fetchImpl, 1_000);
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
		expect(response.ok).toBe(true);
		expect(await response.json()).toEqual({ requests: [] });
	});
});

describe("screen-capture-bridge screen-frame POST deadline", () => {
	it("keeps a documented UI fetch budget", () => {
		expect(SCREEN_FRAME_POST_TIMEOUT_MS).toBe(15_000);
	});

	it("aborts a stalled screen-frame POST at the injected deadline", async () => {
		await expect(
			postScreenFrameWithFetch({ requestId: "r1" }, stallUntilAborted(), 10),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("surfaces a provider error from a completed screen-frame POST", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("nope", { status: 503, statusText: "Service Unavailable" });

		await expect(
			postScreenFrameWithFetch({ requestId: "r1" }, fetchImpl, 1_000),
		).rejects.toThrow("503");
	});

	it("uses the injected fetch for a successful screen-frame POST", async () => {
		const signals: AbortSignal[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			return new Response("ok", { status: 200 });
		};

		const response = await postScreenFrameWithFetch(
			{ requestId: "r1" },
			fetchImpl,
			1_000,
		);
		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
		expect(response.ok).toBe(true);
	});
});
