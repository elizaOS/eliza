/**
 * Stream control actions — agents can go live or go offline.
 *
 * All actions hit the local Eliza API (127.0.0.1:API_PORT).
 *
 * @module actions/stream-control
 */

import type { Action } from "@elizaos/core";
import { hasOwnerAccess } from "../security/access.js";
import { hasContextSignalSyncForKey } from "./context-signal.js";

const API_PORT = process.env.API_PORT || process.env.SERVER_PORT || "2138";
const BASE = `http://127.0.0.1:${API_PORT}`;

async function apiPost(
  path: string,
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* ignore */
  }
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// GO_LIVE
// ---------------------------------------------------------------------------

export const goLiveAction: Action = {
  name: "GO_LIVE",
  similes: [
    "START_STREAM",
    "BEGIN_STREAM",
    "START_BROADCASTING",
    "GO_LIVE_NOW",
  ],
  description:
    "Start the live stream, broadcasting to the active destination (Twitch, YouTube, etc.).",
  validate: async (runtime, message, state) => {
    if (!(await hasOwnerAccess(runtime, message))) return false;
    return hasContextSignalSyncForKey(message, state, "stream_control");
  },

  handler: async (runtime, message) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner may control the live stream.",
        success: false,
      };
    }

    try {
      const result = await apiPost("/api/stream/live");
      if (!result.ok) {
        const msg =
          (result.data as Record<string, unknown>)?.error ??
          `HTTP ${result.status}`;
        return { text: `Failed to start stream: ${msg}`, success: false };
      }
      const data = result.data as Record<string, unknown>;
      return {
        text: data.live
          ? "Stream is now live! 🔴"
          : "Stream start requested but may not be live yet — check status.",
        success: true,
      };
    } catch (err) {
      return {
        text: `Failed to start stream: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
      };
    }
  },
  parameters: [],
};

// ---------------------------------------------------------------------------
// GO_OFFLINE
// ---------------------------------------------------------------------------

export const goOfflineAction: Action = {
  name: "GO_OFFLINE",
  similes: ["STOP_STREAM", "END_STREAM", "END_BROADCAST", "STOP_BROADCASTING"],
  description: "Stop the live stream and go offline.",
  validate: async (runtime, message, state) => {
    if (!(await hasOwnerAccess(runtime, message))) return false;
    return hasContextSignalSyncForKey(message, state, "stream_control");
  },

  handler: async (runtime, message) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner may control the live stream.",
        success: false,
      };
    }

    try {
      const result = await apiPost("/api/stream/offline");
      if (!result.ok) {
        const msg =
          (result.data as Record<string, unknown>)?.error ??
          `HTTP ${result.status}`;
        return { text: `Failed to stop stream: ${msg}`, success: false };
      }
      return { text: "Stream stopped. Now offline.", success: true };
    } catch (err) {
      return {
        text: `Failed to stop stream: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
      };
    }
  },
  parameters: [],
};
