/**
 * Tests inbound message handling in MessageManager — envelope mapping, dedup,
 * and event emission — against a mocked runtime (no live Feishu API).
 */
import type { IAgentRuntime } from "@elizaos/core";
import { EventType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { FeishuConfig } from "./environment";
import { MessageManager } from "./messageManager";
import type { FeishuEventData, FeishuMessage } from "./types";
import { FeishuEventTypes } from "./types";

const agentId = "00000000-0000-0000-0000-000000000001";

function createRuntime() {
	return Object.assign(Object.create(null) as IAgentRuntime, {
		agentId,
		ensureConnection: vi.fn().mockResolvedValue(undefined),
		emitEvent: vi.fn(),
	});
}

function createManager(
	runtime = createRuntime(),
	client = Object.create(null) as ConstructorParameters<
		typeof MessageManager
	>[0],
) {
	const config: FeishuConfig = {
		appId: "cli_test",
		appSecret: "secret",
		domain: "feishu",
		apiRoot: "https://open.feishu.cn",
		allowedChatIds: [],
		shouldIgnoreBotMessages: true,
		shouldRespondOnlyToMentions: false,
	};
	return new MessageManager(client, runtime, config);
}

function message(overrides: Partial<FeishuMessage> = {}): FeishuMessage {
	return {
		messageId: "om_test",
		msgType: "text",
		content: JSON.stringify({ text: "hello" }),
		createTime: "1710000000000",
		chatId: "oc_test",
		sender: {
			id: "ou_sender",
			idType: "open_id",
			senderType: "user",
		},
		...overrides,
	};
}

function event(messagePayload: unknown): FeishuEventData {
	return {
		event: {
			chat_type: "group",
			chat_name: "Security Review",
			message: messagePayload,
			sender: {
				sender_id: {
					open_id: "ou_sender",
					union_id: "on_sender",
					user_id: "user_sender",
				},
				sender_type: "user",
			},
		},
	};
}

describe("MessageManager inbound event handling", () => {
	it("ignores malformed message payloads before creating runtime state", async () => {
		const runtime = createRuntime();
		const manager = createManager(runtime);

		await manager.handleMessage(
			event({
				chatId: "oc_test",
				msgType: "text",
				content: JSON.stringify({ text: "missing id" }),
				createTime: "1710000000000",
			}),
		);

		expect(runtime.ensureConnection).not.toHaveBeenCalled();
		expect(runtime.emitEvent).not.toHaveBeenCalled();
	});

	it("emits hostile malformed JSON text with a finite timestamp", async () => {
		const runtime = createRuntime();
		const manager = createManager(runtime);

		await manager.handleMessage(
			event(message({ content: "{not json", createTime: "not-a-number" })),
		);

		expect(runtime.ensureConnection).toHaveBeenCalledWith(
			expect.objectContaining({
				channelId: "oc_test",
				source: "feishu",
				userId: "ou_sender",
			}),
		);
		expect(runtime.emitEvent).toHaveBeenCalledWith(
			FeishuEventTypes.MESSAGE_RECEIVED,
			expect.objectContaining({
				message: expect.objectContaining({
					content: expect.objectContaining({ text: "" }),
					createdAt: expect.any(Number),
				}),
			}),
		);
		expect(runtime.emitEvent).toHaveBeenCalledWith(
			EventType.MESSAGE_RECEIVED,
			expect.objectContaining({
				message: expect.objectContaining({
					createdAt: expect.any(Number),
				}),
			}),
		);

		const payload = vi.mocked(runtime.emitEvent).mock.calls[0][1] as {
			message: { createdAt: number };
		};
		expect(Number.isFinite(payload.message.createdAt)).toBe(true);
	});
});

describe("MessageManager outbound sending", () => {
	it("does not call Feishu for blank text-only sends or replies", async () => {
		const create = vi.fn();
		const reply = vi.fn();
		const manager = createManager(createRuntime(), {
			im: {
				message: {
					create,
					reply,
				},
			},
		} as never);

		await expect(
			manager.sendMessage("oc_test", { text: " \n\t " }),
		).resolves.toEqual([]);
		await expect(
			manager.replyToMessage("om_parent", { text: "" }),
		).resolves.toEqual([]);

		expect(create).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});

	it("still sends cards even when text is blank", async () => {
		const create = vi
			.fn()
			.mockResolvedValue({ data: { message_id: "om_card" } });
		const manager = createManager(createRuntime(), {
			im: {
				message: {
					create,
				},
			},
		} as never);

		await expect(
			manager.sendMessage("oc_test", {
				text: "",
				card: { header: { title: { tag: "plain_text", content: "Update" } } },
			}),
		).resolves.toEqual(["om_card"]);

		expect(create).toHaveBeenCalledWith({
			params: { receive_id_type: "chat_id" },
			data: expect.objectContaining({
				receive_id: "oc_test",
				msg_type: "interactive",
			}),
		});
	});
});
