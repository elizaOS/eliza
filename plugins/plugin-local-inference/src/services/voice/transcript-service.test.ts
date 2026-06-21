import type { Memory, UUID } from "@elizaos/core";
import type { Transcript } from "@elizaos/shared/transcripts";
import { describe, expect, it, vi } from "vitest";
import {
	type CreateTranscriptInput,
	TranscriptService,
	type TranscriptServiceRuntime,
} from "./transcript-service";

const WORLD = "00000000-0000-0000-0000-0000000000ww" as UUID;
const ROOM = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY = "22222222-2222-2222-2222-222222222222" as UUID;

function makeTranscript(): Transcript {
	return {
		id: "aaaaaaaa-0000-0000-0000-000000000001",
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
				text: "hi",
				words: [],
			},
		],
	};
}

function fakeRuntime(opts: {
	withDocuments: boolean;
}): TranscriptServiceRuntime & {
	rows: Map<string, Memory>;
	addDocument: ReturnType<typeof vi.fn>;
} {
	const rows = new Map<string, Memory>();
	const addDocument = vi.fn(async () => ({
		storedDocumentMemoryId: "dddddddd-0000-0000-0000-000000000001" as UUID,
	}));
	return {
		rows,
		addDocument,
		agentId: "agent-1" as UUID,
		async createMemory(memory) {
			rows.set(memory.id as string, memory);
			return memory.id as UUID;
		},
		async getMemories() {
			return [...rows.values()];
		},
		async getMemoryById(id) {
			return rows.get(id) ?? null;
		},
		async deleteMemory(id) {
			rows.delete(id);
		},
		getService<T>(name: string): T | null {
			if (name === "documents" && opts.withDocuments) {
				return { addDocument } as unknown as T;
			}
			return null;
		},
	};
}

const input = (transcript: Transcript): CreateTranscriptInput => ({
	worldId: WORLD,
	roomId: ROOM,
	entityId: ENTITY,
	transcript,
});

describe("TranscriptService", () => {
	it("mirrors the transcript into knowledge and links the document id", async () => {
		const rt = fakeRuntime({ withDocuments: true });
		const svc = new TranscriptService(rt);
		const t = makeTranscript();
		const saved = await svc.create(input(t));

		// Mirror called with the searchable text + transcript link metadata.
		expect(rt.addDocument).toHaveBeenCalledTimes(1);
		const opts = rt.addDocument.mock.calls[0][0];
		expect(opts.content).toBe("Alice: hi");
		expect(opts.scope).toBe("owner-private");
		expect(opts.clientDocumentId).toBe(t.id);
		expect((opts.metadata as { transcriptId: string }).transcriptId).toBe(t.id);

		// The stored record carries the knowledge link.
		expect(saved.knowledgeDocumentId).toBe(
			"dddddddd-0000-0000-0000-000000000001",
		);
		const got = await svc.get(t.id as UUID);
		expect(got?.knowledgeDocumentId).toBe(
			"dddddddd-0000-0000-0000-000000000001",
		);
	});

	it("still persists the record when no documents service is loaded", async () => {
		const rt = fakeRuntime({ withDocuments: false });
		const svc = new TranscriptService(rt);
		const t = makeTranscript();
		const saved = await svc.create(input(t));
		expect(rt.addDocument).not.toHaveBeenCalled();
		expect(saved.knowledgeDocumentId).toBeUndefined();
		expect(await svc.get(t.id as UUID)).toEqual(t);
	});

	it("persists the record even if the mirror throws (recording is never lost)", async () => {
		const rt = fakeRuntime({ withDocuments: true });
		rt.addDocument.mockRejectedValueOnce(new Error("docs down"));
		const svc = new TranscriptService(rt);
		const t = makeTranscript();
		const saved = await svc.create(input(t));
		expect(saved.knowledgeDocumentId).toBeUndefined();
		expect(await svc.get(t.id as UUID)).not.toBeNull();
	});

	it("removes the knowledge mirror on delete", async () => {
		const rt = fakeRuntime({ withDocuments: true });
		const svc = new TranscriptService(rt);
		const t = makeTranscript();
		await svc.create(input(t));
		const docId = "dddddddd-0000-0000-0000-000000000001";
		rt.rows.set(docId, { id: docId } as Memory); // stand-in for the doc row
		await svc.delete(t.id as UUID);
		expect(rt.rows.has(t.id)).toBe(false);
		expect(rt.rows.has(docId)).toBe(false);
	});
});
