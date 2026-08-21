/**
 * Runs BlueBubbles egress through the real scenario AgentRuntime, production
 * service/client, and plugin-owned v1 loopback without any model call. The
 * resulting receipt is mock-only and does not qualify a live provider.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import { BlueBubblesService } from "../../src/service.js";
import { startBlueBubblesLoopback } from "../../src/testing/loopback.js";

const CHAT_GUID = "iMessage;-;+14155552671";
const PASSWORD = "scenario-password";

interface ScenarioResult {
	receiptCount: number;
	mockOnly: boolean;
	chatGuid: string | undefined;
}

const results = new WeakMap<IAgentRuntime, ScenarioResult>();

export default scenario({
	id: "bluebubbles.loopback-egress",
	lane: "pr-deterministic",
	modelFixtures: {
		mode: "model-free",
		reason:
			"The direct connector send exercises a real runtime and local protocol boundary without model calls.",
	},
	title: "BlueBubbles egress over the deterministic external-server loopback",
	domain: "messaging",
	tags: ["bluebubbles", "connector", "mock-only", "deterministic"],
	status: "active",
	isolation: "per-scenario",
	rooms: [
		{
			id: "main",
			source: "dashboard",
			channelType: "DM",
			title: "BlueBubbles loopback",
		},
	],
	seed: [
		{
			type: "custom",
			name: "send through the production BlueBubbles connector",
			apply: async (ctx) => {
				const runtime = ctx.runtime;
				const upstream = await startBlueBubblesLoopback({
					now: () => Date.parse("2032-04-05T06:07:08.000Z"),
					accounts: [
						{
							accountId: "scenario",
							password: PASSWORD,
							chats: [
								{
									guid: CHAT_GUID,
									chatIdentifier: "+14155552671",
									displayName: "Scenario contact",
									participants: [
										{ address: "+14155552671", service: "iMessage" },
									],
								},
							],
						},
					],
				});
				const originalGetSetting = runtime.getSetting.bind(runtime);
				const settings: Record<string, string> = {
					BLUEBUBBLES_SERVER_URL: upstream.url,
					BLUEBUBBLES_PASSWORD: PASSWORD,
					BLUEBUBBLES_DM_POLICY: "open",
					BLUEBUBBLES_SEND_READ_RECEIPTS: "false",
				};
				runtime.getSetting = (key: string) =>
					settings[key] ?? originalGetSetting(key);
				let service: BlueBubblesService | undefined;
				try {
					service = await BlueBubblesService.start(runtime);
					if (!service.getIsRunning()) {
						return "BlueBubblesService did not connect to the loopback";
					}
					BlueBubblesService.registerSendHandlers(runtime, service);
					const sent = await runtime.sendMessageToTarget(
						{
							source: "bluebubbles",
							channelId: CHAT_GUID,
							roomId: ctx.primaryRoomId,
						},
						{ text: "deterministic BlueBubbles send", agentVoiced: true },
					);
					const memory =
						sent && "kind" in sent
							? sent.kind === "delivered" || sent.kind === "partially_delivered"
								? sent.memories[0]
								: undefined
							: (sent as Memory | undefined);
					const effectReceipts = upstream.receipts.filter(
						(receipt) => receipt.kind === "effect",
					);
					results.set(runtime, {
						receiptCount: effectReceipts.length,
						mockOnly: effectReceipts.every(
							(receipt) => receipt.evidence === "mock-only",
						),
						chatGuid: (memory?.metadata as Record<string, unknown> | undefined)
							?.bluebubblesChatGuid as string | undefined,
					});
					return undefined;
				} finally {
					runtime.getSetting = originalGetSetting;
					if (service) await service.stop();
					await upstream.stop();
				}
			},
		},
	],
	turns: [],
	finalChecks: [
		{
			type: "custom",
			name: "one explicitly mock-only BlueBubbles delivery is recorded",
			predicate: (ctx) => {
				const result = results.get(ctx.runtime);
				if (!result) return "scenario did not record a BlueBubbles result";
				if (result.receiptCount !== 1) {
					return `expected one delivery effect, saw ${result.receiptCount}`;
				}
				if (!result.mockOnly) return "loopback receipt was not marked mock-only";
				if (result.chatGuid !== CHAT_GUID) {
					return `production connector returned chat ${String(result.chatGuid)}`;
				}
				return undefined;
			},
		},
	],
});
