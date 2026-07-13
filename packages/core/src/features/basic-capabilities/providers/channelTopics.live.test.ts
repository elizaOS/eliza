/**
 * Proves the real CHANNEL_TOPICS provider context reaches a live model through AgentRuntime.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { describeLive } from "../../../../../app-core/test/helpers/live-agent-test";
import { ChannelTopicsService } from "../../../services/channel-topics";
import { ChannelType, type Memory, ModelType, type UUID } from "../../../types";

const requiredProviderEnv = process.env.OPENAI_API_KEY?.trim()
	? "OPENAI_API_KEY"
	: "CEREBRAS_API_KEY";
const liveOptIn = process.env.ELIZA_LIVE_TEST === "1";

if (!liveOptIn) {
	process.env.SKIP_REASON ||= "set ELIZA_LIVE_TEST=1 to run live model proof";
	describe("CHANNEL_TOPICS provider live model receipt", () => {
		it.skip("requires ELIZA_LIVE_TEST=1", () => {});
	});
} else {
	await describeLive(
		"CHANNEL_TOPICS provider live model receipt",
		{ requiredEnv: [requiredProviderEnv] },
		({ harness }) => {
			it("injects persisted room topics into a real model request", async () => {
				const { runtime, agentId } = harness();
				const worldId = randomUUID() as UUID;
				const roomId = randomUUID() as UUID;
				const entityId = randomUUID() as UUID;
				await runtime.createWorld({
					id: worldId,
					name: "channel-topics-live-world",
					agentId: agentId as UUID,
				});
				await runtime.ensureRoomExists({
					id: roomId,
					name: "channel-topics-live-room",
					source: "live-test",
					type: ChannelType.API,
					worldId,
				});
				await runtime.createEntity({
					id: entityId,
					names: ["ChannelTopicsLiveUser"],
					agentId: agentId as UUID,
				});
				await runtime.ensureParticipantInRoom(entityId, roomId);

				const service = runtime.getService<ChannelTopicsService>(
					ChannelTopicsService.serviceType,
				);
				if (!service) throw new Error("ChannelTopicsService is not registered");
				await service.recordTopics(roomId, [
					"invoice reconciliation",
					"payment retries",
				]);

				const message: Memory = {
					id: randomUUID() as UUID,
					agentId: agentId as UUID,
					entityId,
					roomId,
					createdAt: Date.now(),
					content: {
						text: "Name the two current channel topics.",
						source: "live-test",
					},
				};
				const state = await runtime.composeState(
					message,
					["CHANNEL_TOPICS"],
					true,
					true,
				);
				expect(state.text).toContain("payment retries, invoice reconciliation");

				const prompt = [
					"Use only the provider context below.",
					"Return the two topic names, with no extra commentary.",
					state.text,
				].join("\n");
				const output = await runtime.useModel(ModelType.TEXT_SMALL, { prompt });
				expect(typeof output).toBe("string");
				expect(output.toLowerCase()).toContain("invoice reconciliation");
				expect(output.toLowerCase()).toContain("payment retries");

				const room = await runtime.getRoom(roomId);
				process.stdout.write(
					`${JSON.stringify(
						{
							evidence: "exact-head-channel-topics-live-provider-receipt",
							providerContext: state.text,
							modelOutput: output,
							roomMetadata: room?.metadata,
						},
						null,
						2,
					)}\n`,
				);
			}, 120_000);
		},
	);
}
