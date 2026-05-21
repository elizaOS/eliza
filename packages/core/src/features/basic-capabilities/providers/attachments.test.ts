import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../../../types/index.ts";
import { attachmentsProvider } from "./attachments.ts";

const roomId = "00000000-0000-0000-0000-000000000001" as UUID;

function attachmentMemory(createdAt = 1): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000011" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		roomId,
		createdAt,
		content: {
			text: "old link",
			attachments: [
				{
					id: "webpage-old",
					url: "https://example.test/old-link",
					title: "Old Link",
					source: "Web",
					contentType: "link",
					text: "old page text",
				},
			],
		},
	} as Memory;
}

function makeRuntime(recentMessages: Memory[]): IAgentRuntime {
	return {
		getConversationLength: () => 20,
		getMemories: async () => recentMessages,
	} as unknown as IAgentRuntime;
}

function makeMessage(content: Partial<Memory["content"]>): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000012" as UUID,
		entityId: "00000000-0000-0000-0000-000000000003" as UUID,
		roomId,
		createdAt: 2,
		content: {
			text: "can you try this?",
			...content,
		},
	} as Memory;
}

describe("attachmentsProvider", () => {
	it("keeps stale room attachments out of unrelated prompt text", async () => {
		const result = await attachmentsProvider.get(
			makeRuntime([attachmentMemory()]),
			makeMessage({ text: "can you try this?" }),
		);

		expect(result.text).toBe("");
		expect(result.data?.visibleAttachments).toHaveLength(1);
	});

	it("renders attachment prompt text when the current message asks about a link", async () => {
		const result = await attachmentsProvider.get(
			makeRuntime([attachmentMemory()]),
			makeMessage({ text: "can you read the link?" }),
		);

		expect(result.text).toContain("# Attachments");
		expect(result.text).toContain("webpage-old");
	});

	it("uses reply target text when deciding attachment relevance", async () => {
		const result = await attachmentsProvider.get(
			makeRuntime([attachmentMemory()]),
			makeMessage({
				text: "find anything?",
				replyToMessageText: "can you read this link?",
			}),
		);

		expect(result.text).toContain("# Attachments");
		expect(result.text).toContain("webpage-old");
	});

	it("does not inject stale room attachments into sub-agent result turns", async () => {
		const result = await attachmentsProvider.get(
			makeRuntime([attachmentMemory()]),
			makeMessage({
				source: "sub_agent",
				text: "[sub-agent: app-build (opencode) — task_complete]\nResult: https://example.test/apps/demo/",
			}),
		);

		expect(result.text).toBe("");
		expect(result.data?.visibleAttachments).toHaveLength(1);
	});
});
