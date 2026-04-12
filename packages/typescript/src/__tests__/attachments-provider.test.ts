import { describe, expect, it, vi } from "vitest";
import { attachmentsProvider } from "../basic-capabilities/providers/attachments.ts";
import type { IAgentRuntime, Memory, State } from "../types/index.ts";
import { ContentType } from "../types/index.ts";
import { stringToUuid } from "../utils.ts";

const agentId = stringToUuid("agent");
const entityId = stringToUuid("entity");
const roomId = stringToUuid("room");

function createMessage(index: number, description?: string): Memory {
	return {
		id: stringToUuid(`attachment-message-${index}`),
		entityId,
		agentId,
		roomId,
		content: {
			text: `Attachment ${index}`,
			source: "discord",
			attachments: [
				{
					id: `att-${index}`,
					title: `Attachment ${index}`,
					url: `https://example.com/${index}.png`,
					contentType: ContentType.IMAGE,
					description,
				},
			],
		},
		createdAt: index,
	} as Memory;
}

function createRuntime(messages: Memory[]): IAgentRuntime {
	return {
		agentId,
		character: { name: "Milady" },
		getConversationLength: vi.fn().mockReturnValue(20),
		getMemories: vi.fn().mockResolvedValue(messages),
	} as unknown as IAgentRuntime;
}

describe("attachmentsProvider", () => {
	it("shows only the 3 most recent attachments and omits inline descriptions", async () => {
		const recentMessages = [
			createMessage(1, "Oldest description"),
			createMessage(2, "Older description"),
			createMessage(3, "Middle description"),
			createMessage(4, "Newer description"),
			createMessage(5, "Newest description"),
		];
		const runtime = createRuntime(recentMessages);
		const result = await attachmentsProvider.get(
			runtime,
			createMessage(5, "Newest description"),
			{} as State,
		);

		expect(result.text).toContain("att-5");
		expect(result.text).toContain("att-4");
		expect(result.text).toContain("att-3");
		expect(result.text).not.toContain("att-2");
		expect(result.text).not.toContain("att-1");
		expect(result.text).toContain("older attachments omitted from context");
		expect(result.text).toContain("READ_ATTACHMENT");
		expect(result.text).not.toContain("Newest description");
		expect(result.text).not.toContain("Older description");
		expect(result.data?.omittedCount).toBe(2);
		expect((result.data?.attachments as Array<{ id: string }>).length).toBe(5);
	});
});
