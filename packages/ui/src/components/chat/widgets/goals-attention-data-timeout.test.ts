/**
 * Behavioral goals-attention JSON deadline. Executes
 * getGoalsAttentionJsonWithFetch under abort — not a source-grep of
 * goals-attention-data.ts.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../api", () => ({
	client: { getBaseUrl: () => "http://test.local" },
}));

vi.mock("../../../api/app-shell-capabilities", () => ({
	supportsFullAppShellRoutes: () => true,
}));

import {
	GOALS_ATTENTION_JSON_TIMEOUT_MS,
	getGoalsAttentionJsonWithFetch,
} from "./goals-attention-data";

const URL = "http://test.local/api/lifeops/goals";

function stallUntilAborted(): typeof fetch {
	return ((_input, init) =>
		new Promise<Response>((_resolve, reject) => {
			const signal = init?.signal;
			if (!signal) throw new Error("expected goals-attention abort signal");
			signal.addEventListener("abort", () => reject(signal.reason), {
				once: true,
			});
		})) as typeof fetch;
}

describe("Goals-attention JSON deadline", () => {
	it("keeps a documented UI JSON budget", () => {
		expect(GOALS_ATTENTION_JSON_TIMEOUT_MS).toBe(15_000);
	});

	it("aborts a stalled goals GET at the injected deadline", async () => {
		await expect(
			getGoalsAttentionJsonWithFetch(URL, stallUntilAborted(), 10),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("surfaces a provider error from a completed goals GET", async () => {
		const fetchImpl: typeof fetch = async () =>
			new Response("nope", { status: 503, statusText: "Service Unavailable" });

		await expect(
			getGoalsAttentionJsonWithFetch(URL, fetchImpl, 1_000),
		).rejects.toThrow("503");
	});

	it("uses the injected fetch for a successful goals GET", async () => {
		const signals: AbortSignal[] = [];
		const fetchImpl: typeof fetch = async (_input, init) => {
			if (init?.signal) signals.push(init.signal);
			return Response.json({ goals: [] });
		};

		const body = await getGoalsAttentionJsonWithFetch<{ goals: unknown[] }>(
			URL,
			fetchImpl,
			1_000,
		);

		expect(signals).toHaveLength(1);
		expect(signals[0]?.aborted).toBe(false);
		expect(body.goals).toEqual([]);
	});
});
