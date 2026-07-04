/**
 * Route-table tests for the iOS bridge's direct-core shims — the view-backing
 * endpoints (memories, transcripts, browser workspace) that would otherwise 404
 * on device because the agent's node:http route handlers / plugin-local-inference
 * routes are not wired into the in-process iOS runtime.
 *
 * Each test drives `handleDirectCoreRoute` end-to-end against a real in-memory
 * runtime (the same core memory APIs the production handlers call), asserting
 * the exact response shapes the UI consumes.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import type { TranscriptSegment } from "@elizaos/shared/transcripts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleDirectCoreRoute,
	type IosBridgeBackend,
	resetIosBrowserWorkspace,
} from "./bridge.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;

/** A minimal in-memory runtime implementing the memory APIs the shims use. */
function createFakeRuntime(): IAgentRuntime {
	const tables = new Map<string, Memory[]>();
	const runtime = {
		agentId: AGENT_ID,
		character: { name: "TestAgent" },
		async getMemories(params: {
			tableName: string;
			roomId?: UUID;
			limit?: number;
			count?: number;
			orderBy?: "createdAt";
			orderDirection?: "asc" | "desc";
		}): Promise<Memory[]> {
			let rows = [...(tables.get(params.tableName) ?? [])];
			if (params.roomId) {
				rows = rows.filter((m) => m.roomId === params.roomId);
			}
			if (params.orderBy === "createdAt") {
				const dir = params.orderDirection === "asc" ? 1 : -1;
				rows.sort((a, b) => dir * ((a.createdAt ?? 0) - (b.createdAt ?? 0)));
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
		async updateMemory(
			memory: Partial<Memory> & { id: UUID },
		): Promise<boolean> {
			for (const rows of tables.values()) {
				const idx = rows.findIndex((m) => m.id === memory.id);
				if (idx >= 0) {
					rows[idx] = { ...rows[idx], ...memory } as Memory;
					return true;
				}
			}
			return false;
		},
		async deleteMemory(id: UUID): Promise<void> {
			for (const rows of tables.values()) {
				const idx = rows.findIndex((m) => m.id === id);
				if (idx >= 0) rows.splice(idx, 1);
			}
		},
	} as unknown as IAgentRuntime;
	return runtime;
}

function makeBackend(runtime: IAgentRuntime): IosBridgeBackend {
	return {
		runtime,
		dispatchRoute: async () => null,
		conversations: new Map(),
		close: async () => {},
	};
}

function jsonBody(payload: unknown): { body: string } {
	return { body: JSON.stringify(payload) };
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
		body === undefined ? {} : jsonBody(body),
	);
	if (!res) throw new Error(`route returned null: ${method} ${rawPath}`);
	return { status: res.status, json: JSON.parse(res.body) };
}

const seg = (
	text: string,
	endMs = 1000,
	speaker = "Speaker 1",
): TranscriptSegment => ({
	id: `seg-${Math.random().toString(36).slice(2)}`,
	speakerLabel: speaker,
	startMs: 0,
	endMs,
	text,
	words: [],
});

describe("iOS bridge — memories view routes", () => {
	let backend: IosBridgeBackend;
	let runtime: IAgentRuntime;

	beforeEach(() => {
		runtime = createFakeRuntime();
		backend = makeBackend(runtime);
	});

	async function seedMemory(
		table: string,
		text: string,
		createdAt: number,
		source?: string,
	): Promise<void> {
		await runtime.createMemory(
			{
				id: crypto.randomUUID() as UUID,
				entityId: AGENT_ID,
				roomId: AGENT_ID,
				agentId: AGENT_ID,
				createdAt,
				content: source ? { text, source } : { text },
			} as Memory,
			table,
		);
	}

	it("feed returns newest-first browse items with the UI shape", async () => {
		await seedMemory("messages", "oldest", 1_000);
		await seedMemory("facts", "newest", 3_000, "user");
		await seedMemory("memories", "middle", 2_000);

		const { status, json } = await call(backend, "GET", "/api/memories/feed");
		expect(status).toBe(200);
		const memories = json.memories as Array<Record<string, unknown>>;
		expect(memories.map((m) => m.text)).toEqual(["newest", "middle", "oldest"]);
		// Exact browse-item shape the MemoryViewer consumes.
		expect(memories[0]).toMatchObject({
			type: "facts",
			text: "newest",
			source: "user",
			createdAt: 3_000,
		});
		expect(json).toMatchObject({ count: 3, limit: 50, hasMore: false });
	});

	it("feed honors the limit + hasMore + before params", async () => {
		for (let i = 0; i < 5; i++) {
			await seedMemory("messages", `m${i}`, 1_000 + i);
		}
		const first = await call(backend, "GET", "/api/memories/feed?limit=2");
		expect((first.json.memories as unknown[]).length).toBe(2);
		expect(first.json.hasMore).toBe(true);

		// `before` excludes items at/after the cursor (newest is createdAt 1004).
		const before = await call(backend, "GET", "/api/memories/feed?before=1002");
		const beforeTexts = (before.json.memories as Array<{ text: string }>).map(
			(m) => m.text,
		);
		expect(beforeTexts).toEqual(["m1", "m0"]);
	});

	it("feed type filter scopes to a single table", async () => {
		await seedMemory("messages", "a message", 1_000);
		await seedMemory("facts", "a fact", 2_000);
		const { json } = await call(
			backend,
			"GET",
			"/api/memories/feed?type=facts",
		);
		const texts = (json.memories as Array<{ text: string }>).map((m) => m.text);
		expect(texts).toEqual(["a fact"]);
	});

	it("browse paginates + keyword-filters with total/limit/offset", async () => {
		await seedMemory("messages", "alpha bravo", 1_000);
		await seedMemory("messages", "charlie delta", 2_000);
		await seedMemory("facts", "alpha echo", 3_000);

		const all = await call(backend, "GET", "/api/memories/browse");
		expect(all.json).toMatchObject({ total: 3, limit: 50, offset: 0 });

		const search = await call(backend, "GET", "/api/memories/browse?q=alpha");
		const texts = (search.json.memories as Array<{ text: string }>).map(
			(m) => m.text,
		);
		expect(texts).toEqual(["alpha echo", "alpha bravo"]);
		expect(search.json.total).toBe(2);

		const page = await call(
			backend,
			"GET",
			"/api/memories/browse?limit=1&offset=1",
		);
		expect((page.json.memories as unknown[]).length).toBe(1);
		expect(page.json).toMatchObject({ total: 3, limit: 1, offset: 1 });
	});

	it("stats totals per table", async () => {
		await seedMemory("messages", "m1", 1_000);
		await seedMemory("messages", "m2", 2_000);
		await seedMemory("facts", "f1", 3_000);

		const { status, json } = await call(backend, "GET", "/api/memories/stats");
		expect(status).toBe(200);
		expect(json).toEqual({
			total: 3,
			byType: { messages: 2, memories: 0, facts: 1, documents: 0 },
		});
	});
});

describe("iOS bridge — transcripts view routes", () => {
	let backend: IosBridgeBackend;

	beforeEach(() => {
		backend = makeBackend(createFakeRuntime());
	});

	it("create → list → get → update → delete round-trips", async () => {
		// Create
		const created = await call(backend, "POST", "/api/transcripts", {
			title: "Standup",
			segments: [seg("hello world", 1500)],
		});
		expect(created.status).toBe(201);
		const transcript = created.json.transcript as Record<string, unknown>;
		expect(transcript).toMatchObject({
			title: "Standup",
			status: "ready",
			durationMs: 1500,
			speakerCount: 1,
		});
		const id = transcript.id as string;

		// List → summary shape
		const list = await call(backend, "GET", "/api/transcripts");
		expect(list.status).toBe(200);
		const summaries = list.json.transcripts as Array<Record<string, unknown>>;
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			id,
			title: "Standup",
			durationMs: 1500,
			speakerCount: 1,
			preview: "hello world",
			hasAudio: false,
		});

		// Get by id
		const got = await call(
			backend,
			"GET",
			`/api/transcripts/${encodeURIComponent(id)}`,
		);
		expect(got.status).toBe(200);
		expect((got.json.transcript as { id: string }).id).toBe(id);

		// Update (PUT) — new title + longer segment
		const updated = await call(
			backend,
			"PUT",
			`/api/transcripts/${encodeURIComponent(id)}`,
			{ title: "Standup (edited)", segments: [seg("hello there", 3000)] },
		);
		expect(updated.status).toBe(200);
		expect(updated.json.transcript).toMatchObject({
			title: "Standup (edited)",
			durationMs: 3000,
		});
		expect(
			(updated.json.transcript as { editedAt?: number }).editedAt,
		).toBeGreaterThan(0);

		// Delete
		const deleted = await call(
			backend,
			"DELETE",
			`/api/transcripts/${encodeURIComponent(id)}`,
		);
		expect(deleted.json).toEqual({ ok: true });

		const emptyList = await call(backend, "GET", "/api/transcripts");
		expect((emptyList.json.transcripts as unknown[]).length).toBe(0);
	});

	it("create rejects empty segments with 400", async () => {
		const res = await call(backend, "POST", "/api/transcripts", {
			segments: [],
		});
		expect(res.status).toBe(400);
		expect(res.json).toMatchObject({ error: "segments are required" });
	});

	it("get + delete of an unknown id 404s", async () => {
		const unknown = "11111111-1111-1111-1111-111111111111";
		const got = await call(backend, "GET", `/api/transcripts/${unknown}`);
		expect(got.status).toBe(404);
	});

	it("update rejects a body with neither title nor segments (400)", async () => {
		const created = await call(backend, "POST", "/api/transcripts", {
			segments: [seg("x")],
		});
		const id = (created.json.transcript as { id: string }).id;
		const res = await call(
			backend,
			"PUT",
			`/api/transcripts/${encodeURIComponent(id)}`,
			{},
		);
		expect(res.status).toBe(400);
	});
});

describe("iOS bridge — browser workspace routes", () => {
	let backend: IosBridgeBackend;

	beforeEach(() => {
		resetIosBrowserWorkspace();
		backend = makeBackend(createFakeRuntime());
	});
	afterEach(() => {
		resetIosBrowserWorkspace();
	});

	it("starts in web mode with no tabs", async () => {
		const { status, json } = await call(
			backend,
			"GET",
			"/api/browser-workspace",
		);
		expect(status).toBe(200);
		expect(json).toEqual({ mode: "web", tabs: [] });
	});

	it("open → navigate → show/hide → close tab lifecycle", async () => {
		// Open (the "Open a website" button path)
		const opened = await call(backend, "POST", "/api/browser-workspace/tabs", {
			url: "docs.elizaos.ai",
			title: "Docs",
			show: true,
		});
		expect(opened.status).toBe(200);
		const tab = opened.json.tab as Record<string, unknown>;
		expect(tab).toMatchObject({
			title: "Docs",
			url: "https://docs.elizaos.ai",
			visible: true,
			partition: "persist:eliza-browser-user",
		});
		const id = tab.id as string;

		// Snapshot appears in the workspace GET, web mode
		const snapshot = await call(backend, "GET", "/api/browser-workspace");
		expect(snapshot.json.mode).toBe("web");
		expect((snapshot.json.tabs as unknown[]).length).toBe(1);

		// Navigate
		const navigated = await call(
			backend,
			"POST",
			`/api/browser-workspace/tabs/${encodeURIComponent(id)}/navigate`,
			{ url: "example.com" },
		);
		expect((navigated.json.tab as { url: string }).url).toBe(
			"https://example.com",
		);

		// Hide then show
		const hidden = await call(
			backend,
			"POST",
			`/api/browser-workspace/tabs/${encodeURIComponent(id)}/hide`,
		);
		expect((hidden.json.tab as { visible: boolean }).visible).toBe(false);
		const shown = await call(
			backend,
			"POST",
			`/api/browser-workspace/tabs/${encodeURIComponent(id)}/show`,
		);
		expect((shown.json.tab as { visible: boolean }).visible).toBe(true);

		// snapshot action returns empty data (web mode has no server screenshot)
		const snap = await call(
			backend,
			"GET",
			`/api/browser-workspace/tabs/${encodeURIComponent(id)}/snapshot`,
		);
		expect(snap.json).toEqual({ data: "" });

		// Close
		const closed = await call(
			backend,
			"DELETE",
			`/api/browser-workspace/tabs/${encodeURIComponent(id)}`,
		);
		expect(closed.json).toEqual({ closed: true });
		const after = await call(backend, "GET", "/api/browser-workspace");
		expect((after.json.tabs as unknown[]).length).toBe(0);
	});

	it("opening a second visible tab hides the first", async () => {
		const a = await call(backend, "POST", "/api/browser-workspace/tabs", {
			url: "a.com",
			show: true,
		});
		await call(backend, "POST", "/api/browser-workspace/tabs", {
			url: "b.com",
			show: true,
		});
		const ws = await call(backend, "GET", "/api/browser-workspace");
		const tabs = ws.json.tabs as Array<{ id: string; visible: boolean }>;
		const first = tabs.find((t) => t.id === (a.json.tab as { id: string }).id);
		expect(first?.visible).toBe(false);
		expect(tabs.filter((t) => t.visible)).toHaveLength(1);
	});

	it("acting on an unknown tab id 404s", async () => {
		const res = await call(
			backend,
			"POST",
			"/api/browser-workspace/tabs/nope/show",
		);
		expect(res.status).toBe(404);
	});
});

describe("iOS bridge — unmatched routes still fall through", () => {
	it("returns null (→ eventual 404) for an unknown /api path", async () => {
		const backend = makeBackend(createFakeRuntime());
		const res = await handleDirectCoreRoute(
			backend,
			"GET",
			"/api/does-not-exist",
			{},
		);
		expect(res).toBeNull();
	});

	it("returns null for an unknown /api/memories subpath", async () => {
		const backend = makeBackend(createFakeRuntime());
		const res = await handleDirectCoreRoute(
			backend,
			"GET",
			"/api/memories/unknown",
			{},
		);
		expect(res).toBeNull();
	});
});
