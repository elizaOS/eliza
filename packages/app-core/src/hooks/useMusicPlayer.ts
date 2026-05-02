import { useCallback, useEffect, useState } from "react";
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";
import { getBootConfig } from "../config/boot-config";
import { getElizaApiBase } from "../utils/eliza-globals";

/**
 * Default guild/room id for plugin-music-player when Discord is not used.
 * Keep in sync with `ELIZA_DESKTOP_MUSIC_GUILD_ID` in Electrobun `music-player.ts`.
 */
export const ELIZA_DESKTOP_MUSIC_GUILD_ID = "elizaos-desktop";

/**
 * Guild key used by plugin-music-player for web chat — must match
 * `playAudio` / `queueMusic` (`web-${message.roomId}` when `room.serverId` is unset).
 */
export function getWebMusicGuildIdFromRoomId(
  roomId: string | null | undefined,
): string {
  const r = roomId?.trim();
  if (!r) {
    return ELIZA_DESKTOP_MUSIC_GUILD_ID;
  }
  return `web-${r}`;
}

export type MusicPlaybackUrls = {
  apiBase: string;
  guildId: string;
  streamUrl: string;
  nowPlayingUrl: string;
  queueUrl: string;
};

export function buildMusicPlayerPaths(guildId: string): {
  stream: string;
  file: string;
  nowPlaying: string;
  queue: string;
} {
  const g = encodeURIComponent(guildId);
  return {
    stream: `/music-player/stream?guildId=${g}`,
    file: `/music-player/file?guildId=${g}`,
    nowPlaying: `/music-player/now-playing?guildId=${g}`,
    queue: `/music-player/queue?guildId=${g}`,
  };
}

/**
 * Resolve the API base using the same chain as ElizaClient / resolveApiUrl:
 * boot config → shell injection → sessionStorage → "" (same origin).
 * An empty string means relative URLs go through the Vite dev proxy.
 */
function resolveApiBase(): string {
  const boot = getBootConfig().apiBase?.trim();
  if (boot) return boot;
  const injected = getElizaApiBase();
  if (injected) return injected;
  if (typeof window !== "undefined") {
    const stored = window.sessionStorage.getItem("elizaos_api_base")?.trim();
    if (stored) return stored;
  }
  return "";
}

type RpcPlaybackPayload = {
  ok: boolean;
  reason?: string;
  apiBase?: string;
  guildId?: string;
  streamUrl?: string;
  nowPlayingUrl?: string;
  queueUrl?: string;
};

/**
 * Resolves absolute URLs for plugin-music-player HTTP routes.
 * On Electrobun, prefers the main-process URL resolution (direct agent port).
 * Otherwise uses the same API base chain as the rest of the app (boot config →
 * shell injection → sessionStorage → same origin via empty string, which lets
 * the Vite dev proxy forward `/music-player/*` to the agent).
 */
export async function resolveMusicPlayerPlaybackUrls(options?: {
  guildId?: string;
}): Promise<
  ({ ok: true } & MusicPlaybackUrls) | { ok: false; reason: string }
> {
  const guildId = options?.guildId?.trim() || ELIZA_DESKTOP_MUSIC_GUILD_ID;

  const desktop = await invokeDesktopBridgeRequest<RpcPlaybackPayload>({
    rpcMethod: "musicPlayerGetDesktopPlaybackUrls",
    ipcChannel: "musicPlayer:getDesktopPlaybackUrls",
    params: { guildId },
  });

  if (
    desktop &&
    desktop.ok === true &&
    typeof desktop.streamUrl === "string" &&
    typeof desktop.guildId === "string" &&
    typeof desktop.apiBase === "string" &&
    typeof desktop.nowPlayingUrl === "string" &&
    typeof desktop.queueUrl === "string"
  ) {
    return {
      ok: true,
      apiBase: desktop.apiBase,
      guildId: desktop.guildId,
      streamUrl: desktop.streamUrl,
      nowPlayingUrl: desktop.nowPlayingUrl,
      queueUrl: desktop.queueUrl,
    };
  }

  const root = resolveApiBase().replace(/\/$/, "");
  const paths = buildMusicPlayerPaths(guildId);
  return {
    ok: true,
    apiBase: root,
    guildId,
    streamUrl: `${root}${paths.stream}`,
    nowPlayingUrl: `${root}${paths.nowPlaying}`,
    queueUrl: `${root}${paths.queue}`,
  };
}

/**
 * Loads playback URLs for the music player stream. Use `attachStreamToAudioElement`
 * to point an `<audio>` element at the Ogg Opus stream when a track is playing.
 */
export function useMusicPlayerStream(options?: { guildId?: string }): {
  urls:
    | ({ ok: true } & MusicPlaybackUrls)
    | { ok: false; reason: string }
    | null;
  attachStreamToAudioElement: (el: HTMLAudioElement | null) => void;
} {
  const guildId = options?.guildId ?? ELIZA_DESKTOP_MUSIC_GUILD_ID;
  const [urls, setUrls] = useState<
    ({ ok: true } & MusicPlaybackUrls) | { ok: false; reason: string } | null
  >(null);

  useEffect(() => {
    let alive = true;
    void resolveMusicPlayerPlaybackUrls({ guildId }).then((r) => {
      if (alive) setUrls(r);
    });
    return () => {
      alive = false;
    };
  }, [guildId]);

  const attachStreamToAudioElement = useCallback(
    (el: HTMLAudioElement | null) => {
      if (!el || !urls?.ok) return;
      el.crossOrigin = "anonymous";
      if (el.src !== urls.streamUrl) {
        el.src = urls.streamUrl;
        el.load();
      }
    },
    [urls],
  );

  return { urls, attachStreamToAudioElement };
}
