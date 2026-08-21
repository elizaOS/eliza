/** Exercises malformed iOS transcript identifiers across read, update, and delete routes. */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import type { TranscriptSegment } from "@elizaos/shared/transcripts";
import { describe, expect, it } from "vitest";
import { handleDirectCoreRoute, type IosBridgeBackend } from "./bridge.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;

function createFakeRuntime(): IAgentRuntime {
	const tables = new Map<string, Memory[]>();
	return {
		agentId: AGENT_ID,
		character: { name: "TestAgent" },
		async getMemories(params: {
			tableName: string;
			roomId?: UUID;
			limit?: number;
			count?: number;
		}): Promise<Memory[]> {
			let rows = [...(tables.get(params.tableName) ?? [])];
			if (params.roomId) {
				rows = rows.filter((m) => m.roomId === params.roomId);
			}
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
		async updateMemory(): Promise<boolean> {
			throw new Error("updateMemory must not run on malformed encoding");
		},
		async deleteMemory(): Promise<void> {
			throw new Error("deleteMemory must not run on malformed encoding");
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
	body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
	const res = await handleDirectCoreRoute(
		backend,
		method,
		rawPath,
		body === undefined ? {} : { body: JSON.stringify(body) },
	);
	if (!res) throw new Error(`route returned null: ${method} ${rawPath}`);
	return { status: res.status, json: JSON.parse(res.body) };
}

const seg = (text: string, endMs = 1000): TranscriptSegment => ({
	id: `seg-${Math.random().toString(36).slice(2)}`,
	speakerLabel: "Speaker 1",
	startMs: 0,
	endMs,
	text,
	words: [],
});

describe("iOS /api/transcripts/:id encoding", () => {
	it("GET /api/transcripts list is untouched", async () => {
		const backend = makeBackend(createFakeRuntime());
		const { status, json } = await call(backend, "GET", "/api/transcripts");
		expect(status).toBe(200);
		expect(json).toEqual({ transcripts: [] });
	});

	it("POST /api/transcripts create is untouched", async () => {
		const backend = makeBackend(createFakeRuntime());
		const { status, json } = await call(backend, "POST", "/api/transcripts", {
			title: "Standup",
			segments: [seg("hello", 1500)],
		});
		expect(status).toBe(201);
		expect(json.transcript).toMatchObject({
			title: "Standup",
			status: "ready",
			durationMs: 1500,
		});
	});

	it("canonical percent-encoded id still reaches transcript lookup", async () => {
		const runtime = createFakeRuntime();
		const seen: string[] = [];
		runtime.getMemoryById = async (id: UUID) => {
			seen.push(id);
			return null;
		};
		const backend = makeBackend(runtime);
		const id = "00000000-0000-0000-0000-0000000000c1";
		const { status, json } = await call(
			backend,
			"GET",
			`/api/transcripts/${id.replaceAll("-", "%2D")}`,
		);
		expect(seen).toEqual([id]);
		expect(status).toBe(404);
		expect(json).toEqual({ error: "not found" });
	});

	it.each(["%", "%2", "%ZZ", "%E0%A4"])(
		"rejects malformed %s with 400 before transcript lookup",
		async (token) => {
			const runtime = createFakeRuntime();
			runtime.getMemoryById = async () => {
				throw new Error("getMemoryById must not run on malformed encoding");
			};
			const backend = makeBackend(runtime);
			for (const method of ["GET", "PUT", "DELETE"] as const) {
				const { status, json } = await call(
					backend,
					method,
					`/api/transcripts/${token}`,
					method === "PUT" ? { title: "x" } : undefined,
				);
				expect(status).toBe(400);
				expect(json).toEqual({
					error: "invalid transcript id: malformed URL encoding",
				});
			}
		},
	);
});
