/**
 * @elizaos/plugin-pumpfun -- pump.fun RTMP streaming destination plugin.
 *
 * An elizaOS plugin that provides pump.fun streaming capability via RTMP.
 * pump.fun provides unique RTMP URLs per stream session — users must paste
 * both URL and key from the pump.fun UI into config.
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
  platformId: "pumpfun",
  platformName: "pump.fun",
  streamKeyEnvVar: "PUMPFUN_STREAM_KEY",
  defaultRtmpUrl: "", // User must provide — pump.fun gives unique URL per stream
  rtmpUrlEnvVar: "PUMPFUN_RTMP_URL",
  cloudRelay: true,
  defaultOverlayLayout: buildPresetLayout("pump.fun", [
    "viewer-count",
    "action-ticker",
    "branding",
  ]),
});

// ── Public exports ──────────────────────────────────────────────────────────

export const pumpfunStreamingPlugin = plugin;

/**
 * Build a pump.fun streaming destination. Backend (direct vs cloud relay) is
 * selected by `PUMPFUN_STREAMING_BACKEND` (default `auto`). Pass `runtime` to
 * enable cloud relay; without a runtime the direct mode is always used.
 */
export function createPumpfunDestination(
  runtime?: IAgentRuntime,
  config?: { streamKey?: string; rtmpUrl?: string },
): StreamingDestination {
  return createDestination(runtime, config);
}

export default pumpfunStreamingPlugin;
