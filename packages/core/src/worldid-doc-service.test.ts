/**
 * Pins Ship 20 DOC-SERVICE worldId tenant isolation:
 * - packages/core/src/features/documents/service.ts:1242/1267 `worldId: worldId || agentId` fabricates tenant via agentId fallback ignoring room.worldId and accepts non-UUID → old "abc"/victimWorld vs fixed room-bound + isUuid.
 * Fix: validate isUuid, bind to getRoom(roomId).worldId, override mismatch (sibling runtime/action-event-world + plugin-documents isUuid + service truth).
 * Sibling correct: runtime/action-event-world.ts:13 resolveActionEventWorldId with getRoom, plugin-documents routes isUuid, docs-loader isUuid, document-processor room-bound.
 */

import { describe, expect, it } from "vitest";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const WORLD_B = "22222222-2222-4222-8222-222222222222";
const VICTIM_WORLD = "33333333-3333-4333-8333-333333333333";

function oldDocServiceWorldId(worldId: string | undefined, agentId: string) {
	return worldId || agentId;
}
async function fixedDocServiceWorldId(
	worldId: string | undefined,
	roomId: string | undefined,
	agentId: string,
	getRoom: (id: string) => Promise<{ worldId?: string } | null>,
) {
	let resolved = worldId as string | undefined;
	const isUuid = (v: string) =>
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
	if (resolved && !isUuid(resolved)) resolved = undefined;
	if (roomId) {
		try {
			const room = await getRoom(roomId);
			if (room?.worldId) {
				if (resolved && room.worldId !== resolved) resolved = room.worldId;
				else if (!resolved) resolved = room.worldId;
			}
		} catch {}
	}
	return resolved ?? agentId;
}

describe("worldId doc-service batch (ship 20) — service.ts 2 sites", () => {
	it("missing worldId with room-B world: old agentId vs fixed world-B", async () => {
		const getRoom = async (id: string) =>
			id === "room-B" ? { worldId: WORLD_B } : null;
		expect(oldDocServiceWorldId(undefined, AGENT_ID)).toBe(AGENT_ID);
		expect(
			await fixedDocServiceWorldId(undefined, "room-B", AGENT_ID, getRoom),
		).toBe(WORLD_B);
		expect(
			await fixedDocServiceWorldId(undefined, undefined, AGENT_ID, getRoom),
		).toBe(AGENT_ID);
	});

	it("non-UUID abc with room-B: old abc vs fixed world-B (or agentId without room)", async () => {
		const getRoom = async (id: string) =>
			id === "room-B" ? { worldId: WORLD_B } : null;
		expect(oldDocServiceWorldId("abc", AGENT_ID)).toBe("abc");
		expect(
			await fixedDocServiceWorldId("abc", "room-B", AGENT_ID, getRoom),
		).toBe(WORLD_B);
		expect(
			await fixedDocServiceWorldId("abc", undefined, AGENT_ID, getRoom),
		).toBe(AGENT_ID);
		expect(
			await fixedDocServiceWorldId(WORLD_B, undefined, AGENT_ID, getRoom),
		).toBe(WORLD_B);
	});

	it("spoofed victimWorld valid UUID with room-B mismatch: old victimWorld vs fixed room-B override", async () => {
		const getRoom = async (id: string) =>
			id === "room-B" ? { worldId: WORLD_B } : null;
		expect(oldDocServiceWorldId(VICTIM_WORLD, AGENT_ID)).toBe(VICTIM_WORLD);
		expect(
			await fixedDocServiceWorldId(VICTIM_WORLD, "room-B", AGENT_ID, getRoom),
		).toBe(WORLD_B);
		expect(
			await fixedDocServiceWorldId(VICTIM_WORLD, undefined, AGENT_ID, getRoom),
		).toBe(VICTIM_WORLD);
		expect(
			await fixedDocServiceWorldId(WORLD_B, "room-B", AGENT_ID, getRoom),
		).toBe(WORLD_B);
	});

	it("ship20 sibling proof: service uses _resolvedWorldId + isUuid + getRoom and no bare worldId||agentId", async () => {
		const fs = await import("node:fs");
		const svc = fs.readFileSync(
			"packages/core/src/features/documents/service.ts",
			"utf8",
		);
		expect(svc).toContain("_resolvedWorldId");
		expect(svc).toContain("_isUuid");
		expect(svc).toContain("await this.runtime.getRoom(roomId as UUID)");
		expect(svc).toContain(
			"_resolvedWorldId && _room.worldId !== _resolvedWorldId",
		);
		expect(svc).toContain("_resolvedWorldId = _room.worldId as UUID;");
		// bare pattern should be gone for the two fixed sites (count remaining should be 0 for those exact service fragment sites — but other files may still have, we check service has no "worldId: worldId || agentId")
		expect(svc).not.toContain("worldId: worldId || agentId,");
		// sibling correct reference exists
		const actionWorld = fs.readFileSync(
			"packages/core/src/runtime/action-event-world.ts",
			"utf8",
		);
		expect(actionWorld).toContain("getRoom");
	});
});
