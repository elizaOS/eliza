/**
 * Verifies ATTACHMENT document saves resolve world scope without crossing the
 * room/world namespace boundary. The deterministic action harness uses an
 * in-memory document-service stub and no model calls or module mocks.
 */

import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import { ElizaError } from "../../errors.ts";
import type {
	IAgentRuntime,
	Media,
	Memory,
	Room,
	UUID,
} from "../../types/index.ts";
import { ChannelType, ContentType } from "../../types/index.ts";
import type { DocumentService } from "../documents/service.ts";
import { readAttachmentAction } from "./readAttachmentAction.ts";

type AddDocumentOptions = Parameters<DocumentService["addDocument"]>[0];

function makeAttachment(): Media {
	return {
		id: "attachment-world-scope",
		title: "World scope notes",
		contentType: ContentType.DOCUMENT,
		text: "Keep this document in the correct world.",
	};
}

function makeRoom(id: UUID, worldId?: UUID): Room {
	return {
		id,
		agentId: uuidv4() as UUID,
		source: "test",
		type: ChannelType.GROUP,
		worldId,
	};
}

async function runSave(params: {
	messageWorldId?: UUID;
	getRoom: (roomId: UUID) => Promise<Room | null>;
}) {
	const agentId = uuidv4() as UUID;
	const roomId = uuidv4() as UUID;
	const addDocumentCalls: AddDocumentOptions[] = [];
	const reportedErrors: unknown[] = [];
	let getRoomCalls = 0;
	const service = {
		addDocument: async (options: AddDocumentOptions) => {
			addDocumentCalls.push(options);
			return {
				clientDocumentId: uuidv4() as UUID,
				storedDocumentMemoryId: uuidv4() as UUID,
				fragmentCount: 1,
			};
		},
	};
	const runtime = {
		agentId,
		getConversationLength: () => 8,
		getMemories: async () => [],
		getRoom: async (requestedRoomId: UUID) => {
			getRoomCalls += 1;
			return params.getRoom(requestedRoomId);
		},
		getService: () => service,
		reportError: (_scope: string, error: unknown) => {
			reportedErrors.push(error);
		},
	} as unknown as IAgentRuntime;
	const message: Memory = {
		id: uuidv4() as UUID,
		agentId,
		entityId: agentId,
		roomId,
		worldId: params.messageWorldId,
		createdAt: Date.now(),
		content: {
			text: "Save this attachment as a document",
			source: "test",
			attachments: [makeAttachment()],
		},
	};

	const result = await readAttachmentAction.handler?.(
		runtime,
		message,
		undefined,
		{ parameters: { action: "save_as_document" } },
	);

	return {
		addDocumentCalls,
		agentId,
		getRoomCalls,
		reportedErrors,
		result,
		roomId,
	};
}

describe("ATTACHMENT save_as_document world resolution", () => {
	it("uses the message world without loading the room", async () => {
		const messageWorldId = uuidv4() as UUID;
		const result = await runSave({
			messageWorldId,
			getRoom: async () => {
				throw new Error("room lookup must not run");
			},
		});

		expect(result.result?.success).toBe(true);
		expect(result.getRoomCalls).toBe(0);
		expect(result.addDocumentCalls).toHaveLength(1);
		expect(result.addDocumentCalls[0]?.worldId).toBe(messageWorldId);
		expect(result.addDocumentCalls[0]?.roomId).toBe(result.roomId);
	});

	it("uses the room world when the message has no world", async () => {
		const roomWorldId = uuidv4() as UUID;
		const result = await runSave({
			getRoom: async (roomId) => makeRoom(roomId, roomWorldId),
		});

		expect(result.result?.success).toBe(true);
		expect(result.getRoomCalls).toBe(1);
		expect(result.addDocumentCalls[0]?.worldId).toBe(roomWorldId);
		expect(result.addDocumentCalls[0]?.worldId).not.toBe(result.roomId);
	});

	it("falls back to the agent world when the room has no world", async () => {
		const result = await runSave({
			getRoom: async (roomId) => makeRoom(roomId),
		});

		expect(result.result?.success).toBe(true);
		expect(result.addDocumentCalls[0]?.worldId).toBe(result.agentId);
	});

	it("reports a typed failure when the room is missing", async () => {
		const result = await runSave({ getRoom: async () => null });

		expect(result.result?.success).toBe(false);
		expect(result.addDocumentCalls).toHaveLength(0);
		expect(result.reportedErrors).toHaveLength(1);
		const error = result.reportedErrors[0];
		expect(error).toBeInstanceOf(ElizaError);
		expect((error as ElizaError).code).toBe(
			"ATTACHMENT_DOCUMENT_ROOM_NOT_FOUND",
		);
	});

	it("wraps a rejected room lookup and preserves its cause", async () => {
		const cause = new Error("database unavailable");
		const result = await runSave({
			getRoom: async () => {
				throw cause;
			},
		});

		expect(result.result?.success).toBe(false);
		expect(result.addDocumentCalls).toHaveLength(0);
		const error = result.reportedErrors[0];
		expect(error).toBeInstanceOf(ElizaError);
		expect((error as ElizaError).code).toBe(
			"ATTACHMENT_DOCUMENT_WORLD_LOOKUP_FAILED",
		);
		expect((error as ElizaError).cause).toBe(cause);
	});
});
