/** Unit tests for the Discord audio-lane config resolution. Pure-function assertions. */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_DISCORD_AUDIO_LANES,
	DISCORD_AUDIO_LANE_MUSIC,
	DISCORD_AUDIO_LANE_TTS,
	getDiscordAudioLaneConfig,
	normalizeDiscordAudioLane,
} from "../audio-lanes";

describe("Discord audio lanes", () => {
	it("normalizes blank lanes to TTS", () => {
		expect(normalizeDiscordAudioLane(undefined)).toBe(DISCORD_AUDIO_LANE_TTS);
		expect(normalizeDiscordAudioLane("")).toBe(DISCORD_AUDIO_LANE_TTS);
		expect(normalizeDiscordAudioLane(" MUSIC ")).toBe(DISCORD_AUDIO_LANE_MUSIC);
	});

	it("loads default priorities instead of flattening every lane", () => {
		const lanes = new Map(
			Object.entries(DEFAULT_DISCORD_AUDIO_LANES).map(([lane, config]) => [
				lane,
				config,
			]),
		);

		expect(
			getDiscordAudioLaneConfig(lanes, DISCORD_AUDIO_LANE_TTS).priority,
		).toBe(100);
		expect(
			getDiscordAudioLaneConfig(lanes, DISCORD_AUDIO_LANE_MUSIC).priority,
		).toBe(50);
		expect(getDiscordAudioLaneConfig(lanes, "custom").priority).toBe(25);
	});
});
