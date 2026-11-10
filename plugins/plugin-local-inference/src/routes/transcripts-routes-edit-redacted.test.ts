/**
 * Editing a transcript through `PUT /api/transcripts/:id` on a real
 * SQLite-backed runtime after the author shared it in redacted mode. A viewer
 * with a redacted grant reads the linked redacted variant, so the edit must
 * reach that variant too: otherwise the viewer keeps reading the text the
 * author removed.
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
const aliceId = stringToUuid("transcript-edit-redacted-alice");
const bobId = stringToUuid("transcript-edit-redacted-bob");
const worldId = stringToUuid("transcript-edit-redacted-world");
const roomId = stringToUuid("transcript-edit-redacted-room");

beforeAll(async () => {
	runtime = createSQLiteTestRuntime({
		character: { name: "TranscriptEditRedactedTest", bio: ["test"] },
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

function segment(text: string) {
	return {
		id: "s1",
		speakerLabel: "Speaker 1",
		startMs: 0,
		endMs: 1000,
		text,
		words: [],
	};
}

describe("PUT /api/transcripts/:id after a redacted share", () => {
	it("shows the edited text to a viewer with a redacted grant", async () => {
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
						segment(
							"We are moving the launch to March and cutting the beta team",
						),
					],
					metadata: { consent: { state: "granted" } },
				},
			),
		);
		expect(created.status).toBe(201);
		const id = (created.body as { transcript: Transcript }).transcript.id;

		const shared = await route(
			"POST",
			"/api/transcripts/:id/share",
		)(ctx(aliceId, { id }, { entityId: bobId, mode: "redacted" }));
		expect(shared.status).toBe(200);

		const edited = await route(
			"PUT",
			"/api/transcripts/:id",
		)(
			ctx(
				aliceId,
				{ id },
				{
					title: "Launch plan",
					segments: [
						segment(
							"We are moving the launch to March, send notes to alice@example.com",
						),
					],
				},
			),
		);
		expect(edited.status).toBe(200);

		const seen = await route(
			"GET",
			"/api/transcripts/:id",
		)(ctx(bobId, { id }, undefined));
		expect(seen.status).toBe(200);
		const transcript = (seen.body as { transcript: Transcript }).transcript;
		expect({
			redacted: transcript.redacted,
			title: transcript.title,
			text: transcript.segments.map((s) => s.text),
		}).toEqual({
			redacted: true,
			title: "Launch plan (redacted)",
			text: ["We are moving the launch to March, send notes to [EMAIL]"],
		});
	});
});
