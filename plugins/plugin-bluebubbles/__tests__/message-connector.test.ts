import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BlueBubblesService } from "../src/service";
import type { BlueBubblesChat } from "../src/types";

type RuntimeSendHandler = Parameters<IAgentRuntime["registerSendHandler"]>[1];
type ConnectorTargetInfo = Parameters<RuntimeSendHandler>[1];
type ConnectorContent = Parameters<RuntimeSendHandler>[2];
type MessageConnectorRegistration = Parameters<
	IAgentRuntime["registerMessageConnector"]
>[0];

function makeRuntime(
	registrations: MessageConnectorRegistration[],
): IAgentRuntime {
	return {
		agentId: "agent-1" as UUID,
		registerMessageConnector: vi.fn(
			(registration: MessageConnectorRegistration) => {
				registrations.push(registration);
			},
		),
		getMessageConnectors: vi.fn(() =>
			registrations.map((registration) => ({
				source: registration.source,
			})),
		),
		registerSendHandler: vi.fn(),
		getRoom: vi.fn(async () => null),
		getMemoryById: vi.fn(async () => null),
		createMemory: vi.fn(async () => undefined),
	} as IAgentRuntime;
}

function makeDirectChat(): BlueBubblesChat {
	return {
		guid: "iMessage;-;+14155552671",
		chatIdentifier: "+1 (415) 555-2671",
		displayName: "Alice",
		participants: [
			{
				address: "+1 (415) 555-2671",
				service: "iMessage",
				country: null,
				originalROWID: 1,
				uncanonicalizedId: null,
			},
		],
		lastMessage: null,
		style: 45,
		isArchived: false,
		isFiltered: false,
		isPinned: false,
		hasUnreadMessages: false,
	};
}

describe("BlueBubbles message connector registration", () => {
	it("registers BlueBubbles plus iMessage fallback connectors with target hooks", async () => {
		const registrations: MessageConnectorRegistration[] = [];
		const runtime = makeRuntime(registrations);
		const service = {
			getIsRunning: vi.fn(() => true),
			listChats: vi.fn(async () => [makeDirectChat()]),
			getChatState: vi.fn(async () => ({
				chatGuid: "iMessage;-;+14155552671",
				chatIdentifier: "+14155552671",
				isGroup: false,
				participants: ["+14155552671"],
				displayName: "Alice",
				lastMessageAt: null,
				hasUnread: false,
			})),
			sendMessage: vi.fn(async () => ({ guid: "bb-1", dateCreated: 123 })),
		} as BlueBubblesService;

		BlueBubblesService.registerSendHandlers(runtime, service);

		expect(registrations.map((registration) => registration.source)).toEqual([
			"bluebubbles",
			"imessage",
		]);

		const connector = registrations.find(
			(registration) => registration.source === "bluebubbles",
		);
		expect(connector?.capabilities).toContain("send_message");
		expect(connector?.metadata?.aliases).toEqual(
			expect.arrayContaining(["bluebubbles", "imessage"]),
		);

		const targets = await connector?.resolveTargets?.("Alice", { runtime });
		expect(targets?.[0]).toEqual(
			expect.objectContaining({
				label: "Alice",
				kind: "phone",
				target: expect.objectContaining({
					channelId: "+14155552671",
				}),
			}),
		);

		await connector?.sendHandler(
			runtime,
			{
				source: "bluebubbles",
				entityId: "+1 (415) 555-2671" as UUID,
			} as ConnectorTargetInfo,
			{ text: "hello" } as ConnectorContent,
		);

		expect(service.sendMessage).toHaveBeenCalledWith(
			"+14155552671",
			"hello",
			undefined,
		);
	});
});
