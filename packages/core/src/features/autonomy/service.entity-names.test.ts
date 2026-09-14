/**
 * Covers the autonomy service's sender-name lookup: every distinct sender in
 * the target rooms is resolved through one batched entity read, with an id
 * fallback for senders that have no entity row. Deterministic mock runtime.
 */
import { describe, expect, test } from "vitest";
import { createMockRuntime } from "../../testing/mock-runtime";
import type { Entity, IAgentRuntime, UUID } from "../../types";
import { AutonomyService } from "./service";

const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const GHOST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;

type Harness = {
	buildEntityNameLookup: (ids: Set<UUID>) => Promise<Map<UUID, string>>;
};

function serviceWith(runtime: IAgentRuntime): Harness {
	const service = new AutonomyService();
	(service as unknown as { runtime: IAgentRuntime }).runtime = runtime;
	return service as unknown as Harness;
}

describe("AutonomyService sender name lookup", () => {
	test("resolves every sender through one batched read and falls back to the id", async () => {
		const batchReads: UUID[][] = [];
		const runtime = createMockRuntime({
			getEntitiesByIds: async (ids: UUID[]) => {
				batchReads.push([...ids]);
				const rows: Record<string, Entity> = {
					[ALICE]: { id: ALICE, names: ["Alice"], agentId: ALICE },
					[BOB]: { id: BOB, names: ["Bob"], agentId: BOB },
				};
				return ids.flatMap((id) => (rows[id] ? [rows[id]] : []));
			},
		});

		const names = await serviceWith(runtime).buildEntityNameLookup(
			new Set([ALICE, GHOST, BOB]),
		);

		expect(batchReads).toEqual([[ALICE, GHOST, BOB]]);
		expect(names).toEqual(
			new Map([
				[ALICE, "Alice"],
				[GHOST, GHOST],
				[BOB, "Bob"],
			]),
		);
	});

	test("skips the read entirely when no sender needs a name", async () => {
		let reads = 0;
		const runtime = createMockRuntime({
			getEntitiesByIds: async () => {
				reads += 1;
				return [];
			},
		});

		const names = await serviceWith(runtime).buildEntityNameLookup(new Set());

		expect(reads).toBe(0);
		expect(names.size).toBe(0);
	});
});
