/**
 * Voice audio lane definitions (tts, music, sfx, ambient) and their default
 * mixing config, used by the voice sink to route concurrent audio streams.
 */
export const DISCORD_AUDIO_LANE_TTS = "tts";
export const DISCORD_AUDIO_LANE_MUSIC = "music";
export const DISCORD_AUDIO_LANE_SFX = "sfx";
export const DISCORD_AUDIO_LANE_AMBIENT = "ambient";

export type DiscordAudioLane =
	| typeof DISCORD_AUDIO_LANE_TTS
	| typeof DISCORD_AUDIO_LANE_MUSIC
	| typeof DISCORD_AUDIO_LANE_SFX
	| typeof DISCORD_AUDIO_LANE_AMBIENT
	| (string & {});

export interface DiscordAudioLaneConfig {
	lane: DiscordAudioLane;
	priority: number;
	canPause: boolean;
	interruptible: boolean;
	volume: number;
	duckVolume?: number;
}

export type DiscordAudioLaneConfigMap = Record<string, DiscordAudioLaneConfig>;

export const DEFAULT_DISCORD_AUDIO_LANES: DiscordAudioLaneConfigMap = {
	[DISCORD_AUDIO_LANE_TTS]: {
		lane: DISCORD_AUDIO_LANE_TTS,
		priority: 100,
		canPause: false,
		interruptible: false,
		volume: 1,
	},
	[DISCORD_AUDIO_LANE_MUSIC]: {
		lane: DISCORD_AUDIO_LANE_MUSIC,
		priority: 50,
		canPause: true,
		interruptible: true,
		volume: 1,
		duckVolume: 0.2,
	},
	[DISCORD_AUDIO_LANE_SFX]: {
		lane: DISCORD_AUDIO_LANE_SFX,
		priority: 30,
		canPause: false,
		interruptible: true,
		volume: 1,
	},
	[DISCORD_AUDIO_LANE_AMBIENT]: {
		lane: DISCORD_AUDIO_LANE_AMBIENT,
		priority: 20,
		canPause: false,
		interruptible: true,
		volume: 0.5,
		duckVolume: 0.1,
	},
};

export function normalizeDiscordAudioLane(
	lane?: DiscordAudioLane | null,
): DiscordAudioLane {
	const normalized = typeof lane === "string" ? lane.trim().toLowerCase() : "";
	return normalized || DISCORD_AUDIO_LANE_TTS;
}

export function getDiscordAudioLaneConfig(
	lanes: ReadonlyMap<string, DiscordAudioLaneConfig>,
	lane?: DiscordAudioLane | null,
): DiscordAudioLaneConfig {
	const normalized = normalizeDiscordAudioLane(lane);
	const existing = lanes.get(normalized);
	if (existing) {
		return existing;
	}

	return {
		lane: normalized,
		priority: 25,
		canPause: false,
		interruptible: true,
		volume: 1,
	};
}
