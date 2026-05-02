/**
 * @elizaos/plugin-youtube -- YouTube RTMP streaming destination plugin.
 *
 * An elizaOS plugin that provides YouTube streaming capability via RTMP ingest.
 * Exports both the Plugin object (for elizaOS runtime) and a
 * `createYoutubeDestination()` factory (for the Eliza streaming pipeline).
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
});

// ── Public exports ──────────────────────────────────────────────────────────

export const youtubePlugin = plugin;

/**
 * Build a YouTube streaming destination. Backend (direct vs cloud relay) is
 * selected by `YOUTUBE_STREAMING_BACKEND` (default `auto`). Pass `runtime` to
 * enable cloud relay; without a runtime the direct mode is always used.
 */
export function createYoutubeDestination(
  runtime?: IAgentRuntime,
  config?: { streamKey?: string; rtmpUrl?: string },
): StreamingDestination {
  return createDestination(runtime, config);
}

export default youtubePlugin;
