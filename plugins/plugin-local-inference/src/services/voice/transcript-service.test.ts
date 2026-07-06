/** Covers `TranscriptService` transcript lifecycle. Deterministic. */
import type { AccessContext, Memory, UUID } from "@elizaos/core";
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
const OTHER_ENTITY = "33333333-3333-3333-3333-333333333333" as UUID;

function makeTranscript(over: Partial<Transcript> = {}): Transcript {
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
		...over,
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
		async updateMemory(memory) {
			const existing = rows.get(memory.id);
			if (!existing) return false;
			rows.set(memory.id, { ...existing, ...memory });
			return true;
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

const access = (
	requesterEntityId: UUID,
	role: AccessContext["role"] = "USER",
): AccessContext => ({
	requesterEntityId,
	worldId: WORLD,
	role,
	isOwner: role === "OWNER",
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

	it("applies an edit, re-derives metadata, and re-mirrors to knowledge", async () => {
		const rt = fakeRuntime({ withDocuments: true });
		const svc = new TranscriptService(rt);
		const t = makeTranscript();
		await svc.create(input(t));
		const firstDocId = "dddddddd-0000-0000-0000-000000000001";
		rt.rows.set(firstDocId, { id: firstDocId } as Memory); // the create mirror row
		rt.addDocument.mockClear();
		rt.addDocument.mockResolvedValueOnce({
			storedDocumentMemoryId: "dddddddd-0000-0000-0000-000000000002" as UUID,
		});

		const updated = await svc.update(t.id as UUID, {
			worldId: WORLD,
			roomId: ROOM,
			entityId: ENTITY,
			patch: {
				title: "Edited title",
				segments: [
					{ ...t.segments[0], text: "corrected words here", words: [] },
				],
			},
		});

		expect(updated?.title).toBe("Edited title");
		expect(updated?.editedAt).toBeGreaterThan(0);
		expect(updated?.segments[0].text).toBe("corrected words here");
		// Re-mirrored: the stale doc was removed and a fresh one created + linked.
		expect(rt.rows.has(firstDocId)).toBe(false);
		expect(rt.addDocument).toHaveBeenCalledTimes(1);
		expect(updated?.knowledgeDocumentId).toBe(
			"dddddddd-0000-0000-0000-000000000002",
		);
		// The store now round-trips the edited record.
		expect((await svc.get(t.id as UUID))?.title).toBe("Edited title");
	});

	it("returns null when updating a transcript that does not exist", async () => {
		const rt = fakeRuntime({ withDocuments: true });
		const svc = new TranscriptService(rt);
		const result = await svc.update(
			"99999999-0000-0000-0000-000000000000" as UUID,
			{
				worldId: WORLD,
				roomId: ROOM,
				entityId: ENTITY,
				patch: { title: "nope" },
			},
		);
		expect(result).toBeNull();
	});

	it("filters list/get by transcript scope when a requester context is supplied", async () => {
		const rt = fakeRuntime({ withDocuments: false });
		const svc = new TranscriptService(rt);
		const records = [
			makeTranscript({
				id: "aaaaaaaa-0000-0000-0000-0000000000a1",
				title: "Owner private",
				scope: "owner-private",
			}),
			makeTranscript({
				id: "aaaaaaaa-0000-0000-0000-0000000000a2",
				title: "Agent private",
				scope: "agent-private",
			}),
			makeTranscript({
				id: "aaaaaaaa-0000-0000-0000-0000000000a3",
				title: "Global",
				scope: "global",
			}),
			makeTranscript({
				id: "aaaaaaaa-0000-0000-0000-0000000000a4",
				title: "User owned",
				scope: "user-private",
			}),
			makeTranscript({
				id: "aaaaaaaa-0000-0000-0000-0000000000a5",
				title: "Other user",
				scope: "user-private",
			}),
		];
		for (const record of records.slice(0, 4)) {
			await svc.create(input(record));
		}
		await svc.create({
			worldId: WORLD,
			roomId: ROOM,
			entityId: OTHER_ENTITY,
			transcript: records[4],
		});

		expect((await svc.list(ROOM)).map((t) => t.title).sort()).toEqual([
			"Agent private",
			"Global",
			"Other user",
			"Owner private",
			"User owned",
		]);
		expect(
			(await svc.list(ROOM, undefined, access(ENTITY)))
				.map((t) => t.title)
				.sort(),
		).toEqual(["Global", "User owned"]);
		expect(
			(await svc.list(ROOM, undefined, access(OTHER_ENTITY)))
				.map((t) => t.title)
				.sort(),
		).toEqual(["Global", "Other user"]);
		expect(
			(await svc.list(ROOM, undefined, access("owner" as UUID, "OWNER"))).map(
				(t) => t.title,
			),
		).toHaveLength(5);
		expect(
			(await svc.list(ROOM, undefined, access(rt.agentId, "USER"))).map(
				(t) => t.title,
			),
		).toHaveLength(5);

		expect(await svc.get(records[0].id as UUID, access(ENTITY))).toBeNull();
		expect((await svc.get(records[3].id as UUID, access(ENTITY)))?.title).toBe(
			"User owned",
		);
	});
});
