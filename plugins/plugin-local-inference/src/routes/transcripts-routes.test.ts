/**
 * Unit tests for the `/api/transcripts*` rawPath routes — request-to-`Transcript`
 * shaping via `buildTranscriptFromRequest` and the handler contract.
 */

import type {
	AccessContext,
	Memory,
	RouteHandlerContext,
	UUID,
} from "@elizaos/core";
import { buildMeetingArtifactFixtures } from "@elizaos/shared";
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
const OTHER_ENTITY = "33333333-3333-3333-3333-333333333333" as UUID;

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
		updateMemory: async (m: Partial<Memory> & { id: UUID }) => {
			const existing = rows.get(m.id);
			if (!existing) return false;
			rows.set(m.id, { ...existing, ...m });
			return true;
		},
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

const access = (requesterEntityId: UUID): AccessContext => ({
	requesterEntityId,
	worldId: WORLD,
	role: "USER",
});

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

	it("preserves a validated canonical meeting artifact in metadata", () => {
		const meetingArtifact = buildMeetingArtifactFixtures().googleMeetRoom;
		const t = buildTranscriptFromRequest(
			{
				segments,
				metadata: { source: "test" },
				meetingArtifact,
			},
			"id-1",
			9000,
		);

		expect(t.metadata).toEqual({
			source: "test",
			meetingArtifact,
		});
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

	it("POST rejects an invalid canonical meeting artifact", async () => {
		const { runtime } = fakeRuntime();
		const meetingArtifact = {
			...buildMeetingArtifactFixtures().googleMeetRoom,
			media: [],
		};
		const res = await handlerFor(
			"POST",
			"/api/transcripts",
		)(
			ctx({
				runtime: runtime as never,
				body: {
					title: "Bad artifact",
					segments,
					meetingArtifact,
				},
			}),
		);

		expect(res.status).toBe(400);
		expect(res.body).toMatchObject({
			error: "meetingArtifact is invalid",
		});
		expect(
			(res.body as { errors: string[] }).errors.some((error) =>
				error.includes("mediaRefId references missing media"),
			),
		).toBe(true);
	});

	it("POST stores a valid canonical meeting artifact", async () => {
		const { runtime } = fakeRuntime();
		const meetingArtifact = buildMeetingArtifactFixtures().googleMeetRoom;
		const created = await handlerFor(
			"POST",
			"/api/transcripts",
		)(
			ctx({
				runtime: runtime as never,
				body: {
					title: "Meeting",
					segments,
					meetingArtifact,
				},
			}),
		);

		expect(created.status).toBe(201);
		expect(
			(
				created.body as {
					transcript: { metadata?: { meetingArtifact?: unknown } };
				}
			).transcript.metadata?.meetingArtifact,
		).toEqual(meetingArtifact);
	});

	it("PUT edits an existing transcript and 404s on a missing one", async () => {
		const { runtime } = fakeRuntime();
		const created = await handlerFor(
			"POST",
			"/api/transcripts",
		)(ctx({ runtime: runtime as never, body: { title: "Raw", segments } }));
		const id = (created.body as { transcript: { id: string } }).transcript.id;

		const put = await handlerFor(
			"PUT",
			"/api/transcripts/:id",
		)(
			ctx({
				runtime: runtime as never,
				params: { id },
				body: { title: "Fixed title" },
			}),
		);
		expect(put.status).toBe(200);
		expect(
			(put.body as { transcript: { title: string } }).transcript.title,
		).toBe("Fixed title");

		const missing = await handlerFor(
			"PUT",
			"/api/transcripts/:id",
		)(
			ctx({
				runtime: runtime as never,
				params: { id: "00000000-0000-0000-0000-0000000000ff" },
				body: { title: "x" },
			}),
		);
		expect(missing.status).toBe(404);
	});

	it("PUT rejects a body with neither title nor segments", async () => {
		const { runtime } = fakeRuntime();
		const res = await handlerFor(
			"PUT",
			"/api/transcripts/:id",
		)(ctx({ runtime: runtime as never, params: { id: "x" }, body: {} }));
		expect(res.status).toBe(400);
	});

	it("filters GET list and get-by-id for a non-owner requester", async () => {
		const { runtime } = fakeRuntime();
		const post = handlerFor("POST", "/api/transcripts");
		const list = handlerFor("GET", "/api/transcripts");
		const get = handlerFor("GET", "/api/transcripts/:id");

		const ownerPrivate = await post(
			ctx({
				runtime: runtime as never,
				body: {
					title: "Owner private",
					roomId: ROOM,
					entityId: ENTITY,
					scope: "owner-private",
					segments,
				},
			}),
		);
		await post(
			ctx({
				runtime: runtime as never,
				body: {
					title: "Global",
					roomId: ROOM,
					entityId: OTHER_ENTITY,
					scope: "global",
					segments,
				},
			}),
		);
		await post(
			ctx({
				runtime: runtime as never,
				body: {
					title: "User owned",
					roomId: ROOM,
					entityId: ENTITY,
					scope: "user-private",
					segments,
				},
			}),
		);
		await post(
			ctx({
				runtime: runtime as never,
				body: {
					title: "Other user",
					roomId: ROOM,
					entityId: OTHER_ENTITY,
					scope: "user-private",
					segments,
				},
			}),
		);

		const unfiltered = await list(ctx({ runtime: runtime as never }));
		expect(
			(unfiltered.body as { transcripts: Array<{ title: string }> })
				.transcripts,
		).toHaveLength(4);

		const filtered = await list(
			ctx({ runtime: runtime as never, accessContext: access(ENTITY) }),
		);
		expect(
			(filtered.body as { transcripts: Array<{ title: string }> }).transcripts
				.map((t) => t.title)
				.sort(),
		).toEqual(["Global", "User owned"]);

		const id = (ownerPrivate.body as { transcript: { id: string } }).transcript
			.id;
		const hidden = await get(
			ctx({
				runtime: runtime as never,
				params: { id },
				accessContext: access(ENTITY),
			}),
		);
		expect(hidden.status).toBe(404);
	});
});
