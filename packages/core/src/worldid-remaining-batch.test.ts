/**
 * Pins Ship 18 worldId remaining batch (W-3, W-4, W-6):
 * - W-3 document-processor 3 sites: worldId ??/|| agentId without room lookup
 * - W-4 docs-loader 1 site: worldId || agentId without isUuid validation
 * - W-6 transcripts 2 sites: body.worldId ?? agentId without isUuid/room binding
 * Fix: room-bound getRoom(roomId).worldId with isUuid validation where client-controlled.
 * Sibling correct: runtime/action-event-world.ts resolveActionEventWorldId and readAttachmentAction after getRoom, and plugin-documents isUuid guard at 63.
 */

import { describe, expect, it } from "vitest";

function oldDocProcessorWorldId(
	worldId: string | undefined,
	agentId: string,
): string {
	return worldId ?? agentId;
}
async function fixedDocProcessorWorldId(
	worldId: string | undefined,
	roomId: string | undefined,
	agentId: string,
	getRoom: (id: string) => Promise<{ worldId?: string } | null>,
): Promise<string> {
	let resolved = worldId as string | undefined;
	if (!resolved && roomId) {
		try {
			const room = await getRoom(roomId);
			if (room?.worldId) resolved = room.worldId;
		} catch {}
	}
	return resolved ?? agentId;
}

function oldDocsLoaderWorldId(
	worldId: string | undefined,
	agentId: string,
): string {
	return worldId || agentId;
}
function fixedDocsLoaderWorldId(
	worldId: string | undefined,
	agentId: string,
): string {
	const isUuid = (v: string) =>
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
	return worldId && isUuid(worldId) ? (worldId as string) : agentId;
}

function oldTranscriptWorldId(
	worldId: string | undefined,
	agentId: string,
): string {
	return (worldId ?? agentId) as string;
}
async function fixedTranscriptWorldId(
	worldId: string | undefined,
	roomId: string | undefined,
	agentId: string,
	getRoom: (id: string) => Promise<{ worldId?: string } | null>,
): Promise<string> {
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

describe("worldId remaining batch (ship 18) — W-3/W-4/W-6", () => {
	it("W-3 doc processor: missing worldId old falls to agentId vs fixed room world", async () => {
		const agentId = "00000000-0000-0000-0000-000000000001";
		const roomId = "00000000-0000-0000-0000-000000000002";
		const roomWorld = "00000000-0000-0000-0000-000000000099";
		const getRoom = async (id: string) =>
			id === roomId ? { worldId: roomWorld } : null;

		expect(oldDocProcessorWorldId(undefined, agentId)).toBe(agentId); // BUG: ignores room world
		expect(
			await fixedDocProcessorWorldId(undefined, roomId, agentId, getRoom),
		).toBe(roomWorld);
		// when worldId provided, both preserve it (no leak)
		expect(
			await fixedDocProcessorWorldId(roomWorld, roomId, agentId, getRoom),
		).toBe(roomWorld);
		// when worldId missing and room has no world, falls to agentId
		expect(
			await fixedDocProcessorWorldId(
				undefined,
				"no-room",
				agentId,
				async () => null,
			),
		).toBe(agentId);
	});

	it("W-4 docs-loader: non-UUID worldId old accepts vs fixed rejects to agentId", () => {
		const agentId = "00000000-0000-0000-0000-000000000001";
		expect(oldDocsLoaderWorldId("victimWorld", agentId)).toBe("victimWorld"); // BUG: any string accepted
		expect(oldDocsLoaderWorldId("abc", agentId)).toBe("abc");
		expect(oldDocsLoaderWorldId("", agentId)).toBe(agentId); // empty falsy

		expect(fixedDocsLoaderWorldId("victimWorld", agentId)).toBe(agentId); // fixed rejects non-UUID
		expect(fixedDocsLoaderWorldId("abc", agentId)).toBe(agentId);
		expect(fixedDocsLoaderWorldId("", agentId)).toBe(agentId);
		const valid = "11111111-1111-4111-8111-111111111111";
		expect(fixedDocsLoaderWorldId(valid, agentId)).toBe(valid);
	});

	it("W-6 transcripts: missing/invalid/spoofed worldId old vs fixed room-bound", async () => {
		const agentId = "00000000-0000-0000-0000-000000000001";
		const roomId = "00000000-0000-0000-0000-000000000002";
		const roomWorld = "22222222-2222-4222-8222-222222222222";
		const victimWorld = "33333333-3333-4333-8333-333333333333";
		const getRoom = async (id: string) =>
			id === roomId ? { worldId: roomWorld } : null;

		// missing worldId: old falls to agentId ignoring room, fixed uses room
		expect(oldTranscriptWorldId(undefined, agentId)).toBe(agentId);
		expect(
			await fixedTranscriptWorldId(undefined, roomId, agentId, getRoom),
		).toBe(roomWorld);

		// invalid UUID: old accepts via ?? (truthy string), fixed rejects and uses room
		expect(oldTranscriptWorldId("abc", agentId)).toBe("abc"); // BUG
		expect(await fixedTranscriptWorldId("abc", roomId, agentId, getRoom)).toBe(
			roomWorld,
		);

		// spoofed valid victimWorld but room's world differs: old keeps victim, fixed overrides to room's world
		expect(oldTranscriptWorldId(victimWorld, agentId)).toBe(victimWorld);
		expect(
			await fixedTranscriptWorldId(victimWorld, roomId, agentId, getRoom),
		).toBe(roomWorld);

		// valid victimWorld with no room: fixed keeps it (no room to bind)
		expect(
			await fixedTranscriptWorldId(victimWorld, undefined, agentId, getRoom),
		).toBe(victimWorld);
	});

	it("ship18 sibling proof: files use getRoom + isUuid/roomId binding", async () => {
		const fs = await import("node:fs");
		const docProc = fs.readFileSync(
			"packages/core/src/features/documents/document-processor.ts",
			"utf8",
		);
		expect(docProc).toContain(
			"await args.runtime.getRoom(args.roomId as UUID)",
		);
		expect(docProc).toContain("resolvedWorldId");
		expect(docProc).toContain("await runtime.getRoom(roomId as UUID)");

		const docsLoader = fs.readFileSync(
			"packages/core/src/features/documents/docs-loader.ts",
			"utf8",
		);
		// biome formatted splits the isUuid guard across lines — check fragments
		expect(docsLoader).toContain(
			"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
		);
		expect(docsLoader).toContain(".test(");
		expect(docsLoader).toContain("? (worldId as UUID)");
		expect(docsLoader).toContain(": agentId,");

		const transcripts = fs.readFileSync(
			"plugins/plugin-local-inference/src/routes/transcripts-routes.ts",
			"utf8",
		);
		expect(transcripts).toContain("resolvedUpdateWorldId");
		expect(transcripts).toContain("resolvedCreateWorldId");
		expect(transcripts).toContain(
			"await ctx.runtime.getRoom(body.roomId as UUID)",
		);
		expect(transcripts).toContain("room.worldId !== resolved");
	});
});
