import type { ServerResponse } from "node:http";
import type { AgentRuntime } from "@elizaos/core";

type MusicTrack = {
  id?: string;
  title?: string;
  url?: string;
  duration?: number;
  requestedBy?: string;
  addedAt?: number;
};

type MusicServiceLike = {
  getQueues?: () => Map<string, unknown> | Iterable<[string, unknown]>;
  getCurrentTrack?: (guildId: string) => MusicTrack | null | undefined;
  getIsPaused?: (guildId: string) => boolean;
};

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function findActiveGuild(musicService: MusicServiceLike): {
  guildId: string;
  track: MusicTrack;
} | null {
  const queues = musicService.getQueues?.();
  if (!queues) {
    return null;
  }

  for (const entry of queues) {
    const guildId = Array.isArray(entry) ? entry[0] : null;
    if (typeof guildId !== "string" || guildId.length === 0) {
      continue;
    }
    const track = musicService.getCurrentTrack?.(guildId);
    if (track) {
      return { guildId, track };
    }
  }

  return null;
}

/**
 * Compatibility fallback for `/music-player/status`.
 *
 * The UI polls this route even when plugin-music-player is not enabled. When the
 * plugin route is absent, returning a stable JSON payload is better than a noisy
 * 404 loop in desktop logs.
 */
export function tryHandleMusicPlayerStatusFallback(options: {
  pathname: string;
  method: string;
  runtime: AgentRuntime | null | undefined;
  res: ServerResponse;
}): boolean {
  if (options.method !== "GET" || options.pathname !== "/music-player/status") {
    return false;
  }

  const musicService = options.runtime?.getService?.("music") as
    | MusicServiceLike
    | null
    | undefined;

  if (!musicService) {
    sendJson(options.res, 200, {
      available: false,
      error: "Music player plugin is not enabled",
    });
    return true;
  }

  const active = findActiveGuild(musicService);
  if (!active) {
    sendJson(options.res, 200, {
      available: true,
      error: "No track is currently playing",
    });
    return true;
  }

  sendJson(options.res, 200, {
    available: true,
    guildId: active.guildId,
    track: {
      id: active.track.id,
      title: active.track.title,
      url: active.track.url,
      duration: active.track.duration,
      requestedBy: active.track.requestedBy,
      addedAt: active.track.addedAt,
    },
    isPaused: musicService.getIsPaused?.(active.guildId) === true,
    streamUrl: `/music-player/stream?guildId=${encodeURIComponent(active.guildId)}`,
  });
  return true;
}
