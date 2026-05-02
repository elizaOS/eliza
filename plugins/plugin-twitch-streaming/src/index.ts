/**
 * @elizaos/plugin-twitch -- Twitch RTMP streaming destination plugin.
 *
 * An elizaOS plugin that provides Twitch streaming capability via RTMP ingest.
 * Exports both the Plugin object (for elizaOS runtime) and a
 * `createTwitchDestination()` factory (for the Eliza streaming pipeline).
 *
 * For Twitch chat connectivity, use the separate @elizaos/plugin-twitch package.
 * This plugin handles only the streaming/RTMP side.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  buildPresetLayout,
  createStreamingPlugin,
  type StreamingDestination,
} from "@elizaos/plugin-streaming-base";

export type { StreamingDestination };

// ── Build plugin via shared factory ──────────────────────────────────────────

const { plugin, createDestination } = createStreamingPlugin({
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
});

// ── Public exports ──────────────────────────────────────────────────────────

export const twitchStreamingPlugin = plugin;

/**
 * Build a Twitch streaming destination.
 *
 * Backend (direct vs cloud relay) is selected by the shared factory based on
 * `TWITCH_STREAMING_BACKEND` (default `auto`). Pass `runtime` to enable cloud
 * relay; without a runtime the direct mode is always used.
 */
export function createTwitchDestination(
  runtime?: IAgentRuntime,
  config?: { streamKey?: string },
): StreamingDestination {
  return createDestination(runtime, config);
}

export default twitchStreamingPlugin;
