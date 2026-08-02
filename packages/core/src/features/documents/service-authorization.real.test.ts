/**
 * Exercises document authorization against a real AgentRuntime and PGLite store,
 * including same-turn membership revocation before update and delete mutations.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "../../runtime.ts";
import { createTestRuntime } from "../../testing/pglite-runtime.ts";
import { runWithTrajectoryContext } from "../../trajectory-context.ts";
import {
	ChannelType,
	type Memory,
	MemoryType,
	type UUID,
} from "../../types/index.ts";
import { DocumentService } from "./service.ts";

const USER_ID = "f4300000-0000-4000-8000-000000000001" as UUID;
const WORLD_ID = "f4300000-0000-4000-8000-000000000002" as UUID;
const ROOM_ID = "f4300000-0000-4000-8000-000000000003" as UUID;
const UPDATE_DOCUMENT_ID = "f4300000-0000-4000-8000-000000000004" as UUID;
const DELETE_DOCUMENT_ID = "f4300000-0000-4000-8000-000000000005" as UUID;

let runtime: AgentRuntime;
let cleanup: () => Promise<void>;

function message(): Memory {
	return {
		id: "f4300000-0000-4000-8000-000000000006" as UUID,
		agentId: runtime.agentId,
		entityId: USER_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		content: {
			text: "Update my private documents",
			source: "test",
			channelType: ChannelType.DM,
		},
	};
}

function userPrivateDocument(id: UUID, text: string): Memory {
	const filename = `${id}.txt`;
	return {
		id,
		agentId: runtime.agentId,
		entityId: USER_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		createdAt: 1_000,
		content: { text },
		metadata: {
			type: MemoryType.DOCUMENT,
			documentId: id,
			documentRevision: 0,
			scope: "user-private",
			scopedToEntityId: USER_ID,
			addedBy: USER_ID,
			addedByRole: "USER",
			addedFrom: "upload",
			addedAt: 1_000,
			source: "test",
			title: "Private document",
			filename,
			originalFilename: filename,
			fileExt: "txt",
			fileType: "text/plain",
			contentType: "text/plain",
			fileSize: Buffer.byteLength(text, "utf8"),
			textBacked: true,
			timestamp: 1_000,
		},
	};
}

beforeAll(async () => {
	({ runtime, cleanup } = await createTestRuntime({
		characterName: "DocumentAuthorizationTest",
	}));
	await runtime.ensureConnection({
		entityId: USER_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		worldName: "Document authorization",
		userName: "Document owner",
		name: "Document owner",
		source: "test",
		type: ChannelType.DM,
	});
	await runtime.ensureWorldExists({
		id: WORLD_ID,
		name: "Document authorization",
		agentId: runtime.agentId,
		metadata: {
			roles: { [USER_ID]: "USER" },
			roleSources: { [USER_ID]: "manual" },
		},
	});
	await runtime.createMemories([
		{
			memory: userPrivateDocument(UPDATE_DOCUMENT_ID, "Original update body"),
			tableName: "documents",
		},
		{
			memory: userPrivateDocument(DELETE_DOCUMENT_ID, "Original delete body"),
			tableName: "documents",
		},
	]);
}, 120_000);

afterAll(async () => {
	await cleanup();
}, 120_000);

describe("DocumentService requester authorization", () => {
	it("denies same-turn update and delete after room membership is revoked", async () => {
		const service = new DocumentService(runtime);
		const membershipReads = vi.spyOn(
			runtime.adapter,
			"getRoomsForParticipants",
		);
		const request = message();

		await runWithTrajectoryContext(
			{ turnMemo: new Map<string, Promise<unknown>>() },
			async () => {
				await expect(
					service.getDocumentById(UPDATE_DOCUMENT_ID, request),
				).resolves.toMatchObject({ id: UPDATE_DOCUMENT_ID });

				await expect(runtime.removeParticipant(USER_ID, ROOM_ID)).resolves.toBe(
					true,
				);

				await expect(
					service.updateDocument({
						documentId: UPDATE_DOCUMENT_ID,
						content: "Unauthorized replacement",
						message: request,
					}),
				).rejects.toMatchObject({ code: "DOCUMENT_NOT_FOUND" });
				await expect(
					service.deleteDocument(DELETE_DOCUMENT_ID, request),
				).rejects.toMatchObject({ code: "DOCUMENT_MUTATION_FORBIDDEN" });
			},
		);

		expect(membershipReads).toHaveBeenCalledTimes(3);
		const stored = await runtime.adapter.getMemoriesByIds(
			[UPDATE_DOCUMENT_ID, DELETE_DOCUMENT_ID],
			"documents",
		);
		expect(stored).toHaveLength(2);
		expect(
			stored.find((document) => document.id === UPDATE_DOCUMENT_ID)?.content,
		).toMatchObject({ text: "Original update body" });
		expect(
			stored.find((document) => document.id === DELETE_DOCUMENT_ID)?.content,
		).toMatchObject({ text: "Original delete body" });
	});
});
