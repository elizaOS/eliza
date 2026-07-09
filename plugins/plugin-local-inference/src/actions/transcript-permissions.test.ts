/**
 * Exercises transcript redaction/share actions through the real TranscriptStore
 * metadata writes. The harness is in-memory, but role resolution uses normal
 * room/world metadata so owner and admin paths match runtime authorization.
 */
import type { Memory, UUID, World } from "@elizaos/core";
import type { Transcript } from "@elizaos/shared/transcripts";
import { describe, expect, it, vi } from "vitest";
import {
	TRANSCRIPTS_TABLE,
	TranscriptStore,
	type TranscriptStoreRuntime,
} from "../services/voice/transcript-store";
import {
	redactTranscriptAction,
	shareTranscriptAction,
} from "./transcript-permissions";

const ROOM = "11111111-1111-1111-1111-111111111111" as UUID;
const WORLD = "22222222-2222-2222-2222-222222222222" as UUID;
const OWNER = "33333333-3333-3333-3333-333333333333" as UUID;
const ADMIN = "44444444-4444-4444-4444-444444444444" as UUID;
const STRANGER = "55555555-5555-5555-5555-555555555555" as UUID;
const TARGET = "66666666-6666-6666-6666-666666666666" as UUID;
const TRANSCRIPT_ID = "77777777-7777-7777-7777-777777777777" as UUID;

type TestRuntime = TranscriptStoreRuntime & {
	rows: Map<string, Memory>;
	getRoom: (roomId: UUID) => Promise<{ id: UUID; worldId: UUID } | null>;
	getWorld: (worldId: UUID) => Promise<World | null>;
	getSetting: (key: string) => string | undefined;
	getRelationships: () => Promise<[]>;
	getEntityById: () => Promise<null>;
	reportError: ReturnType<typeof vi.fn>;
};

function makeTranscript(over: Partial<Transcript> = {}): Transcript {
	return {
		id: TRANSCRIPT_ID,
		title: "Payroll sync",
		createdAt: 1000,
		durationMs: 2000,
		audioUrl: "/api/media/payroll.wav",
		audioContentType: "audio/wav",
		source: "voice-session",
		scope: "owner-private",
		status: "ready",
		speakerCount: 1,
		segments: [
			{
				id: "s1",
				speakerLabel: "Alice",
				startMs: 0,
				endMs: 2000,
				text: "Bob's SSN is 123-45-6789",
				words: [{ text: "123-45-6789", startMs: 1000, endMs: 1500 }],
			},
		],
		...over,
	};
}

function makeRuntime(): TestRuntime {
	const rows = new Map<string, Memory>();
	const tables = new Map<string, string>();
	return {
		rows,
		agentId: "99999999-9999-9999-9999-999999999999" as UUID,
		async createMemory(memory, tableName) {
			const id = memory.id as UUID;
			rows.set(id, memory);
			tables.set(id, tableName);
			return id;
		},
		async getMemories({ tableName, roomId, orderDirection }) {
			let out = [...rows.values()].filter(
				(row) => tables.get(row.id as string) === tableName,
			);
			if (roomId) out = out.filter((row) => row.roomId === roomId);
			out.sort((a, b) =>
				orderDirection === "asc"
					? (a.createdAt ?? 0) - (b.createdAt ?? 0)
					: (b.createdAt ?? 0) - (a.createdAt ?? 0),
			);
			return out;
		},
		async getMemoryById(id) {
			return rows.get(id) ?? null;
		},
		async updateMemory(memory) {
			const id = memory.id as string;
			const existing = rows.get(id);
			if (!existing) return false;
			rows.set(id, { ...existing, ...memory });
			return true;
		},
		async deleteMemory(id) {
			rows.delete(id);
			tables.delete(id);
		},
		async getRoom(roomId) {
			return roomId === ROOM ? { id: ROOM, worldId: WORLD } : null;
		},
		async getWorld(worldId) {
			if (worldId !== WORLD) return null;
			return {
				id: WORLD,
				name: "Test world",
				agentId: "99999999-9999-9999-9999-999999999999" as UUID,
				serverId: WORLD,
				metadata: {
					roles: { [ADMIN]: "ADMIN" },
					roleSources: { [ADMIN]: "manual" },
				},
			} as World;
		},
		getSetting() {
			return undefined;
		},
		async getRelationships() {
			return [];
		},
		async getEntityById() {
			return null;
		},
		reportError: vi.fn(),
	};
}

function message(entityId: UUID): Memory {
	return {
		id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as UUID,
		entityId,
		roomId: ROOM,
		agentId: "99999999-9999-9999-9999-999999999999" as UUID,
		content: { text: "manage transcript" },
	} as Memory;
}

async function seed(runtime: TestRuntime, entityId: UUID = OWNER) {
	const store = new TranscriptStore(runtime);
	const transcript = makeTranscript();
	await store.create({ roomId: ROOM, entityId, transcript });
	return { store, transcript };
}

function shareGrants(row: Memory): Array<Record<string, unknown>> {
	const share = (row.metadata as Record<string, unknown> | undefined)?.share as
		| { grants?: Array<Record<string, unknown>> }
		| undefined;
	return share?.grants ?? [];
}

describe("transcript permission actions", () => {
	it("lets the transcript owner create a redacted variant without mutating audio", async () => {
		const runtime = makeRuntime();
		await seed(runtime);
		const callback = vi.fn(async () => []);

		const result = await redactTranscriptAction.handler(
			runtime,
			message(OWNER),
			undefined,
			{ transcriptId: TRANSCRIPT_ID },
			callback,
		);

		expect(result?.success).toBe(true);
		const originalRow = runtime.rows.get(TRANSCRIPT_ID) as Memory;
		const variantId = (originalRow.metadata as Record<string, unknown>)
			.redactedVariantId as string;
		expect(variantId).toBeTruthy();
		const original = await new TranscriptStore(runtime).get(TRANSCRIPT_ID);
		const variant = await new TranscriptStore(runtime).get(variantId as UUID);
		expect(original?.audioUrl).toBe("/api/media/payroll.wav");
		expect(variant?.audioUrl).toBeUndefined();
		expect(variant?.segments[0]?.text).toBe("Bob's SSN is [SSN]");
		expect(callback).toHaveBeenCalledWith({
			text: "Created a redacted transcript variant.",
			actions: ["REDACT_TRANSCRIPT_SUCCESS"],
		});
	});

	it("denies redaction for a non-owner without admin role", async () => {
		const runtime = makeRuntime();
		await seed(runtime);

		const result = await redactTranscriptAction.handler(
			runtime,
			message(STRANGER),
			undefined,
			{ transcriptId: TRANSCRIPT_ID },
			vi.fn(async () => []),
		);

		expect(result?.success).toBe(false);
		const originalRow = runtime.rows.get(TRANSCRIPT_ID) as Memory;
		expect(
			(originalRow.metadata as Record<string, unknown>).redactedVariantId,
		).toBeUndefined();
		expect(runtime.reportError).not.toHaveBeenCalled();
	});

	it("lets the owner share only the redacted transcript by default", async () => {
		const runtime = makeRuntime();
		await seed(runtime);

		const result = await shareTranscriptAction.handler(
			runtime,
			message(OWNER),
			undefined,
			{ transcriptId: TRANSCRIPT_ID, entityId: TARGET },
			vi.fn(async () => []),
		);

		expect(result?.success).toBe(true);
		const originalRow = runtime.rows.get(TRANSCRIPT_ID) as Memory;
		expect(
			(originalRow.metadata as Record<string, unknown>).redactedVariantId,
		).toBeTruthy();
		expect(shareGrants(originalRow)).toMatchObject([
			{ entityId: TARGET, mode: "redacted", grantedBy: OWNER },
		]);
	});

	it("denies full transcript sharing by a non-admin owner", async () => {
		const runtime = makeRuntime();
		await seed(runtime);

		const result = await shareTranscriptAction.handler(
			runtime,
			message(OWNER),
			undefined,
			{ transcriptId: TRANSCRIPT_ID, entityId: TARGET, mode: "full" },
			vi.fn(async () => []),
		);

		expect(result?.success).toBe(false);
		const originalRow = runtime.rows.get(TRANSCRIPT_ID) as Memory;
		expect(shareGrants(originalRow)).toEqual([]);
		expect(runtime.reportError).not.toHaveBeenCalled();
	});

	it("lets an admin grant full access to another entity's transcript", async () => {
		const runtime = makeRuntime();
		await seed(runtime, OWNER);

		const result = await shareTranscriptAction.handler(
			runtime,
			message(ADMIN),
			undefined,
			{ transcriptId: TRANSCRIPT_ID, entityId: TARGET, mode: "full" },
			vi.fn(async () => []),
		);

		expect(result?.success).toBe(true);
		const originalRow = runtime.rows.get(TRANSCRIPT_ID) as Memory;
		expect(shareGrants(originalRow)).toMatchObject([
			{ entityId: TARGET, mode: "full", grantedBy: ADMIN },
		]);
	});

	it("registers the action writes in the transcript memory partition", async () => {
		const runtime = makeRuntime();
		await seed(runtime);
		await shareTranscriptAction.handler(
			runtime,
			message(OWNER),
			undefined,
			{ transcriptId: TRANSCRIPT_ID, entityId: TARGET },
			vi.fn(async () => []),
		);

		const rows = await runtime.getMemories({ tableName: TRANSCRIPTS_TABLE });
		expect(rows).toHaveLength(2);
		expect(rows.every((row) => row.metadata?.source === "transcript")).toBe(
			true,
		);
	});
});
