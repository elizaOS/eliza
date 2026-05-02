/**
 * @elizaos/plugin-x-streaming -- X (Twitter) RTMP streaming destination plugin.
 *
 * An elizaOS plugin that provides X/Twitter streaming capability via RTMPS.
 * X provides unique RTMP URLs per stream session from studio.x.com — users
 * must paste both URL and key into config.
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
  platformId: "x",
  platformName: "X (Twitter)",
  streamKeyEnvVar: "X_STREAM_KEY",
  defaultRtmpUrl: "", // User provides from studio.x.com — varies per session
  rtmpUrlEnvVar: "X_RTMP_URL",
  cloudRelay: true,
  defaultOverlayLayout: buildPresetLayout("X", [
    "thought-bubble",
    "action-ticker",
    "branding",
  ]),
});

// ── Public exports ──────────────────────────────────────────────────────────

export const xStreamingPlugin = plugin;

/**
 * Build an X (Twitter) streaming destination. Backend (direct vs cloud relay)
 * is selected by `X_STREAMING_BACKEND` (default `auto`). Pass `runtime` to
 * enable cloud relay; without a runtime the direct mode is always used.
 */
export function createXStreamDestination(
  runtime?: IAgentRuntime,
  config?: { streamKey?: string; rtmpUrl?: string },
): StreamingDestination {
  return createDestination(runtime, config);
}

export default xStreamingPlugin;
