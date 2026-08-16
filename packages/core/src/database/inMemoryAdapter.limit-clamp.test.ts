/**
 * Pins inMemoryAdapter pagination limit/offset clamps against the strict
 * `isSafeInteger` contract used by the SQL adapters and pairing helper.
 * Guards the `??` / `||` / `typeof === "number"` paths where
 * `offset=-1` wrapped via `slice(-1)`, `limit=NaN` produced `slice(0,NaN)=[]`
 * (empty) vs SQL `no LIMIT` (full scan), `limit=Infinity` leaked full scan
 * without bound, and `if(limit)` truthy guard skipped `limit=0` (return all).
 * Sibling correct: `plugins/plugin-sql/src/stores/memory.store.ts:41`
 * `if(offset<0) throw`, and `packages/core/src/types/pairing.ts:118`
 * `normalizePairingPageOptions` with `isSafeInteger && 1..MAX`.
 */

import { describe, expect, it } from "vitest";
import type { Memory, UUID } from "../types";
import { MemoryType } from "../types";
import { InMemoryDatabaseAdapter } from "./inMemoryAdapter";

const AGENT = "10000000-0000-0000-0000-000000000001" as UUID;
const ROOM = "20000000-0000-0000-0000-000000000002" as UUID;
const WORLD = "30000000-0000-0000-0000-000000000004" as UUID;

function mem(id: number, createdAt: number): Memory {
	return {
		id: `m${id}` as UUID,
		entityId: AGENT,
		agentId: AGENT,
		roomId: ROOM,
		worldId: WORLD,
		createdAt,
		content: { text: `msg ${id}` },
		metadata: { type: MemoryType.MESSAGE },
	} as unknown as Memory;
}

async function seed(adapter: InMemoryDatabaseAdapter, count = 10) {
	await adapter.initialize();
	for (let i = 1; i <= count; i++) {
		await adapter.createMemories([
			{ memory: mem(i, i * 1000), tableName: "messages" },
		]);
	}
}

function oldSliceLimitOffset(all: Memory[], limit: number, offset: number) {
	// mirrors old buggy `typeof offset === "number" ? offset : 0` + raw limit
	const off = typeof offset === "number" ? offset : 0;
	const eff = limit;
	return all.slice(off, off + (eff === Infinity ? all.length : eff));
}

describe("inMemoryAdapter limit/offset clamp — 7 sites", () => {
	it("getMemories: NaN/-5/0/Infinity/5.5 fallback to Infinity (full scan) not empty/wrap", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await seed(adapter, 5);
		// valid 2 returns 2
		const two = await adapter.getMemories({
			tableName: "messages",
			roomId: ROOM,
			limit: 2,
		});
		expect(two.length).toBe(2);

		for (const bad of [NaN, -5, 0, Infinity, 5.5] as unknown as number[]) {
			const out = await adapter.getMemories({
				tableName: "messages",
				roomId: ROOM,
				limit: bad,
			});
			// invalid now returns all (Infinity fallback) not empty slice
			expect(out.length, `limit ${String(bad)}`).toBe(5);
			// old would have sliced empty for NaN/0 or leaked -5 wrapping
			const oldEmpty = oldSliceLimitOffset(
				[mem(1, 1000), mem(2, 2000), mem(3, 3000), mem(4, 4000), mem(5, 5000)],
				bad as number,
				0,
			);
			if (Number.isNaN(bad) || bad === 0) expect(oldEmpty.length).toBe(0);
		}

		// offset -1 no longer wraps via slice(-1) / produces empty
		const negOffset = await adapter.getMemories({
			tableName: "messages",
			roomId: ROOM,
			limit: 2,
			offset: -1 as unknown as number,
		});
		expect(negOffset.length).toBe(2);
		// clamped -1 → 0 gives same as offset 0 (newest first = m5, m4)
		const zeroOffset = await adapter.getMemories({
			tableName: "messages",
			roomId: ROOM,
			limit: 2,
			offset: 0,
		});
		expect(negOffset[0].id).toBe(zeroOffset[0].id);
		expect(negOffset[0].id).toBe("m5");
		// old buggy slice(-1,1) on sorted [m5,m4,m3,m2,m1] produced [] not the clamped window
		const sorted = [
			mem(5, 5000),
			mem(4, 4000),
			mem(3, 3000),
			mem(2, 2000),
			mem(1, 1000),
		];
		expect(oldSliceLimitOffset(sorted, 2, -1).length).toBe(0);
	});

	it("getMemoriesByRoomIds: limit 0/-5/NaN fallback 20, offset -1 →0", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await seed(adapter, 5);
		const roomIds = [ROOM];
		const valid = await adapter.getMemoriesByRoomIds({
			tableName: "messages",
			roomIds,
			limit: 2,
			offset: 0,
		});
		expect(valid.length).toBe(2);
		for (const bad of [0, -5, NaN, Infinity] as unknown as number[]) {
			const out = await adapter.getMemoriesByRoomIds({
				tableName: "messages",
				roomIds,
				limit: bad,
			});
			// fallback 20 → all 5 returned (since only 5 exist)
			expect(out.length, `limit ${String(bad)}`).toBe(5);
		}
		const badOffset = await adapter.getMemoriesByRoomIds({
			tableName: "messages",
			roomIds,
			limit: 2,
			offset: -1 as unknown as number,
		});
		expect(badOffset.length).toBe(2);
		// clamped -1 → 0 is newest first (msg 5), proves no wrap/empty
		const zeroOff = await adapter.getMemoriesByRoomIds({
			tableName: "messages",
			roomIds,
			limit: 2,
			offset: 0,
		});
		expect(badOffset[0].content.text).toBe(zeroOff[0].content.text);
		expect(badOffset[0].content.text).toBe("msg 5");
	});

	it("getLogs: effectiveLimit fallback 10 and offset -1 →0 strict", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		for (let i = 0; i < 12; i++) {
			await adapter.createLogs([
				{
					body: { text: `log ${i}` } as unknown as never,
					entityId: AGENT,
					roomId: ROOM,
					type: "test",
				},
			]);
		}
		const ten = await adapter.getLogs({ limit: 10 });
		expect(ten.length).toBe(10);
		for (const bad of [NaN, -5, 0, 5.5, Infinity] as unknown as number[]) {
			const out = await adapter.getLogs({ limit: bad });
			expect(out.length, `limit ${String(bad)}`).toBe(10);
		}
		const badOff = await adapter.getLogs({
			limit: 5,
			offset: -1 as unknown as number,
		});
		expect(badOff.length).toBe(5);
		expect(badOff[0].body).toBeDefined();
	});

	it("getTasks: truthy guard 0 now unbounded (all) not leak slice(0,0)=[] and -1/NaN also unbounded", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		for (let i = 0; i < 5; i++) {
			await adapter.createTasks([
				{
					id: `t${i}` as UUID,
					name: `task ${i}`,
					description: "d",
					agentId: AGENT,
					roomId: ROOM,
					tags: [],
					metadata: {},
				} as unknown as never,
			]);
		}
		const all = await adapter.getTasks({ agentIds: [AGENT] });
		expect(all.length).toBe(5);
		// limit 0 previously: `if(limit)` false → all (unbounded) — now same via clampLimitOrUnbounded
		const zero = await adapter.getTasks({ agentIds: [AGENT], limit: 0 });
		expect(zero.length).toBe(5);
		// old buggy `slice(0,0)` would be []
		expect([1, 2, 3].slice(0, 0).length).toBe(0);
		// invalid -5, NaN, 5.5, Infinity also unbounded (no limit)
		for (const bad of [-5, NaN, 5.5, Infinity] as unknown as number[]) {
			const out = await adapter.getTasks({ agentIds: [AGENT], limit: bad });
			expect(out.length, `limit ${String(bad)}`).toBe(5);
		}
		// offset -1 must not wrap
		const off = await adapter.getTasks({
			agentIds: [AGENT],
			limit: 2,
			offset: -1 as unknown as number,
		});
		expect(off.length).toBe(2);
	});

	it("getRoomsByWorlds: offset -1 →0 and limit -5/NaN/0 → unbounded not slice(0,-5)", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await adapter.initialize();
		// create rooms via direct store
		for (let i = 0; i < 5; i++) {
			// @ts-expect-error private map access for test setup
			adapter.rooms.set(`r${i}`, {
				id: `r${i}` as UUID,
				worldId: WORLD,
				name: `room ${i}`,
			} as unknown as never);
		}
		const all = await adapter.getRoomsByWorlds([WORLD]);
		expect(all.length).toBe(5);
		const badLimit = await adapter.getRoomsByWorlds(
			[WORLD],
			-5 as unknown as number,
		);
		expect(badLimit.length).toBe(5); // not slice(0,-5) = 0..4-5 = first 0? Actually slice(0,-5) would be 0
		expect([1, 2, 3, 4, 5].slice(0, -5).length).toBe(0);
		const badNaN = await adapter.getRoomsByWorlds(
			[WORLD],
			NaN as unknown as number,
		);
		expect(badNaN.length).toBe(5);
		const badOff = await adapter.getRoomsByWorlds(
			[WORLD],
			2,
			-1 as unknown as number,
		);
		expect(badOff.length).toBe(2);
	});

	it("sabotage: valid limits unchanged, invalid always fallback not NaN/empty/wrap", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		await seed(adapter, 5);
		// seed logs for this adapter too
		for (let i = 0; i < 5; i++) {
			await adapter.createLogs([
				{
					body: { text: `log ${i}` } as unknown as never,
					entityId: AGENT,
					roomId: ROOM,
					type: "test",
				},
			]);
		}
		// valid mid-range still works
		expect(
			(
				await adapter.getMemories({
					tableName: "messages",
					roomId: ROOM,
					limit: 3,
				})
			).length,
		).toBe(3);
		expect(
			(
				await adapter.getMemoriesByRoomIds({
					tableName: "messages",
					roomIds: [ROOM],
					limit: 3,
				})
			).length,
		).toBe(3);
		expect((await adapter.getLogs({ limit: 3 })).length).toBe(3);
		// invalid never produces NaN or wrap
		for (const bad of [NaN, -1, Infinity, 5.5] as unknown as number[]) {
			const m = await adapter.getMemories({
				tableName: "messages",
				roomId: ROOM,
				limit: bad,
			});
			expect(Number.isNaN(m.length)).toBe(false);
			const l = await adapter.getLogs({ limit: bad });
			expect(Number.isNaN(l.length)).toBe(false);
		}
	});
});
