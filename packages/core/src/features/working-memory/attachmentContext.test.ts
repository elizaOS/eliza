/**
 * Deterministic coverage for conversation attachment gathering: access-scoped
 * message rows must be filtered before the ATTACHMENT action can read stored
 * text or original URLs. The harness stubs runtime memory/world access; no live
 * model or database is involved.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../../types/index.ts";
import {
	listConversationAttachments,
	readAttachmentRecords,
} from "./attachmentContext.ts";

const agentId = "00000000-0000-0000-0000-0000000000a9" as UUID;
const userId = "00000000-0000-0000-0000-000000000002" as UUID;
const ownerId = "00000000-0000-0000-0000-000000000003" as UUID;
const roomId = "00000000-0000-0000-0000-000000000004" as UUID;

function makeRuntime(recentMessages: Memory[]): IAgentRuntime {
	return {
		agentId,
		getConversationLength: () => 20,
		getMemories: async () => recentMessages,
		getRoom: async () => null,
		logger: { warn: () => undefined },
	} as unknown as IAgentRuntime;
}

function viewerMessage(text = "read the attachment"): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000005" as UUID,
		entityId: userId,
		roomId,
		content: { text },
		createdAt: 2,
	} as Memory;
}

function privateAttachmentMemory(granted = false): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000006" as UUID,
		entityId: ownerId,
		roomId,
		createdAt: 1,
		metadata: {
			scope: "owner-private",
			share: granted
				? {
						grants: [
							{
								entityId: userId,
								mode: "redacted",
							},
						],
					}
				: undefined,
		},
		content: {
			text: "private attachment",
			attachments: [
				{
					id: "private-image",
					url: "https://example.test/original.jpg",
					redactedUrl: "https://example.test/redacted.jpg",
					thumbnailUrl: "https://example.test/thumb.jpg",
					title: "Private Image",
					source: "Image",
					contentType: "document",
					text: "full extracted text",
					description: "full description",
				},
			],
		},
	} as Memory;
}

describe("attachmentContext disclosure", () => {
	it("omits owner-private attachments for an ungranted requester", async () => {
		const attachments = await listConversationAttachments(
			makeRuntime([privateAttachmentMemory(false)]),
			viewerMessage(),
		);

		expect(attachments).toEqual([]);
	});

	it("downgrades a redacted grant before ATTACHMENT action content reads", async () => {
		const records = await readAttachmentRecords(
			makeRuntime([privateAttachmentMemory(true)]),
			viewerMessage("read private-image"),
			"private-image",
		);

		expect(records).toHaveLength(1);
		expect(records[0]?.attachment.url).toBe(
			"https://example.test/redacted.jpg",
		);
		expect(records[0]?.attachment.redacted).toBe(true);
		expect(records[0]?.attachment.thumbnailUrl).toBeUndefined();
		expect(records[0]?.attachment.text).toBeUndefined();
		expect(records[0]?.content).toBe("");
	});
});
