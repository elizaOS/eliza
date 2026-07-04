/** Covers `TranscriptStore` persistence. Deterministic, temp store. */
import type { Memory, UUID } from "@elizaos/core";
import type { Transcript } from "@elizaos/shared/transcripts";
import { describe, expect, it } from "vitest";
import {
	TRANSCRIPTS_TABLE,
	TranscriptStore,
	type TranscriptStoreRuntime,
} from "./transcript-store";

function makeTranscript(over: Partial<Transcript> = {}): Transcript {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		title: "Standup",
		createdAt: 1000,
		durationMs: 2000,
		audioUrl: "/api/media/x.wav",
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
				text: "hello world",
				words: [{ text: "hello", startMs: 0, endMs: 1000 }],
			},
		],
		...over,
	};
}

/** In-memory fake runtime backing the memory partition. */
function fakeRuntime(): TranscriptStoreRuntime & { rows: Map<string, Memory> } {
	const rows = new Map<string, Memory>();
	const tables = new Map<string, string>();
	return {
		rows,
		agentId: "agent-1" as UUID,
		async createMemory(memory, tableName) {
			const id = memory.id as UUID;
			rows.set(id, memory);
			tables.set(id, tableName);
			return id;
		},
		async getMemories({ tableName, roomId, orderDirection }) {
			let out = [...rows.values()].filter(
				(m) => tables.get(m.id as string) === tableName,
			);
			if (roomId) out = out.filter((m) => m.roomId === roomId);
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
			const existing = rows.get(memory.id);
			if (!existing) return false;
			rows.set(memory.id, { ...existing, ...memory });
			return true;
		},
		async deleteMemory(id) {
			rows.delete(id);
		},
	};
}

const ROOM = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY = "22222222-2222-2222-2222-222222222222" as UUID;

describe("TranscriptStore", () => {
	it("persists into the transcripts partition and round-trips the full record", async () => {
		const rt = fakeRuntime();
		const store = new TranscriptStore(rt);
		const t = makeTranscript();
		await store.create({ roomId: ROOM, entityId: ENTITY, transcript: t });

		// Stored as one memory row with the full transcript in content.transcript.
		const row = rt.rows.get(t.id) as Memory;
		expect(row.roomId).toBe(ROOM);
		expect(row.entityId).toBe(ENTITY);
		expect(row.metadata?.type).toBe("custom");
		expect(row.metadata?.source).toBe("transcript");
		// The full record is stored as a JSON blob in content.transcript.
		expect(typeof (row.content as { transcript: string }).transcript).toBe(
			"string",
		);
		// A text preview body is present for generic memory consumers.
		expect(row.content.text).toBe("hello world");

		// store.get parses the blob back into the exact record.
		const got = await store.get(t.id as UUID);
		expect(got).toEqual(t);
	});

	it("lists newest-first summaries scoped to a room", async () => {
		const rt = fakeRuntime();
		const store = new TranscriptStore(rt);
		await store.create({
			roomId: ROOM,
			entityId: ENTITY,
			transcript: makeTranscript({
				id: "00000000-0000-0000-0000-0000000000aa",
				title: "Older",
				createdAt: 1000,
			}),
		});
		await store.create({
			roomId: ROOM,
			entityId: ENTITY,
			transcript: makeTranscript({
				id: "00000000-0000-0000-0000-0000000000bb",
				title: "Newer",
				createdAt: 2000,
			}),
		});
		// A transcript in a different room must not appear.
		await store.create({
			roomId: "33333333-3333-3333-3333-333333333333" as UUID,
			entityId: ENTITY,
			transcript: makeTranscript({
				id: "00000000-0000-0000-0000-0000000000cc",
				title: "Other room",
				createdAt: 3000,
			}),
		});

		const list = await store.list(ROOM);
		expect(list.map((s) => s.title)).toEqual(["Newer", "Older"]);
		expect(list[0]).toMatchObject({
			durationMs: 2000,
			hasAudio: true,
			status: "ready",
		});
	});

	it("returns null for a missing id and deletes a record", async () => {
		const rt = fakeRuntime();
		const store = new TranscriptStore(rt);
		expect(
			await store.get("deadbeef-0000-0000-0000-000000000000" as UUID),
		).toBeNull();
		const t = makeTranscript();
		await store.create({ roomId: ROOM, entityId: ENTITY, transcript: t });
		await store.delete(t.id as UUID);
		expect(await store.get(t.id as UUID)).toBeNull();
	});

	it("updates a record in place and re-derives the preview + metadata", async () => {
		const rt = fakeRuntime();
		const store = new TranscriptStore(rt);
		const t = makeTranscript();
		await store.create({ roomId: ROOM, entityId: ENTITY, transcript: t });

		const edited: Transcript = {
			...t,
			title: "Standup (edited)",
			segments: [{ ...t.segments[0], text: "hello edited world", words: [] }],
			editedAt: 5000,
		};
		const returned = await store.update(edited);
		expect(returned).toEqual(edited);

		// Same row id, overwritten content + re-derived preview text.
		const row = rt.rows.get(t.id) as Memory;
		expect(rt.rows.size).toBe(1);
		expect(row.content.text).toBe("hello edited world");
		expect(row.metadata?.transcriptId).toBe(t.id);
		// store.get round-trips the edited record exactly.
		expect(await store.get(t.id as UUID)).toEqual(edited);
	});

	it("throws when updating a record that does not exist", async () => {
		const rt = fakeRuntime();
		const store = new TranscriptStore(rt);
		await expect(store.update(makeTranscript())).rejects.toThrow(/not found/);
	});

	it("exposes the partition name", () => {
		expect(TRANSCRIPTS_TABLE).toBe("transcripts");
	});
});
