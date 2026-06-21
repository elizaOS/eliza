import type { Memory, RouteHandlerContext, UUID } from "@elizaos/core";
import type { TranscriptSegment } from "@elizaos/shared/transcripts";
import { describe, expect, it } from "vitest";
import {
	buildTranscriptFromRequest,
	type CreateTranscriptRequest,
	transcriptsRoutes,
} from "./transcripts-routes";

const WORLD = "00000000-0000-0000-0000-0000000000ww" as UUID;
const ROOM = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY = "22222222-2222-2222-2222-222222222222" as UUID;

const segments: TranscriptSegment[] = [
	{
		id: "s1",
		speakerLabel: "Alice",
		startMs: 0,
		endMs: 1000,
		text: "hi there",
		words: [],
	},
	{
		id: "s2",
		speakerLabel: "Bob",
		startMs: 1200,
		endMs: 2500,
		text: "hello",
		words: [],
	},
];

function fakeRuntime(): { rows: Map<string, Memory>; runtime: unknown } {
	const rows = new Map<string, Memory>();
	const runtime = {
		agentId: "agent-1" as UUID,
		createMemory: async (m: Memory) => {
			rows.set(m.id as string, m);
			return m.id as UUID;
		},
		getMemories: async () => [...rows.values()],
		getMemoryById: async (id: UUID) => rows.get(id) ?? null,
		deleteMemory: async (id: UUID) => {
			rows.delete(id);
		},
		getService: () => null, // no documents service in this test
	};
	return { rows, runtime };
}

function ctx(over: Partial<RouteHandlerContext>): RouteHandlerContext {
	return {
		params: {},
		query: {},
		body: undefined,
		headers: {},
		method: "GET",
		path: "/api/transcripts",
		inProcess: true,
		...over,
	} as RouteHandlerContext;
}

function handlerFor(type: string, path: string) {
	const r = transcriptsRoutes.find((x) => x.type === type && x.path === path);
	if (!r?.routeHandler) throw new Error(`no route ${type} ${path}`);
	return r.routeHandler;
}

describe("buildTranscriptFromRequest", () => {
	it("derives duration + speaker count + defaults", () => {
		const body: CreateTranscriptRequest = {
			worldId: WORLD,
			roomId: ROOM,
			entityId: ENTITY,
			segments,
			createdAt: 1000,
		};
		const t = buildTranscriptFromRequest(body, "id-1", 9000);
		expect(t.durationMs).toBe(2500);
		expect(t.speakerCount).toBe(2);
		expect(t.scope).toBe("owner-private");
		expect(t.source).toBe("voice-session");
		expect(t.status).toBe("ready");
		expect(t.createdAt).toBe(1000);
		expect(t.endedAt).toBe(9000);
		expect(t.title).toContain("Recording");
	});
});

describe("transcripts routes", () => {
	it("POST creates, GET reads it back, GET list summarizes, DELETE removes", async () => {
		const { runtime } = fakeRuntime();
		// No world/room/entity ids — the route derives them from the agent context.
		const body: CreateTranscriptRequest = {
			title: "Standup",
			segments,
		};
		const created = await handlerFor(
			"POST",
			"/api/transcripts",
		)(ctx({ runtime: runtime as never, body }));
		expect(created.status).toBe(201);
		const id = (created.body as { transcript: { id: string } }).transcript.id;
		expect(typeof id).toBe("string");

		const got = await handlerFor(
			"GET",
			"/api/transcripts/:id",
		)(ctx({ runtime: runtime as never, params: { id } }));
		expect(got.status).toBe(200);
		expect(
			(got.body as { transcript: { title: string } }).transcript.title,
		).toBe("Standup");

		const list = await handlerFor(
			"GET",
			"/api/transcripts",
		)(ctx({ runtime: runtime as never }));
		expect((list.body as { transcripts: unknown[] }).transcripts).toHaveLength(
			1,
		);

		const del = await handlerFor(
			"DELETE",
			"/api/transcripts/:id",
		)(ctx({ runtime: runtime as never, params: { id } }));
		expect(del.status).toBe(200);
		const after = await handlerFor(
			"GET",
			"/api/transcripts/:id",
		)(ctx({ runtime: runtime as never, params: { id } }));
		expect(after.status).toBe(404);
	});

	it("POST rejects a body with no segments", async () => {
		const { runtime } = fakeRuntime();
		const res = await handlerFor(
			"POST",
			"/api/transcripts",
		)(ctx({ runtime: runtime as never, body: { segments: [] } }));
		expect(res.status).toBe(400);
	});
});
