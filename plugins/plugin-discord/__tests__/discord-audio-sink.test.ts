import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { DISCORD_AUDIO_LANE_MUSIC } from "../audio-lanes";
import { DiscordVoiceTargetAudioSink } from "../discord-audio-sink";
import type { DiscordVoiceTarget } from "../voice-target-registry";

function createTarget(
	overrides?: Partial<DiscordVoiceTarget>,
): DiscordVoiceTarget {
	return {
		id: "account:guild:voice",
		accountId: "account",
		botId: "bot",
		guildId: "guild",
		channelId: "voice",
		channelName: "Voice",
		play: vi.fn(async () => ({
			finished: Promise.resolve(),
			cancelled: Promise.resolve(),
			abort: vi.fn(),
		})),
		stop: vi.fn(async () => {}),
		getStatus: vi.fn(() => "connected"),
		getLaneConfig: vi.fn(() => ({
			lane: DISCORD_AUDIO_LANE_MUSIC,
			priority: 50,
			canPause: true,
			interruptible: true,
			volume: 1,
		})),
		...overrides,
	};
}

describe("DiscordVoiceTargetAudioSink", () => {
	it("proxies playback and lane stops to the registered voice target", async () => {
		const target = createTarget();
		const sink = new DiscordVoiceTargetAudioSink(target);
		const stream = new PassThrough();

		await sink.play(stream, { lane: DISCORD_AUDIO_LANE_MUSIC });
		await sink.stop(DISCORD_AUDIO_LANE_MUSIC);

		expect(target.play).toHaveBeenCalledWith(stream, {
			lane: DISCORD_AUDIO_LANE_MUSIC,
		});
		expect(target.stop).toHaveBeenCalledWith(DISCORD_AUDIO_LANE_MUSIC);
	});

	it("stops active target playback when destroyed", async () => {
		const target = createTarget();
		const sink = new DiscordVoiceTargetAudioSink(target);

		sink.destroy();
		await Promise.resolve();
		sink.destroy();
		await sink.stop(DISCORD_AUDIO_LANE_MUSIC);

		expect(target.stop).toHaveBeenCalledTimes(1);
		expect(target.stop).toHaveBeenCalledWith(undefined);
		expect(sink.status).toBe("disconnected");
		await expect(sink.play(new PassThrough())).rejects.toThrow(
			"has been destroyed",
		);
	});
});
