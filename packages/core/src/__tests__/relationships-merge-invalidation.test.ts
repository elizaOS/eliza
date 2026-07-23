/**
 * acceptMerge → cluster-memo invalidation wiring: accepting an identity merge
 * must drop the memoized identity cluster for BOTH merged entities, so the
 * next getRelatedEntityIds re-queries live membership instead of serving
 * up-to-TTL-stale clusters from the memo. Runs against a stubbed
 * execSql/getContact — no DB, no model — the merge SQL path is exercised
 * shape-only while the memo interplay is real.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	getRelatedEntityIds,
	invalidateRelatedEntityIds,
} from "../identity-clusters";
import { RelationshipsService } from "../services/relationships";
import type { IAgentRuntime, UUID } from "../types/index.ts";

const AGENT = "00000000-0000-0000-0000-0000000000aa" as UUID;
const ENTITY_A = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY_B = "22222222-2222-2222-2222-222222222222" as UUID;
const CANDIDATE = "33333333-3333-3333-3333-333333333333" as UUID;

function makeFixture() {
	let resolverCalls = 0;
	const resolver = {
		getMemberEntityIds: async (id: UUID) => {
			resolverCalls += 1;
			return [id];
		},
	};
	const runtime = {
		agentId: AGENT,
		getService: (name: string) => (name === "relationships" ? resolver : null),
		getRelationships: async () => [],
		createRelationship: async () => true,
	} as unknown as IAgentRuntime;

	const service = new RelationshipsService(runtime);
	const executed: string[] = [];
	Reflect.set(service, "execSql", async (sqlText: string) => {
		executed.push(sqlText.trim().split(/\s+/, 1)[0] ?? "");
		if (sqlText.includes("FROM entity_merge_candidates")) {
			return {
				rows: [
					{
						id: CANDIDATE,
						entity_a: ENTITY_A,
						entity_b: ENTITY_B,
						confidence: 0.99,
						evidence: {},
						status: "pending",
						proposed_at: new Date().toISOString(),
						resolved_at: null,
					},
				],
			};
		}
		return { rows: [] };
	});
	Reflect.set(service, "getContact", async () => null);

	return {
		runtime,
		service,
		executed,
		resolverCalls: () => resolverCalls,
	};
}

afterEach(() => {
	invalidateRelatedEntityIds({ agentId: AGENT } as IAgentRuntime);
});

describe("acceptMerge cluster-memo invalidation", () => {
	it("drops the memoized cluster for both merged entities", async () => {
		const { runtime, service, executed, resolverCalls } = makeFixture();

		// Seed and confirm the memo for both sides.
		await getRelatedEntityIds(runtime, ENTITY_A);
		await getRelatedEntityIds(runtime, ENTITY_B);
		expect(resolverCalls()).toBe(2);
		await getRelatedEntityIds(runtime, ENTITY_A);
		await getRelatedEntityIds(runtime, ENTITY_B);
		expect(resolverCalls()).toBe(2); // served from the memo

		await service.acceptMerge(CANDIDATE);
		// The merge transaction actually ran (shape-only stub).
		expect(executed).toContain("BEGIN");
		expect(executed).toContain("COMMIT");

		// Both sides re-query live — the memo entries were invalidated.
		await getRelatedEntityIds(runtime, ENTITY_A);
		await getRelatedEntityIds(runtime, ENTITY_B);
		expect(resolverCalls()).toBe(4);
	});

	it("leaves unrelated memo entries intact across a merge", async () => {
		const { runtime, service, resolverCalls } = makeFixture();
		const bystander = "44444444-4444-4444-4444-444444444444" as UUID;

		await getRelatedEntityIds(runtime, bystander);
		expect(resolverCalls()).toBe(1);

		await service.acceptMerge(CANDIDATE);

		await getRelatedEntityIds(runtime, bystander);
		expect(resolverCalls()).toBe(1); // bystander still memoized
	});
});
