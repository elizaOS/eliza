/**
 * Object-scope contract for the transcripts routes.
 *
 * `/api/transcripts/:id` addresses transcripts. GET and PUT already enforce
 * that by refusing an id whose memory is not a transcript, so DELETE must
 * refuse the same ids rather than acting as a delete primitive for the whole
 * memory store.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
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
		async getMemoryById(id: UUID): Promise<Memory | null> {
			for (const rows of tables.values()) {
				const found = rows.find((m) => m.id === id);
				if (found) return found;
			}
			return null;
		},
		async createMemory(memory: Memory, tableName: string): Promise<UUID> {
			const rows = tables.get(tableName) ?? [];
			rows.push(memory);
			tables.set(tableName, rows);
			return memory.id as UUID;
		},
		async deleteMemory(id: UUID): Promise<void> {
			for (const rows of tables.values()) {
				const idx = rows.findIndex((m) => m.id === id);
				if (idx >= 0) rows.splice(idx, 1);
			}
		},
		async updateMemory(): Promise<boolean> {
			return true;
		},
	} as unknown as IAgentRuntime;
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
