import type { VoiceManagerLike } from "./queue";

/**
 * Voice channel shape used by PLAY_AUDIO — only fields the action reads.
 */
export interface BaseGuildVoiceChannel {
  guild: { members?: { me?: { voice?: { channel: unknown } } } };
  members?: Map<string, { voice?: { channel: unknown } }>;
}

export interface MusicVoiceRegisterConfig {
  channel: number;
  priority: number;
  canPause: boolean;
  interruptible: boolean;
  volume: number;
  duckVolume: number;
}

/** Connection / registration surface used when joining Discord voice for playback. */
export interface DiscordVoiceConnectionExtensions {
  getVoiceConnection(guildId: string): unknown;
  joinChannel(channel: BaseGuildVoiceChannel): Promise<void>;
  on(
    event: "registerChannel",
    listener: (config: MusicVoiceRegisterConfig) => void,
  ): void;
  emit(event: "registerChannel", config: MusicVoiceRegisterConfig): boolean;
}

export type MusicPlayerDiscordVoiceManager = VoiceManagerLike &
  DiscordVoiceConnectionExtensions;

export interface DiscordGuildMemberVoice {
  voice?: { channel: BaseGuildVoiceChannel };
}

export interface DiscordGuildLike {
  members: {
    me?: DiscordGuildMemberVoice | null;
    fetch(userId: string): Promise<DiscordGuildMemberVoice | null>;
  };
}

export interface DiscordClientLike {
  guilds: {
    fetch(guildId: string): Promise<DiscordGuildLike>;
  };
}

export interface DiscordPluginServiceLike {
  client: DiscordClientLike;
  voiceManager?: MusicPlayerDiscordVoiceManager;
}

export function isDiscordPluginServiceLike(
  service: unknown,
): service is DiscordPluginServiceLike {
  if (typeof service !== "object" || service === null) return false;
  if (!("client" in service)) return false;
  const client = (service as { client: unknown }).client;
  if (typeof client !== "object" || client === null) return false;
  const guilds = (client as { guilds?: unknown }).guilds;
  if (typeof guilds !== "object" || guilds === null) return false;
  return typeof (guilds as { fetch?: unknown }).fetch === "function";
}
