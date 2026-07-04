/**
 * Tests the Feishu message connector registration and send routing on
 * FeishuService against a mocked runtime and Lark client (no live API).
 */
import type { Content, IAgentRuntime, TargetInfo } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { FeishuService } from "./service";

describe("Feishu message connector", () => {
	it("registers connector metadata and routes card sends", async () => {
		const runtime = Object.assign(Object.create(null) as IAgentRuntime, {
			registerMessageConnector: vi.fn(),
			registerSendHandler: vi.fn(),
			getRoom: vi.fn(),
		});
		const sendMessage = vi.fn();
		const service = Object.create(FeishuService.prototype) as FeishuService;
		Reflect.set(service, "client", {});
		Reflect.set(service, "messageManager", { sendMessage });

		FeishuService.registerSendHandlers(runtime, service);

		expect(runtime.registerMessageConnector).toHaveBeenCalledWith(
			expect.objectContaining({
				source: "feishu",
				label: "Feishu/Lark",
				capabilities: expect.arrayContaining(["send_message", "send_card"]),
				supportedTargetKinds: expect.arrayContaining(["group", "room"]),
			}),
		);

		const registration = vi.mocked(runtime.registerMessageConnector).mock
			.calls[0][0];
		expect(registration.sendHandler).toBeDefined();
		await registration.sendHandler?.(
			runtime,
			{ source: "feishu", channelId: "oc_test" } as TargetInfo,
			{
				text: "hello",
				data: {
					feishu: {
						card: {
							header: { title: { tag: "plain_text", content: "Update" } },
						},
					},
				},
			} as Content,
		);

		expect(sendMessage).toHaveBeenCalledWith(
			"oc_test",
			expect.objectContaining({
				text: "hello",
				card: expect.objectContaining({
					header: expect.any(Object),
				}),
			}),
		);
	});

	it("filters non-string media keys before sending", async () => {
		const runtime = Object.assign(Object.create(null) as IAgentRuntime, {
			registerMessageConnector: vi.fn(),
			registerSendHandler: vi.fn(),
			getRoom: vi.fn(),
		});
		const sendMessage = vi.fn();
		const service = Object.create(FeishuService.prototype) as FeishuService;
		Reflect.set(service, "client", {});
		Reflect.set(service, "messageManager", { sendMessage });

		await service.handleSendMessage(
			runtime,
			{ source: "feishu", channelId: "oc_test" } as TargetInfo,
			{
				text: "hello",
				data: {
					feishu: {
						imageKey: { nested: "not-a-key" },
						fileKey: ["not-a-key"],
					},
				},
			} as Content,
		);

		expect(sendMessage).toHaveBeenCalledWith("oc_test", { text: "hello" });
	});

	it("rejects sends without a resolvable Feishu chat target", async () => {
		const runtime = Object.assign(Object.create(null) as IAgentRuntime, {
			getRoom: vi.fn().mockResolvedValue({ id: "room_without_channel" }),
		});
		const service = Object.create(FeishuService.prototype) as FeishuService;
		Reflect.set(service, "messageManager", { sendMessage: vi.fn() });

		await expect(
			service.handleSendMessage(
				runtime,
				{ source: "feishu" } as TargetInfo,
				{ text: "hello" } as Content,
			),
		).rejects.toThrow("requires channelId or roomId");

		await expect(
			service.handleSendMessage(
				runtime,
				{ source: "feishu", roomId: "room_without_channel" } as TargetInfo,
				{ text: "hello" } as Content,
			),
		).rejects.toThrow("Could not resolve Feishu chat ID");
	});

	it("supports stored message fetch and search connector workflows", async () => {
		const roomId = "00000000-0000-0000-0000-000000000123";
		const runtime = Object.assign(Object.create(null) as IAgentRuntime, {
			agentId: "00000000-0000-0000-0000-000000000001",
			registerMessageConnector: vi.fn(),
			registerSendHandler: vi.fn(),
			getRoomsForParticipant: vi.fn().mockResolvedValue([roomId]),
			getRoom: vi.fn().mockResolvedValue({
				id: roomId,
				source: "feishu",
				channelId: "oc_recent",
				name: "Recent Chat",
				type: "group",
			}),
			getMemories: vi.fn().mockResolvedValue([
				{
					id: "m1",
					roomId,
					createdAt: 30,
					content: { text: "incident response update" },
				},
				{
					id: "m2",
					roomId,
					createdAt: 20,
					content: { text: "daily standup" },
				},
			]),
		});
		const service = Object.create(FeishuService.prototype) as FeishuService;
		Reflect.set(service, "client", {});
		Reflect.set(service, "messageManager", { sendMessage: vi.fn() });
		Reflect.set(service, "knownChats", new Map());

		FeishuService.registerSendHandlers(runtime, service);

		const registration = vi.mocked(runtime.registerMessageConnector).mock
			.calls[0][0];
		const fetched = await registration.fetchMessages?.(
			{ runtime, target: { source: "feishu", roomId } as TargetInfo },
			{ limit: 500 },
		);
		const searched = await registration.searchMessages?.(
			{ runtime, target: { source: "feishu", roomId } as TargetInfo },
			{ query: "incident", limit: 10 },
		);

		expect(runtime.getMemories).toHaveBeenCalledWith(
			expect.objectContaining({
				tableName: "messages",
				roomId,
				limit: 200,
				orderDirection: "desc",
			}),
		);
		expect(fetched).toHaveLength(2);
		expect(searched).toEqual([
			expect.objectContaining({
				content: expect.objectContaining({ text: "incident response update" }),
			}),
		]);
	});
});
