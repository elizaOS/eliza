/**
 * Deleting a transcript removes its redacted variant record (redacted
 * segments and any redacted audio URL) together with the original. Runs the
 * real TranscriptStore over an in-memory memory table.
 */
import type { Memory, Transcript, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	TranscriptStore,
	type TranscriptStoreRuntime,
} from "./transcript-store";

const ROOM = "00000000-0000-4000-8000-0000000000a1" as UUID;
const OWNER = "00000000-0000-4000-8000-0000000000a2" as UUID;

function memoryRuntime(): TranscriptStoreRuntime & { rows: Map<UUID, Memory> } {
	const rows = new Map<UUID, Memory>();
	return {
		agentId: "00000000-0000-4000-8000-0000000000a0" as UUID,
		rows,
		async createMemory(memory) {
			const id = (memory.id ?? crypto.randomUUID()) as UUID;
			rows.set(id, { ...memory, id });
			return id;
		},
		async getMemories() {
			return [...rows.values()];
		},
		async getMemoryById(id) {
			return rows.get(id) ?? null;
		},
		async updateMemory(memory) {
			const existing = rows.get(memory.id);
			if (!existing) return false;
			rows.set(memory.id, { ...existing, ...memory } as Memory);
			return true;
		},
		async deleteMemory(id) {
			rows.delete(id);
		},
	};
}

function transcript(): Transcript {
	return {
		id: "00000000-0000-4000-8000-0000000000b1",
		title: "Call with Pat",
		createdAt: 1_760_000_000_000,
		durationMs: 4000,
		audioUrl: "/api/media/original.wav",
		segments: [
			{
				id: "seg-1",
				startMs: 0,
				endMs: 4000,
				text: "My phone number is 555 0100.",
				words: [],
			},
		],
		source: "call",
		scope: "owner-private",
		status: "ready",
		speakerCount: 1,
	};
}

describe("TranscriptStore.delete", () => {
	it("removes the redacted variant with the original transcript", async () => {
		const runtime = memoryRuntime();
		const store = new TranscriptStore(runtime);
		const created = await store.create({
			roomId: ROOM,
			entityId: OWNER,
			transcript: transcript(),
		});
		await store.createRedactedVariant({
			originalId: created.id as UUID,
			seed: "test",
			nowMs: 1_760_000_100_000,
			redactedAudioUrl: "/api/media/redacted.wav",
		});
		expect(runtime.rows.size).toBe(2);

		await store.delete(created.id as UUID);

		expect([...runtime.rows.values()]).toEqual([]);
	});
});
