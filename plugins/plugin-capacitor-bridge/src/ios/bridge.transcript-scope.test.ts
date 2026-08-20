/**
 * Object-scope contract for the transcripts routes.
 *
 * `/api/transcripts/:id` addresses transcripts. GET and PUT already enforce
 * that by refusing an id whose memory is not a transcript, so DELETE must
 * refuse the same ids rather than acting as a delete primitive for the whole
 * memory store.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleDirectCoreRoute, type IosBridgeBackend } from "./bridge.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;

function createFakeRuntime(): IAgentRuntime {
	const tables = new Map<string, Memory[]>();
	return {
		agentId: AGENT_ID,
		character: { name: "TestAgent" },
		async getMemories(params: {
			tableName: string;
			count?: number;
			limit?: number;
		}): Promise<Memory[]> {
			const rows = [...(tables.get(params.tableName) ?? [])];
			rows.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
			const cap = params.count ?? params.limit;
			return typeof cap === "number" ? rows.slice(0, cap) : rows;
		},
		getMemoryById: vi.fn(async (id: UUID): Promise<Memory | null> => {
			for (const rows of tables.values()) {
				const found = rows.find((m) => m.id === id);
				if (found) return found;
			}
			return null;
		}),
		async createMemory(memory: Memory, tableName: string): Promise<UUID> {
			const rows = tables.get(tableName) ?? [];
			rows.push(memory);
			tables.set(tableName, rows);
			return memory.id as UUID;
		},
		deleteMemory: vi.fn(async (id: UUID): Promise<void> => {
			for (const rows of tables.values()) {
				const idx = rows.findIndex((m) => m.id === id);
				if (idx >= 0) rows.splice(idx, 1);
			}
		}),
		updateMemory: vi.fn(async (): Promise<boolean> => true),
	} as unknown as IAgentRuntime;
}

function transcriptMemory(
	id: UUID,
	agentId: UUID = AGENT_ID,
	transcriptId: string = id,
): Memory {
	const transcript = {
		id: transcriptId,
		title: "Scoped transcript",
		createdAt: 1_000,
		durationMs: 10,
		segments: [],
		source: "voice-session",
		scope: "owner-private",
		status: "ready",
		speakerCount: 0,
	};
	return {
		id,
		entityId: agentId,
		roomId: agentId,
		agentId,
		createdAt: transcript.createdAt,
		content: { text: transcript.title, transcript: JSON.stringify(transcript) },
		metadata: {
			type: "custom",
			source: "transcript",
			transcriptId: id,
		},
	};
}

function makeBackend(runtime: IAgentRuntime): IosBridgeBackend {
	return {
		runtime,
		dispatchRoute: async () => null,
		conversations: new Map(),
		close: async () => {},
	};
}

async function call(
	backend: IosBridgeBackend,
	method: string,
	rawPath: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await handleDirectCoreRoute(backend, method, rawPath, {});
	if (!res) throw new Error(`route returned null: ${method} ${rawPath}`);
	return { status: res.status, json: JSON.parse(res.body) };
}

describe("iOS bridge — transcripts route object scope", () => {
	let runtime: IAgentRuntime;
	let backend: IosBridgeBackend;
	const MESSAGE_ID = "00000000-0000-0000-0000-0000000000b1" as UUID;

	beforeEach(async () => {
		runtime = createFakeRuntime();
		backend = makeBackend(runtime);
		// A plain message: not a transcript, addressed by the same id space.
		await runtime.createMemory(
			{
				id: MESSAGE_ID,
				entityId: AGENT_ID,
				roomId: AGENT_ID,
				agentId: AGENT_ID,
				createdAt: 1_000,
				content: { text: "an ordinary message" },
			} as Memory,
			"messages",
		);
	});

	it("GET refuses an id that is not a transcript", async () => {
		const { status } = await call(
			backend,
			"GET",
			`/api/transcripts/${MESSAGE_ID}`,
		);
		expect(status).toBe(404);
	});

	it("DELETE refuses an id that is not a transcript, and does not delete it", async () => {
		const { status } = await call(
			backend,
			"DELETE",
			`/api/transcripts/${MESSAGE_ID}`,
		);
		expect(status).toBe(404);
		// The unrelated memory must survive.
		expect(await runtime.getMemoryById(MESSAGE_ID)).not.toBeNull();
	});

	it("rejects an invalid UUID before the storage adapter", async () => {
		const { status, json } = await call(
			backend,
			"DELETE",
			"/api/transcripts/not-a-uuid",
		);
		expect(status).toBe(400);
		expect(json).toEqual({ error: "invalid transcript id: expected UUID" });
		expect(runtime.getMemoryById).not.toHaveBeenCalled();
		expect(runtime.deleteMemory).not.toHaveBeenCalled();
	});

	it("does not delete another agent's transcript from the global memory id space", async () => {
		const otherAgent = "00000000-0000-0000-0000-0000000000bb" as UUID;
		const otherId = "00000000-0000-0000-0000-0000000000b2" as UUID;
		await runtime.createMemory(
			transcriptMemory(otherId, otherAgent),
			"transcripts",
		);

		const { status } = await call(
			backend,
			"DELETE",
			`/api/transcripts/${otherId}`,
		);
		expect(status).toBe(404);
		expect(await runtime.getMemoryById(otherId)).not.toBeNull();
		expect(runtime.deleteMemory).not.toHaveBeenCalled();
	});

	it("canonicalizes an uppercase UUID before lookup and object authorization", async () => {
		const transcriptId = "00000000-0000-0000-0000-0000000000bc" as UUID;
		await runtime.createMemory(transcriptMemory(transcriptId), "transcripts");

		const { status, json } = await call(
			backend,
			"GET",
			`/api/transcripts/${transcriptId.toUpperCase()}`,
		);
		expect(status).toBe(200);
		expect(json).toEqual(
			expect.objectContaining({
				transcript: expect.objectContaining({ id: transcriptId }),
			}),
		);
		expect(runtime.getMemoryById).toHaveBeenCalledWith(transcriptId);
	});

	it("does not treat transcript-shaped content in another memory table as a transcript", async () => {
		const spoofId = "00000000-0000-0000-0000-0000000000b3" as UUID;
		const spoof = transcriptMemory(spoofId);
		delete spoof.metadata;
		await runtime.createMemory(spoof, "messages");

		const { status } = await call(
			backend,
			"DELETE",
			`/api/transcripts/${spoofId}`,
		);
		expect(status).toBe(404);
		expect(await runtime.getMemoryById(spoofId)).not.toBeNull();
		expect(runtime.deleteMemory).not.toHaveBeenCalled();
	});

	it("rejects transcript metadata whose embedded transcript id does not match", async () => {
		const rowId = "00000000-0000-0000-0000-0000000000b4" as UUID;
		await runtime.createMemory(
			transcriptMemory(rowId, AGENT_ID, "00000000-0000-0000-0000-0000000000ff"),
			"transcripts",
		);

		const { status } = await call(
			backend,
			"DELETE",
			`/api/transcripts/${rowId}`,
		);
		expect(status).toBe(404);
		expect(await runtime.getMemoryById(rowId)).not.toBeNull();
		expect(runtime.deleteMemory).not.toHaveBeenCalled();
	});

	it("rejects transcript metadata whose persisted id does not match the row", async () => {
		const rowId = "00000000-0000-0000-0000-0000000000b6" as UUID;
		const row = transcriptMemory(rowId);
		if (!row.metadata) throw new Error("test transcript metadata missing");
		row.metadata.transcriptId = "00000000-0000-0000-0000-0000000000ff";
		await runtime.createMemory(row, "transcripts");

		const { status } = await call(
			backend,
			"DELETE",
			`/api/transcripts/${rowId}`,
		);
		expect(status).toBe(404);
		expect(await runtime.getMemoryById(rowId)).not.toBeNull();
		expect(runtime.deleteMemory).not.toHaveBeenCalled();
	});

	it("revalidates scope immediately before the generic id-only delete", async () => {
		const replacementId = "00000000-0000-0000-0000-0000000000b5" as UUID;
		await runtime.createMemory(transcriptMemory(replacementId), "transcripts");
		const getMemoryById = runtime.getMemoryById.bind(runtime);
		let reads = 0;
		runtime.getMemoryById = vi.fn(async (id: UUID) => {
			reads += 1;
			if (reads === 2) {
				await runtime.deleteMemory(id);
				const replacement = transcriptMemory(id);
				delete replacement.metadata;
				await runtime.createMemory(replacement, "messages");
			}
			return getMemoryById(id);
		});

		const { status } = await call(
			backend,
			"DELETE",
			`/api/transcripts/${replacementId}`,
		);
		expect(status).toBe(404);
		expect(await getMemoryById(replacementId)).not.toBeNull();
	});

	it("revalidates scope immediately before the generic id-only update", async () => {
		const replacementId = "00000000-0000-0000-0000-0000000000b7" as UUID;
		await runtime.createMemory(transcriptMemory(replacementId), "transcripts");
		const getMemoryById = runtime.getMemoryById.bind(runtime);
		let reads = 0;
		runtime.getMemoryById = vi.fn(async (id: UUID) => {
			reads += 1;
			if (reads === 2) {
				await runtime.deleteMemory(id);
				const replacement = transcriptMemory(id);
				delete replacement.metadata;
				await runtime.createMemory(replacement, "messages");
			}
			return getMemoryById(id);
		});

		const result = await handleDirectCoreRoute(
			backend,
			"PUT",
			`/api/transcripts/${replacementId}`,
			{ body: JSON.stringify({ title: "must not overwrite replacement" }) },
		);
		if (!result) throw new Error("update returned null");
		expect(result.status).toBe(404);
		expect(await getMemoryById(replacementId)).not.toBeNull();
		expect(runtime.updateMemory).not.toHaveBeenCalled();
	});

	it("DELETE still removes a real transcript", async () => {
		const created = await handleDirectCoreRoute(
			backend,
			"POST",
			"/api/transcripts",
			{
				body: JSON.stringify({
					segments: [
						{
							id: "s1",
							speakerLabel: "Speaker 1",
							startMs: 0,
							endMs: 10,
							text: "hello",
							words: [],
						},
					],
				}),
			},
		);
		if (!created) throw new Error("create returned null");
		const id = (JSON.parse(created.body) as { transcript: { id: string } })
			.transcript.id;

		const { status } = await call(backend, "DELETE", `/api/transcripts/${id}`);
		expect(status).toBe(200);
		expect(await runtime.getMemoryById(id as UUID)).toBeNull();
	});
});
