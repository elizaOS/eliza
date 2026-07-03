import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DISCORD_AUDIO_LANE_MUSIC } from "../audio-lanes";
import { DiscordVoiceTargetRegistry } from "../voice-target-registry";

function createChannel(id: string, guildId = "guild-1") {
	return {
		id,
		name: `channel-${id}`,
		guild: {
			id: guildId,
			name: `guild-${guildId}`,
		},
	};
}

describe("DiscordVoiceTargetRegistry", () => {
	it("registers, finds, and unregisters account-scoped voice targets", async () => {
		const registry = new DiscordVoiceTargetRegistry();
		const play = vi.fn(async () => ({
			finished: Promise.resolve(),
			cancelled: Promise.resolve(),
			abort: vi.fn(),
		}));
		const stop = vi.fn(async () => {});

		const target = registry.register({
			accountId: "music",
			botId: "bot-1",
			channel: createChannel("voice-1") as never,
			play,
			stop,
			getStatus: () => "connected",
			getLaneConfig: () => ({
				lane: DISCORD_AUDIO_LANE_MUSIC,
				priority: 50,
				canPause: true,
				interruptible: true,
				volume: 1,
			}),
		});

		expect(registry.get(target.id)).toBe(target);
		expect(
			registry.find({
				accountId: "music",
				guildId: "guild-1",
				channelId: "voice-1",
			}),
		).toBe(target);

		await target.play(new PassThrough(), { lane: DISCORD_AUDIO_LANE_MUSIC });
		await target.stop(DISCORD_AUDIO_LANE_MUSIC);

		expect(play).toHaveBeenCalledWith(expect.any(PassThrough), {
			lane: DISCORD_AUDIO_LANE_MUSIC,
		});
		expect(stop).toHaveBeenCalledWith(DISCORD_AUDIO_LANE_MUSIC);

		registry.unregister("music", "guild-1", "voice-1");
		expect(registry.get(target.id)).toBeNull();
	});
});
