/**
 * @elizaos/plugin-streaming — RTMP destinations (Twitch, YouTube, X, pump.fun, custom/named ingest).
 */

export * from "./core.ts";

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import {
  buildPresetLayout,
  buildStreamingPipelineActions,
  createStreamingPlugin,
  type StreamingDestination,
  type StreamingPluginConfig,
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

const PRESET_PLATFORM_LABELS = [
  TWITCH_CFG.platformName,
  YOUTUBE_CFG.platformName,
  X_CFG.platformName,
  PUMPFUN_CFG.platformName,
] as const;

function legacyPlannerSimiles(): {
  start: string[];
  stop: string[];
  status: string[];
} {
  const start: string[] = [
    "START_STREAM",
    "GO_LIVE",
    "START_LIVE",
    "BEGIN_STREAM",
    "STREAM_GO_LIVE",
  ];
  const stop: string[] = [
    "STOP_STREAM",
    "GO_OFFLINE",
    "END_STREAM",
    "STREAM_GO_OFFLINE",
  ];
  const status: string[] = [
    "GET_STREAM_STATUS",
    "STREAM_STATUS",
    "IS_LIVE",
    "CHECK_STREAM",
  ];

  for (const label of PRESET_PLATFORM_LABELS) {
    const U = label.toUpperCase();
    start.push(
      `START_${U}_STREAM`,
      `GO_LIVE_${U}`,
      `START_${U}`,
      `BEGIN_${U}_STREAM`,
      `${U}_GO_LIVE`,
    );
    stop.push(
      `STOP_${U}_STREAM`,
      `GO_OFFLINE_${U}`,
      `STOP_${U}`,
      `END_${U}_STREAM`,
      `${U}_GO_OFFLINE`,
    );
    status.push(
      `GET_${U}_STREAM_STATUS`,
      `${U}_STATUS`,
      `${U}_STREAM_STATUS`,
      `IS_${U}_LIVE`,
      `CHECK_${U}_STREAM`,
    );
  }
  return { start, stop, status };
}

const plannerSimiles = legacyPlannerSimiles();

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

  actions: buildStreamingPipelineActions({
    upperToken: "RTMP",
    displayName: "RTMP stream",
    validate: async () => true,
    extraStartSimiles: plannerSimiles.start,
    extraStopSimiles: plannerSimiles.stop,
    extraStatusSimiles: plannerSimiles.status,
  }),

  async init() {},
};

export default streamingPlugin;
