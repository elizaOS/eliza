/**
 * Room-snapshot sharing through `POST /api/transcripts/:id/share` on a real
 * SQLite-backed runtime. The persisted meeting roster normally lists the
 * recording's own author, so the snapshot must not hand the author a grant on
 * their own transcript: an explicit `redacted` grant wins over the scope ladder
 * and would cut the author down to the redacted variant, with edit, delete,
 * privacy and revoke all refused.
 */

import {
	type AccessContext,
	ChannelType,
	stringToUuid,
	type UUID,
} from "@elizaos/core";
import type { Transcript } from "@elizaos/core/protocol";
import type { RouteHandlerContext } from "@elizaos/host/protocol";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { transcriptsRoutes } from "./transcripts-routes";

let runtime: ReturnType<typeof createSQLiteTestRuntime>;
const aliceId = stringToUuid("transcript-room-share-alice");
const bobId = stringToUuid("transcript-room-share-bob");
const worldId = stringToUuid("transcript-room-share-world");
const roomId = stringToUuid("transcript-room-share-room");

beforeAll(async () => {
	runtime = createSQLiteTestRuntime({
		character: { name: "TranscriptRoomShareTest", bio: ["test"] },
		logLevel: "fatal",
	});
	await runtime.initialize({ skipMigrations: true });
	await runtime.createEntities([
		{ id: aliceId, agentId: runtime.agentId, names: ["Alice"] },
		{ id: bobId, agentId: runtime.agentId, names: ["Bob"] },
	]);
	await runtime.createWorlds([
		{ id: worldId, agentId: runtime.agentId, name: "W" },
	]);
	await runtime.createRooms([
		{
			id: roomId,
			agentId: runtime.agentId,
			worldId,
			name: "Standup",
			source: "client_chat",
			type: ChannelType.GROUP,
		},
	]);
	await runtime.createRoomParticipants([aliceId, bobId], roomId);
});

afterAll(async () => {
	await runtime?.stop();
});

function route(method: string, path: string) {
	const found = transcriptsRoutes.find(
		(r) => r.type === method && r.path === path,
	);
	if (!found?.routeHandler) throw new Error(`no route ${method} ${path}`);
	return found.routeHandler;
}

function ctx(
	requesterEntityId: UUID,
	params: Record<string, string>,
	body: unknown,
): RouteHandlerContext {
	const accessContext: AccessContext = {
		requesterEntityId,
		worldId,
		role: "USER",
		isOwner: false,
	};
	return {
		signal: new AbortController().signal,
		body,
		params,
		query: {},
		headers: {},
		method: "GET",
		path: "/api/transcripts",
		runtime,
		inProcess: true,
		accessContext,
	};
}

describe("POST /api/transcripts/:id/share with a roomId", () => {
	it("keeps the author's full access while the rest of the roster gets the redacted variant", async () => {
		const created = await route(
			"POST",
			"/api/transcripts",
		)(
			ctx(
				aliceId,
				{},
				{
					roomId,
					title: "Standup",
					source: "meeting",
					scope: "user-private",
					segments: [
						{
							id: "s1",
							speakerLabel: "Speaker 1",
							startMs: 0,
							endMs: 1000,
							text: "Status update from the team",
							words: [],
						},
					],
					metadata: {
						consent: { state: "granted" },
						participants: [
							{ id: "p1", displayName: "Alice", entityId: aliceId },
							{ id: "p2", displayName: "Bob", entityId: bobId },
						],
					},
				},
			),
		);
		expect(created.status).toBe(201);
		const id = (created.body as { transcript: Transcript }).transcript.id;

		const shared = await route(
			"POST",
			"/api/transcripts/:id/share",
		)(ctx(aliceId, { id }, { roomId, mode: "redacted" }));
		expect(shared.status).toBe(200);

		const authorView = await route(
			"GET",
			"/api/transcripts/:id",
		)(ctx(aliceId, { id }, undefined));
		const colleagueView = await route(
			"GET",
			"/api/transcripts/:id",
		)(ctx(bobId, { id }, undefined));
		const edit = await route(
			"PUT",
			"/api/transcripts/:id",
		)(ctx(aliceId, { id }, { title: "Standup (fixed)" }));
		const revoke = await route(
			"DELETE",
			"/api/transcripts/:id/share/:entityId",
		)(ctx(aliceId, { id, entityId: bobId }, undefined));

		expect({
			authorStatus: authorView.status,
			authorRedacted: (authorView.body as { transcript: Transcript }).transcript
				.redacted,
			colleagueRedacted: (colleagueView.body as { transcript: Transcript })
				.transcript.redacted,
			editStatus: edit.status,
			revokeStatus: revoke.status,
		}).toEqual({
			authorStatus: 200,
			authorRedacted: undefined,
			colleagueRedacted: true,
			editStatus: 200,
			revokeStatus: 200,
		});
	});
});
