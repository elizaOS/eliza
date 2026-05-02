/**
 * Retake.tv streaming destination adapter.
 *
 * Provides `createRetakeDestination()` — a factory that returns a
 * `StreamingDestination` for the Retake.tv platform.
 *
 * Two backends:
 *  - **direct** (default; Mode A): RTMP credentials are fetched from the
 *    retake.tv API using a per-user `RETAKE_AGENT_TOKEN`. Session start /
 *    stop calls hit retake.tv directly.
 *  - **cloud relay** (Mode B): the destination requests a per-session
 *    ingest URL + stream key from Eliza Cloud, which fans out to the user's
 *    stored retake destination. Activated via `RETAKE_STREAMING_BACKEND`
 *    (`direct` | `cloud` | `auto`, default `auto`). `auto` picks `cloud`
 *    when Eliza Cloud is connected and no `RETAKE_AGENT_TOKEN` is set.
 *
 * NOTE: Only the RTMP destination side moves to cloud relay. Chat polling
 * (chat-poll.ts) continues to talk to retake.tv directly using the user's
 * bearer token — there is no benefit to proxying low-volume polling traffic.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  buildPresetLayout,
  createCloudRelayDestination,
  resolveStreamingBackend,
  type StreamingPluginConfig,
} from "@elizaos/plugin-streaming-base";
import type { StreamingDestination } from "./types.ts";

const RETAKE_BACKEND_CFG: StreamingPluginConfig = {
  platformId: "retake",
  platformName: "Retake.tv",
  streamKeyEnvVar: "RETAKE_AGENT_TOKEN",
  defaultRtmpUrl: "",
  cloudRelay: true,
};

export function createRetakeDestination(
  runtime?: IAgentRuntime,
  config?: { accessToken?: string; apiUrl?: string },
): StreamingDestination {
  if (runtime) {
    const backend = resolveStreamingBackend(runtime, RETAKE_BACKEND_CFG);
    if (backend === "cloud") {
      return createCloudRelayDestination({
        platformId: "retake",
        platformName: "Retake.tv",
        runtime,
        defaultOverlayLayout: buildPresetLayout("Retake", [
          "thought-bubble",
          "alert-popup",
          "branding",
        ]),
      });
    }
  }
  return {
    id: "retake",
    name: "Retake.tv",
    defaultOverlayLayout: buildPresetLayout("Retake", [
      "thought-bubble",
      "alert-popup",
      "branding",
    ]),

    async getCredentials() {
      const token = (
        config?.accessToken ??
        process.env.RETAKE_AGENT_TOKEN ??
        ""
      ).trim();
      if (!token) throw new Error("Retake access token not configured");

      const apiUrl = (
        config?.apiUrl ??
        process.env.RETAKE_API_URL ??
        "https://retake.tv/api/v1"
      ).trim();
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };

      const rtmpRes = await fetch(`${apiUrl}/agent/rtmp`, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      if (!rtmpRes.ok) {
        throw new Error(`RTMP creds failed: ${rtmpRes.status}`);
      }
      const { url: rtmpUrl, key: rtmpKey } = (await rtmpRes.json()) as {
        url: string;
        key: string;
      };
      return { rtmpUrl, rtmpKey };
    },

    async onStreamStart() {
      const token = (
        config?.accessToken ??
        process.env.RETAKE_AGENT_TOKEN ??
        ""
      ).trim();
      if (!token) return;

      const apiUrl = (
        config?.apiUrl ??
        process.env.RETAKE_API_URL ??
        "https://retake.tv/api/v1"
      ).trim();
      const res = await fetch(`${apiUrl}/agent/stream/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`retake.tv start failed: ${res.status} ${text}`);
      }
    },

    async onStreamStop() {
      const token = (
        config?.accessToken ??
        process.env.RETAKE_AGENT_TOKEN ??
        ""
      ).trim();
      if (!token) return;

      const apiUrl = (
        config?.apiUrl ??
        process.env.RETAKE_API_URL ??
        "https://retake.tv/api/v1"
      ).trim();
      await fetch(`${apiUrl}/agent/stream/stop`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => {});
    },
  };
}
