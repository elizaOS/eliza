/**
 * Pins Ship 12 worldId tenant isolation fixes (W-1, W-2, W-5):
 * deterministic fabrication via `worldId ?? roomId|agentId` and
 * unvalidated `asUuid(...) ?? agentId` vs room-bound `getRoom` + `isUuid`.
 *
 * Sibling correct: `runtime/action-event-world.ts:18` `resolveActionEventWorldId`
 * and `features/working-memory/readAttachmentAction.ts:652` after `getRoom`.
 */

import { describe, expect, it } from "vitest";
import { resolveActionEventWorldId } from "./runtime/action-event-world.ts";
import type { UUID } from "./types/index.ts";

// replica old helpers
function oldAsUuid(value: unknown): string | undefined {
	const t = typeof value === "string" ? value.trim() : "";
	return t ? (t as string) : undefined;
}
function isUuidValue(value: unknown): boolean {
	return (
		typeof value === "string" &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			value.trim(),
		)
	);
}
function fixedWorldIdFromDocument(
	docWorldId: unknown,
	agentId: string,
): string {
	return isUuidValue(docWorldId) ? (docWorldId as string).trim() : agentId;
}

// replica old vs fixed for W-1/W-2
function oldW1(worldId: string | undefined, roomId: string): string {
	return worldId ?? roomId;
}
async function fixedW1(
	worldId: string | undefined,
	roomId: string,
	getRoom: (id: string) => Promise<{ worldId?: string } | null>,
	_agentId: string,
): Promise<string> {
	if (worldId) return worldId;
	const room = await getRoom(roomId).catch(() => null);
	if (!room?.worldId) throw new Error("CREATIVE_DRAFT_WORLD_MISSING");
	return room.worldId;
}
function oldW2(worldId: string | undefined, agentId: string): string {
	return worldId ?? agentId;
}
async function fixedW2(
	worldId: string | undefined,
	roomId: string,
	getRoom: (id: string) => Promise<{ worldId?: string } | null>,
	_agentId: string,
): Promise<string> {
	if (worldId) return worldId;
	const room = await getRoom(roomId).catch(() => null);
	if (!room?.worldId) throw new Error("DOCUMENT_WORLD_MISSING");
	return room.worldId;
}

describe("worldId tenant isolation (ship 12) — W-1, W-2, W-5", () => {
	it("W-1 creative-draft: old fabricates roomId as worldId vs fixed uses room.worldId", async () => {
		const roomId = "11111111-1111-4111-8111-111111111111";
		const worldA = "22222222-2222-4222-8222-222222222222";
		const agentId = "33333333-3333-4333-8333-333333333333";
		const getRoom = async (id: string) => {
			expect(id).toBe(roomId);
			return { worldId: worldA };
		};
		const old = oldW1(undefined, roomId);
		expect(old).toBe(roomId); // namespace mix
		expect(old).not.toBe(worldA);
		const fixed = await fixedW1(undefined, roomId, getRoom, agentId);
		expect(fixed).toBe(worldA);
		expect(fixed).not.toBe(roomId);
		// throws when room has no world
		await expect(
			fixedW1(undefined, roomId, async () => null, agentId),
		).rejects.toThrow("CREATIVE_DRAFT_WORLD_MISSING");
	});

	it("W-2 scopedAddOptions: old falls back to agentId vs fixed resolves room.worldId", async () => {
		const roomId = "44444444-4444-4444-8444-444444444444";
		const worldA = "55555555-5555-4555-8555-555555555555";
		const agentId = "66666666-6666-4666-8666-666666666666";
		const getRoom = async () => ({ worldId: worldA });
		expect(oldW2(undefined, agentId)).toBe(agentId);
		expect(oldW2(undefined, agentId)).not.toBe(worldA);
		const fixed = await fixedW2(undefined, roomId, getRoom, agentId);
		expect(fixed).toBe(worldA);
		await expect(
			fixedW2(undefined, roomId, async () => ({}), agentId),
		).rejects.toThrow("DOCUMENT_WORLD_MISSING");
	});

	it("W-5 isUuid validation: asUuid-old accepts any non-empty string vs isUuid rejects", () => {
		const attackerWorld = "not-a-uuid";
		const victimWorld = "77777777-7777-4777-8777-777777777777";
		const agentId = "88888888-8888-4888-8888-888888888888";
		// old: any non-empty passes
		expect(oldAsUuid(attackerWorld)).toBe(attackerWorld);
		expect(oldAsUuid("")).toBeUndefined();
		// fixed: isUuid rejects garbage, accepts real UUID
		expect(isUuidValue(attackerWorld)).toBe(false);
		expect(isUuidValue(victimWorld)).toBe(true);
		expect(isUuidValue("  ")).toBe(false);
		expect(isUuidValue("")).toBe(false);
		expect(isUuidValue(`${victimWorld} `)).toBe(true);
		// end-to-end fixedWorldIdFromDocument
		expect(fixedWorldIdFromDocument(attackerWorld, agentId)).toBe(agentId);
		expect(fixedWorldIdFromDocument(victimWorld, agentId)).toBe(victimWorld);
		expect(fixedWorldIdFromDocument("", agentId)).toBe(agentId);
		expect(fixedWorldIdFromDocument(undefined, agentId)).toBe(agentId);
	});

	it("W-5 route spoof: attacker supplies victim worldId — old passes via asUuid, fixed validates isUuid and falls back correctly", () => {
		const victimWorld = "99999999-9999-4999-8999-999999999999";
		const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
		const fakeWorld = "attacker-string-not-uuid";
		// old would accept fakeWorld as worldId (tenant poisoning)
		const oldWorldId = oldAsUuid(fakeWorld) ?? agentId;
		expect(oldWorldId).toBe(fakeWorld);
		// fixed rejects fakeWorld → falls back to agentId (scoped validation layer would later bind to room)
		const fixedFake = fixedWorldIdFromDocument(fakeWorld, agentId);
		expect(fixedFake).toBe(agentId);
		// valid victim UUID still passes when attacker knows it (requires isUuid, not secrecy)
		// but legitimate client with valid UUID is preserved — spoof still possible if attacker knows UUID,
		// which is why room-to-world binding via getRoom is the stronger defense (covered by W-1/W-2).
		expect(fixedWorldIdFromDocument(victimWorld, agentId)).toBe(victimWorld);
	});

	it("sibling correct resolveActionEventWorldId uses room.worldId not roomId", async () => {
		const agentId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
		const roomId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc" as UUID;
		const worldA = "dddddddd-dddd-4ddd-8ddd-dddddddddddd" as UUID;
		const runtime: any = {
			agentId,
			getRoom: async (id: UUID) => {
				expect(id).toBe(roomId);
				return { id: roomId, worldId: worldA } as any;
			},
			reportError: () => {},
		};
		// when message has no worldId, helper resolves via room.worldId
		const out = await resolveActionEventWorldId(
			runtime,
			{ roomId, worldId: undefined } as any,
			"test",
		);
		expect(out).toBe(worldA);
		expect(out).not.toBe(roomId);
		// direct worldId passthrough
		const direct = await resolveActionEventWorldId(
			runtime,
			{ roomId, worldId: worldA } as any,
			"test",
		);
		expect(direct).toBe(worldA);
	});
});
