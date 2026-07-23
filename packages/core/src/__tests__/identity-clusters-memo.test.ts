/**
 * Cluster-resolution memo: getRelatedEntityIds collapses the duplicate
 * union-find BFS that FACTS + RECENT_MESSAGES + the planner recompose run every
 * turn. Verifies in-flight sharing, TTL reuse, explicit invalidation, and
 * rejection eviction against a counting fake resolver — no DB, no model.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getRelatedEntityIds,
	invalidateRelatedEntityIds,
} from "../identity-clusters";
import type { IAgentRuntime, UUID } from "../types/index.ts";

const AGENT = "00000000-0000-0000-0000-0000000000aa" as UUID;
const SENDER = "11111111-1111-1111-1111-111111111111" as UUID;
const ALIAS = "22222222-2222-2222-2222-222222222222" as UUID;

function runtimeWith(
	getMemberEntityIds: (id: UUID) => Promise<UUID[]>,
): IAgentRuntime {
	const service = { getMemberEntityIds };
	return {
		agentId: AGENT,
		getService: (name: string) => (name === "relationships" ? service : null),
	} as unknown as IAgentRuntime;
}

afterEach(() => {
	invalidateRelatedEntityIds({ agentId: AGENT } as IAgentRuntime);
	vi.useRealTimers();
});

describe("getRelatedEntityIds memo", () => {
	it("preserves the relationship service receiver while memoizing", async () => {
		const service = {
			member: ALIAS,
			async getMemberEntityIds() {
				return [this.member];
			},
		};
		const runtime = {
			agentId: AGENT,
			getService: (name: string) => (name === "relationships" ? service : null),
		} as unknown as IAgentRuntime;

		expect(await getRelatedEntityIds(runtime, SENDER)).toEqual([SENDER, ALIAS]);
	});

	it("shares one in-flight resolver call across concurrent callers", async () => {
		let calls = 0;
		const runtime = runtimeWith(async () => {
			calls += 1;
			return [ALIAS];
		});
		const [a, b, c] = await Promise.all([
			getRelatedEntityIds(runtime, SENDER),
			getRelatedEntityIds(runtime, SENDER),
			getRelatedEntityIds(runtime, SENDER),
		]);
		expect(calls).toBe(1);
		expect(a).toEqual([SENDER, ALIAS]);
		expect(b).toEqual([SENDER, ALIAS]);
		expect(c).toEqual([SENDER, ALIAS]);
	});

	it("reuses the memo within the TTL and re-queries after it lapses", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const runtime = runtimeWith(async () => {
			calls += 1;
			return [ALIAS];
		});
		await getRelatedEntityIds(runtime, SENDER);
		vi.advanceTimersByTime(10_000);
		await getRelatedEntityIds(runtime, SENDER);
		expect(calls).toBe(1); // within 30s TTL — no re-query

		vi.advanceTimersByTime(30_001);
		await getRelatedEntityIds(runtime, SENDER);
		expect(calls).toBe(2); // TTL lapsed — re-queried
	});

	it("re-queries immediately after explicit invalidation (post-merge)", async () => {
		let calls = 0;
		const runtime = runtimeWith(async () => {
			calls += 1;
			return [ALIAS];
		});
		await getRelatedEntityIds(runtime, SENDER);
		invalidateRelatedEntityIds(runtime, SENDER);
		await getRelatedEntityIds(runtime, SENDER);
		expect(calls).toBe(2);
	});

	it("evicts a rejected lookup so the failure is retried, not cached", async () => {
		let calls = 0;
		const runtime = runtimeWith(async () => {
			calls += 1;
			if (calls === 1) throw new Error("db unavailable");
			return [ALIAS];
		});
		await expect(getRelatedEntityIds(runtime, SENDER)).rejects.toThrow(
			"db unavailable",
		);
		// A subsequent call re-runs (rejection was not memoized).
		const retry = await getRelatedEntityIds(runtime, SENDER);
		expect(calls).toBe(2);
		expect(retry).toEqual([SENDER, ALIAS]);
	});

	it("falls back to the identity list when no resolver is present", async () => {
		const runtime = {
			agentId: AGENT,
			getService: () => null,
		} as unknown as IAgentRuntime;
		expect(await getRelatedEntityIds(runtime, SENDER)).toEqual([SENDER]);
	});
});
