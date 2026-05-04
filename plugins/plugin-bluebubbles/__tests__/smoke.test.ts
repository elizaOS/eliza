import type {
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { sendMessageAction } from "../src/actions/sendMessage";
import { sendReactionAction } from "../src/actions/sendReaction";
import { BLUEBUBBLES_SERVICE_NAME } from "../src/constants";

describe("@elizaos/plugin-bluebubbles", () => {
	it("exports the plugin", { timeout: 60_000 }, async () => {
		const mod = await import("../src/index.ts");
		expect(mod).toBeDefined();
	});

	it("does not callback or return sent body text after sending", async () => {
		const service = {
			getIsRunning: vi.fn(() => true),
			sendMessage: vi.fn(async () => ({ guid: "bb-msg-1" })),
		};
		const runtime = {
			getService: vi.fn((name: string) =>
				name === BLUEBUBBLES_SERVICE_NAME ? service : null,
			),
			composeState: vi.fn(),
			getRoom: vi.fn(async () => ({ channelId: "chat-guid" })),
			useModel: vi.fn(async () => "Sent body"),
		} as unknown as IAgentRuntime;
		const message: Memory = {
			id: "memory-1" as UUID,
			roomId: "room-1" as UUID,
			agentId: "agent-1" as UUID,
			entityId: "user-1" as UUID,
			content: { text: "reply", source: "bluebubbles" },
			createdAt: Date.now(),
		};
		const state: State = { values: {}, data: {}, text: "" };
		const callback: HandlerCallback = vi.fn(async () => []);

		const result = await sendMessageAction.handler(
			runtime,
			message,
			state,
			undefined,
			callback,
		);

		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				data: expect.objectContaining({
					messageGuid: "bb-msg-1",
					chatGuid: "chat-guid",
					suppressVisibleCallback: true,
					suppressActionResultClipboard: true,
				}),
			}),
		);
		expect(callback).not.toHaveBeenCalled();
	});

	it("does not callback a generic success message after reacting", async () => {
		const service = {
			isConnected: vi.fn(() => true),
			sendReaction: vi.fn(async () => ({ success: true })),
		};
		const runtime = {
			getService: vi.fn((name: string) =>
				name === BLUEBUBBLES_SERVICE_NAME ? service : null,
			),
			composeState: vi.fn(),
			useModel: vi.fn(async () =>
				JSON.stringify({ emoji: "heart", messageId: "last", remove: false }),
			),
		} as unknown as IAgentRuntime;
		const message: Memory = {
			id: "memory-1" as UUID,
			roomId: "room-1" as UUID,
			agentId: "agent-1" as UUID,
			entityId: "user-1" as UUID,
			content: { text: "react", source: "bluebubbles" },
			createdAt: Date.now(),
		};
		const state: State = {
			values: {},
			data: { chatGuid: "chat-guid", lastMessageGuid: "bb-msg-1" },
			text: "",
		};
		const callback: HandlerCallback = vi.fn(async () => []);

		const result = await sendReactionAction.handler(
			runtime,
			message,
			state,
			undefined,
			callback,
		);

		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				data: expect.objectContaining({
					emoji: "heart",
					messageGuid: "bb-msg-1",
					chatGuid: "chat-guid",
					suppressVisibleCallback: true,
					suppressActionResultClipboard: true,
				}),
			}),
		);
		expect(callback).not.toHaveBeenCalled();
	});
});
