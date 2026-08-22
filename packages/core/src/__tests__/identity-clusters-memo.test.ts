/**
 * Cluster-resolution memo: getRelatedEntityIds collapses the duplicate
 * union-find BFS that FACTS + RECENT_MESSAGES + the planner recompose run every
 * turn. Verifies in-flight sharing, turn isolation, explicit invalidation, and
 * rejection eviction against a counting fake resolver — no DB, no model.
 */
import { describe, expect, it, vi } from "vitest";
import {
	getRelatedEntityIds,
	getVerifiedRelatedEntityIds,
	invalidateRelatedEntityIds,
} from "../identity-clusters";
import { runWithTrajectoryContext } from "../trajectory-context.ts";
import { type IAgentRuntime, ServiceType, type UUID } from "../types/index.ts";

const AGENT = "00000000-0000-0000-0000-0000000000aa" as UUID;
const SENDER = "11111111-1111-1111-1111-111111111111" as UUID;
const ALIAS = "22222222-2222-2222-2222-222222222222" as UUID;

function runtimeWithResolver(service: {
	getMemberEntityIds: (id: UUID) => Promise<UUID[]>;
}): IAgentRuntime {
	return {
		agentId: AGENT,
		getService: (name: string) => (name === "relationships" ? service : null),
	} as unknown as IAgentRuntime;
}

function runtimeWith(
	getMemberEntityIds: (id: UUID) => Promise<UUID[]>,
): IAgentRuntime {
	return runtimeWithResolver({ getMemberEntityIds });
}

function inTurn<T>(work: () => Promise<T>): Promise<T> {
	return runWithTrajectoryContext({ turnMemo: new Map() }, work) as Promise<T>;
}

describe("getRelatedEntityIds memo", () => {
	it("preserves the relationship service receiver while memoizing", async () => {
		const service = {
			member: ALIAS,
			async getMemberEntityIds() {
				return [this.member];
			},
		};
		const runtime = runtimeWithResolver(service);

		expect(await getRelatedEntityIds(runtime, SENDER)).toEqual([SENDER, ALIAS]);
	});

	it("shares one in-flight resolver call across concurrent callers", async () => {
		let calls = 0;
		const runtime = runtimeWith(async () => {
			calls += 1;
			return [ALIAS];
		});
		const [a, b, c] = await inTurn(() =>
			Promise.all([
				getRelatedEntityIds(runtime, SENDER),
				getRelatedEntityIds(runtime, SENDER),
				getRelatedEntityIds(runtime, SENDER),
			]),
		);
		expect(calls).toBe(1);
		expect(a).toEqual([SENDER, ALIAS]);
		expect(b).toEqual([SENDER, ALIAS]);
		expect(c).toEqual([SENDER, ALIAS]);
	});

	it("reuses within one turn and re-queries in the next turn", async () => {
		let calls = 0;
		const runtime = runtimeWith(async () => {
			calls += 1;
			return [ALIAS];
		});
		await inTurn(async () => {
			await getRelatedEntityIds(runtime, SENDER);
			await getRelatedEntityIds(runtime, SENDER);
		});
		expect(calls).toBe(1);
		await inTurn(() => getRelatedEntityIds(runtime, SENDER));
		expect(calls).toBe(2);
	});

	it("re-queries immediately after explicit invalidation (post-merge)", async () => {
		let calls = 0;
		const runtime = runtimeWith(async () => {
			calls += 1;
			return [ALIAS];
		});
		await inTurn(async () => {
			await getRelatedEntityIds(runtime, SENDER);
			invalidateRelatedEntityIds(runtime, SENDER);
			await getRelatedEntityIds(runtime, SENDER);
		});
		expect(calls).toBe(2);
	});

	it("evicts a rejected lookup so the failure is retried, not cached", async () => {
		let calls = 0;
		const runtime = runtimeWith(async () => {
			calls += 1;
			if (calls === 1) throw new Error("db unavailable");
			return [ALIAS];
		});
		const retry = await inTurn(async () => {
			await expect(getRelatedEntityIds(runtime, SENDER)).rejects.toThrow(
				"db unavailable",
			);
			return getRelatedEntityIds(runtime, SENDER);
		});
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

describe("getVerifiedRelatedEntityIds", () => {
	it("prefers the canonical identity authority cluster", async () => {
		const getMemberEntityIds = vi.fn(async () => [
			"33333333-3333-3333-3333-333333333333" as UUID,
		]);
		const runtime = {
			agentId: AGENT,
			getService: (name: string) => {
				if (name === ServiceType.IDENTITY_RESOLUTION) {
					return {
						getCluster: async () => ({
							contractVersion: 1,
							agentId: AGENT,
							canonicalPrincipalId: SENDER,
							principalIds: [SENDER, ALIAS],
							claims: [],
							generation: 4,
							readAt: new Date(0).toISOString(),
						}),
					};
				}
				return name === "relationships" ? { getMemberEntityIds } : null;
			},
		} as unknown as IAgentRuntime;

		expect(
			await inTurn(() => getVerifiedRelatedEntityIds(runtime, SENDER)),
		).toEqual([SENDER, ALIAS]);
		expect(getMemberEntityIds).not.toHaveBeenCalled();
	});

	it("rejects malformed authority output without falling back to weaker inference", async () => {
		const getVerifiedMemberEntityIds = vi.fn(async () => [ALIAS]);
		const runtime = {
			agentId: AGENT,
			getService: (name: string) => {
				if (name === ServiceType.IDENTITY_RESOLUTION) {
					return {
						getCluster: async () => ({
							contractVersion: 1,
							agentId: AGENT,
							canonicalPrincipalId: ALIAS,
							principalIds: [ALIAS],
							claims: [],
							generation: 1,
							readAt: new Date(0).toISOString(),
						}),
					};
				}
				return name === "relationships" ? { getVerifiedMemberEntityIds } : null;
			},
		} as unknown as IAgentRuntime;

		await expect(
			inTurn(() => getVerifiedRelatedEntityIds(runtime, SENDER)),
		).rejects.toMatchObject({ code: "IDENTITY_CLUSTER_INVALID" });
		expect(getVerifiedMemberEntityIds).not.toHaveBeenCalled();
	});

	it("uses only confirmed-link resolution when no authority is registered", async () => {
		const getMemberEntityIds = vi.fn(async () => [
			"33333333-3333-3333-3333-333333333333" as UUID,
		]);
		const getVerifiedMemberEntityIds = vi.fn(async () => [ALIAS]);
		const runtime = {
			agentId: AGENT,
			getService: (name: string) =>
				name === "relationships"
					? { getMemberEntityIds, getVerifiedMemberEntityIds }
					: null,
		} as unknown as IAgentRuntime;

		expect(
			await inTurn(() => getVerifiedRelatedEntityIds(runtime, SENDER)),
		).toEqual([SENDER, ALIAS]);
		expect(getMemberEntityIds).not.toHaveBeenCalled();
		expect(getVerifiedMemberEntityIds).toHaveBeenCalledWith(SENDER);
	});

	it("fails closed to the requester when no verified resolver exists", async () => {
		const runtime = runtimeWith(async () => [ALIAS]);
		expect(
			await inTurn(() => getVerifiedRelatedEntityIds(runtime, SENDER)),
		).toEqual([SENDER]);
	});
});
