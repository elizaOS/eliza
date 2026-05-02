import type {
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	sendMessageAction,
	WHATSAPP_SEND_MESSAGE_ACTION,
} from "../src/actions/sendMessage";
import {
	sendReactionAction,
	WHATSAPP_SEND_REACTION_ACTION,
} from "../src/actions/sendReaction";

const originalFetch = globalThis.fetch;

describe("@elizaos/plugin-whatsapp", () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("exports the plugin", async () => {
		const mod = await import("../src/index.ts");
		expect(mod).toBeDefined();
	});

	it("does not callback a generic success message after sending", async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			json: vi.fn(async () => ({ messages: [{ id: "wamid.1" }] })),
		})) as unknown as typeof fetch;
		const runtime = createRuntime(
			JSON.stringify({ to: "+14155552671", text: "Hello" }),
		);
		const callback: HandlerCallback = vi.fn(async () => []);

		const result = await sendMessageAction.handler(
			runtime,
			createMessage("Send a WhatsApp message"),
			createState(),
			undefined,
			callback,
		);

		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				data: expect.objectContaining({
					action: WHATSAPP_SEND_MESSAGE_ACTION,
					to: "+14155552671",
					messageId: "wamid.1",
					suppressVisibleCallback: true,
					suppressActionResultClipboard: true,
				}),
			}),
		);
		expect(callback).not.toHaveBeenCalled();
	});

	it("does not callback a generic success message after reacting", async () => {
		globalThis.fetch = vi.fn(async () => ({
			ok: true,
			json: vi.fn(async () => ({ messages: [{ id: "wamid.reaction" }] })),
		})) as unknown as typeof fetch;
		const runtime = createRuntime(
			JSON.stringify({ messageId: "wamid.1", emoji: "👍" }),
		);
		const callback: HandlerCallback = vi.fn(async () => []);

		const result = await sendReactionAction.handler(
			runtime,
			createMessage("React with thumbs up"),
			createState(),
			undefined,
			callback,
		);

		expect(result).toEqual(
			expect.objectContaining({
				success: true,
				data: expect.objectContaining({
					action: WHATSAPP_SEND_REACTION_ACTION,
					messageId: "wamid.1",
					emoji: "👍",
					suppressVisibleCallback: true,
					suppressActionResultClipboard: true,
				}),
			}),
		);
		expect(callback).not.toHaveBeenCalled();
	});
});

function createRuntime(modelResponse: string): IAgentRuntime {
	return {
		getSetting: vi.fn((name: string) => {
			if (name === "WHATSAPP_ACCESS_TOKEN") return "token";
			if (name === "WHATSAPP_PHONE_NUMBER_ID") return "phone-id";
			if (name === "WHATSAPP_API_VERSION") return "v24.0";
			return undefined;
		}),
		composeState: vi.fn(),
		useModel: vi.fn(async () => modelResponse),
	} as unknown as IAgentRuntime;
}

function createMessage(text: string): Memory {
	return {
		id: "memory-1" as UUID,
		roomId: "room-1" as UUID,
		agentId: "agent-1" as UUID,
		entityId: "user-1" as UUID,
		content: {
			text,
			source: "whatsapp",
			from: "+14155552671",
			messageId: "wamid.1",
		},
		createdAt: Date.now(),
	};
}

function createState(): State {
	return { values: {}, data: {}, text: "" };
}
