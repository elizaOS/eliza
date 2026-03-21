/**
 * Custom RTMP streaming destination plugin.
 *
 * The simplest streaming destination — reads RTMP URL and key directly
 * from config. No platform API calls, no chat bridging.
 */

import type { StreamingDestination } from "../../api/stream-routes";

export function createCustomRtmpDestination(config?: {
  rtmpUrl?: string;
  rtmpKey?: string;
}): StreamingDestination {
  return {
    id: "custom-rtmp",
    name: "Custom RTMP",

    async getCredentials() {
      const rtmpUrl = (
        config?.rtmpUrl ??
        process.env.CUSTOM_RTMP_URL ??
        ""
      ).trim();
      const rtmpKey = (
        config?.rtmpKey ??
        process.env.CUSTOM_RTMP_KEY ??
        ""
      ).trim();

      if (!rtmpUrl || !rtmpKey) {
        throw new Error(
          "Custom RTMP requires rtmpUrl and rtmpKey in streaming.customRtmp config",
        );
      }
      return { rtmpUrl, rtmpKey };
    },
    // No onStreamStart/onStreamStop — no platform to notify
    // No chat polling — no platform chat
  };
}
