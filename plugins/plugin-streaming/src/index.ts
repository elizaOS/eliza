/**
 * @elizaos/plugin-streaming — RTMP destinations (Twitch, YouTube, X, pump.fun, custom/named ingest).
 */

export {
  getHeadlessCaptureConfig,
  parseDestinationQuery,
  readOverlayLayout,
  readStreamSettings,
  type StreamVisualSettings,
  type StreamVoiceSettings,
  safeDestId,
  seedOverlayDefaults,
  validateStreamSettings,
  writeOverlayLayout,
  writeStreamSettings,
} from "./api/stream-persistence.ts";
export type { StreamRouteState } from "./api/stream-route-state.ts";
export {
  detectCaptureMode,
  ensureXvfb,
  getActiveDestination,
  handleStreamRoute,
} from "./api/stream-routes.ts";
export {
  mergeStreamingText,
  resolveStreamingUpdate,
  type StreamingUpdate,
  type StreamingUpdateKind,
} from "./api/streaming-text.ts";
export { handleTtsRoutes, type TtsRouteContext } from "./api/tts-routes.ts";
export * from "./core.ts";
export {
  type AudioSource,
  type StreamConfig,
  streamManager,
} from "./services/stream-manager.ts";

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import {
  buildPresetLayout,
  buildStreamOpAction,
  createStreamingPlugin,
  type StreamingDestination,
  type StreamingPluginConfig,
  streamStatusProvider,
} from "./core.ts";

const TWITCH_CFG: StreamingPluginConfig = {
  platformId: "twitch",
  platformName: "Twitch",
  streamKeyEnvVar: "TWITCH_STREAM_KEY",
  defaultRtmpUrl: "rtmp://live.twitch.tv/app",
  cloudRelay: true,
  defaultOverlayLayout: buildPresetLayout("Twitch", [
    "viewer-count",
    "action-ticker",
    "branding",
  ]),
};

const YOUTUBE_CFG: StreamingPluginConfig = {
  platformId: "youtube",
  platformName: "YouTube",
  pluginName: "youtube",
  streamKeyEnvVar: "YOUTUBE_STREAM_KEY",
  defaultRtmpUrl: "rtmp://a.rtmp.youtube.com/live2",
  rtmpUrlEnvVar: "YOUTUBE_RTMP_URL",
  cloudRelay: true,
  defaultOverlayLayout: buildPresetLayout("YouTube", [
    "viewer-count",
    "thought-bubble",
    "branding",
  ]),
};

const X_CFG: StreamingPluginConfig = {
  platformId: "x",
  platformName: "X (Twitter)",
  streamKeyEnvVar: "X_STREAM_KEY",
  defaultRtmpUrl: "",
  rtmpUrlEnvVar: "X_RTMP_URL",
  cloudRelay: true,
  defaultOverlayLayout: buildPresetLayout("X", [
    "thought-bubble",
    "action-ticker",
    "branding",
  ]),
};

const PUMPFUN_CFG: StreamingPluginConfig = {
  platformId: "pumpfun",
  platformName: "pump.fun",
  streamKeyEnvVar: "PUMPFUN_STREAM_KEY",
  defaultRtmpUrl: "",
  rtmpUrlEnvVar: "PUMPFUN_RTMP_URL",
  cloudRelay: true,
  defaultOverlayLayout: buildPresetLayout("pump.fun", [
    "viewer-count",
    "action-ticker",
    "branding",
  ]),
};

const twitchBundle = createStreamingPlugin(TWITCH_CFG);
const youtubeBundle = createStreamingPlugin(YOUTUBE_CFG);
const xBundle = createStreamingPlugin(X_CFG);
const pumpfunBundle = createStreamingPlugin(PUMPFUN_CFG);

export function createTwitchDestination(
  runtime?: IAgentRuntime,
  config?: { streamKey?: string },
): StreamingDestination {
  return twitchBundle.createDestination(runtime, config);
}

export function createYoutubeDestination(
  runtime?: IAgentRuntime,
  config?: { streamKey?: string; rtmpUrl?: string },
): StreamingDestination {
  return youtubeBundle.createDestination(runtime, config);
}

export function createXStreamDestination(
  runtime?: IAgentRuntime,
  config?: { streamKey?: string; rtmpUrl?: string },
): StreamingDestination {
  return xBundle.createDestination(runtime, config);
}

export function createPumpfunDestination(
  runtime?: IAgentRuntime,
  config?: { streamKey?: string; rtmpUrl?: string },
): StreamingDestination {
  return pumpfunBundle.createDestination(runtime, config);
}

export const streamingPlugin: Plugin = {
  name: "streaming",
  description:
    "RTMP live streaming: Twitch, YouTube, X (Twitter), pump.fun, custom ingest URLs, and named RTMP sources.",

  get config() {
    const out: Record<string, string | null> = {};
    for (const cfg of [TWITCH_CFG, YOUTUBE_CFG, X_CFG, PUMPFUN_CFG]) {
      out[cfg.streamKeyEnvVar] = process.env[cfg.streamKeyEnvVar] ?? null;
      if (cfg.rtmpUrlEnvVar) {
        out[cfg.rtmpUrlEnvVar] = process.env[cfg.rtmpUrlEnvVar] ?? null;
      }
    }
    out.CUSTOM_RTMP_URL = process.env.CUSTOM_RTMP_URL ?? null;
    out.CUSTOM_RTMP_KEY = process.env.CUSTOM_RTMP_KEY ?? null;
    return out;
  },

  actions: [buildStreamOpAction()],
  providers: [streamStatusProvider],

  async init() {},
};

export default streamingPlugin;
