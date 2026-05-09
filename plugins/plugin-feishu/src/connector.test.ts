import type { Content, IAgentRuntime, TargetInfo } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { FeishuService } from "./service";

describe("Feishu message connector", () => {
	it("registers connector metadata and routes card sends", async () => {
		const runtime = {
			registerMessageConnector: vi.fn(),
			registerSendHandler: vi.fn(),
			getRoom: vi.fn(),
		} as IAgentRuntime;
		type TestFeishuService = FeishuService & {
			client: unknown;
			messageManager: { sendMessage: typeof sendMessage };
		};
		const service = Object.create(FeishuService.prototype) as TestFeishuService;
		const sendMessage = vi.fn();
		service.client = {};
		service.messageManager = { sendMessage };

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
});
