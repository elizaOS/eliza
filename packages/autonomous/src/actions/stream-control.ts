/**
 * Stream control actions — agents can go live, go offline, switch
 * destinations, speak via TTS, and manage overlay widgets.
 *
 * All actions hit the local Milady API (127.0.0.1:API_PORT).
 *
 * @module actions/stream-control
 */

import type { Action } from "@elizaos/core";

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

async function apiGet(
  path: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
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
    "Start the live stream, broadcasting to the active destination (Twitch, YouTube, Retake.tv, etc.).",
  validate: async () => true,

  handler: async () => {
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
  validate: async () => true,

  handler: async () => {
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

// ---------------------------------------------------------------------------
// SET_STREAM_DESTINATION
// ---------------------------------------------------------------------------

export const setStreamDestinationAction: Action = {
  name: "SET_STREAM_DESTINATION",
  similes: [
    "SWITCH_STREAM_DESTINATION",
    "CHANGE_CHANNEL",
    "SWITCH_CHANNEL",
    "SELECT_DESTINATION",
  ],
  description:
    "Switch the active streaming destination (e.g. switch from Twitch to YouTube). " +
    "The stream must be offline before switching.",
  validate: async () => true,

  handler: async (_runtime, _message, _state, options) => {
    try {
      const params = (
        options as { parameters?: Record<string, unknown> } | undefined
      )?.parameters;
      const destinationId =
        typeof params?.destinationId === "string"
          ? params.destinationId.trim()
          : "";
      const destinationName =
        typeof params?.destinationName === "string"
          ? params.destinationName.trim()
          : "";

      if (!destinationId && !destinationName) {
        // List available destinations so the agent can choose
        const listResult = await apiGet("/api/streaming/destinations");
        if (!listResult.ok) {
          return {
            text: "Could not fetch destinations. API may be unavailable.",
            success: false,
          };
        }
        const data = listResult.data as Record<string, unknown>;
        const dests = (data.destinations ?? []) as Array<{
          id: string;
          name: string;
        }>;
        if (dests.length === 0) {
          return {
            text: "No streaming destinations configured. Install a streaming plugin first.",
            success: false,
          };
        }
        const list = dests.map((d) => `- ${d.name} (id: ${d.id})`).join("\n");
        return {
          text: `Available destinations:\n${list}\n\nCall again with destinationId set.`,
          success: false,
        };
      }

      // Resolve by id or name
      const listResult = await apiGet("/api/streaming/destinations");
      const dests = (
        listResult.ok
          ? ((listResult.data as Record<string, unknown>).destinations ?? [])
          : []
      ) as Array<{ id: string; name: string }>;

      const target =
        dests.find((d) => d.id === destinationId) ??
        dests.find(
          (d) => d.name.toLowerCase() === destinationName.toLowerCase(),
        );

      if (!target) {
        const names = dests.map((d) => d.name).join(", ") || "none";
        return {
          text: `Destination "${destinationId || destinationName}" not found. Available: ${names}`,
          success: false,
        };
      }

      const result = await apiPost("/api/streaming/destination", {
        destinationId: target.id,
      });
      if (!result.ok) {
        const msg =
          (result.data as Record<string, unknown>)?.error ??
          `HTTP ${result.status}`;
        return { text: `Failed to switch destination: ${msg}`, success: false };
      }

      return {
        text: `Switched streaming destination to ${target.name}.`,
        success: true,
      };
    } catch (err) {
      return {
        text: `Failed to switch destination: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
      };
    }
  },

  parameters: [
    {
      name: "destinationId",
      description:
        "The destination ID (from /api/streaming/destinations). Use this or destinationName.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "destinationName",
      description:
        'The destination name (e.g. "Twitch", "YouTube"). Case-insensitive.',
      required: false,
      schema: { type: "string" as const },
    },
  ],
};

// ---------------------------------------------------------------------------
// SPEAK_ON_STREAM
// ---------------------------------------------------------------------------

export const speakOnStreamAction: Action = {
  name: "SPEAK_ON_STREAM",
  similes: ["SAY_ON_STREAM", "TTS_SPEAK", "READ_ALOUD", "STREAM_VOICE"],
  description:
    "Speak a message aloud on the stream using text-to-speech (TTS). " +
    "The stream voice must be enabled in settings.",
  validate: async () => true,

  handler: async (_runtime, _message, _state, options) => {
    try {
      const params = (
        options as { parameters?: Record<string, unknown> } | undefined
      )?.parameters;
      const text = typeof params?.text === "string" ? params.text.trim() : "";

      if (!text) {
        return {
          text: "text parameter is required for SPEAK_ON_STREAM.",
          success: false,
        };
      }

      const result = await apiPost("/api/stream/voice/speak", { text });
      if (!result.ok) {
        const msg =
          (result.data as Record<string, unknown>)?.error ??
          `HTTP ${result.status}`;
        return { text: `Failed to speak on stream: ${msg}`, success: false };
      }

      return { text: `Speaking on stream: "${text}"`, success: true };
    } catch (err) {
      return {
        text: `Failed to speak: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
      };
    }
  },

  parameters: [
    {
      name: "text",
      description: "The text to speak aloud on the stream.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
};

// ---------------------------------------------------------------------------
// MANAGE_OVERLAY_WIDGET
// ---------------------------------------------------------------------------

export const manageOverlayWidgetAction: Action = {
  name: "MANAGE_OVERLAY_WIDGET",
  similes: [
    "TOGGLE_WIDGET",
    "ENABLE_WIDGET",
    "DISABLE_WIDGET",
    "SHOW_OVERLAY",
    "HIDE_OVERLAY",
  ],
  description:
    "Enable or disable a stream overlay widget (e.g. viewer count, alert popup, thought bubble, branding). " +
    'Provide widgetType and action ("enable" or "disable"). Optionally provide destinationId for per-destination layouts.',
  validate: async () => true,

  handler: async (_runtime, _message, _state, options) => {
    try {
      const params = (
        options as { parameters?: Record<string, unknown> } | undefined
      )?.parameters;
      const widgetType =
        typeof params?.widgetType === "string" ? params.widgetType.trim() : "";
      const action =
        typeof params?.action === "string"
          ? params.action.trim().toLowerCase()
          : "enable";
      const destinationId =
        typeof params?.destinationId === "string"
          ? params.destinationId.trim()
          : undefined;

      if (!widgetType) {
        return {
          text: "widgetType is required. Available types: viewer-count, alert-popup, action-ticker, thought-bubble, branding, custom-html, peon-hud, peon-glass, peon-sakura.",
          success: false,
        };
      }

      if (action !== "enable" && action !== "disable") {
        return {
          text: 'action must be "enable" or "disable".',
          success: false,
        };
      }

      // Fetch current layout
      const qs = destinationId
        ? `?destination=${encodeURIComponent(destinationId)}`
        : "";
      const getResult = await apiGet(`/api/stream/overlay-layout${qs}`);
      if (!getResult.ok) {
        return {
          text: `Could not fetch overlay layout: HTTP ${getResult.status}`,
          success: false,
        };
      }

      const data = getResult.data as Record<string, unknown>;
      const layout = data.layout as {
        version: 1;
        name: string;
        widgets: Array<{
          id: string;
          type: string;
          enabled: boolean;
          [k: string]: unknown;
        }>;
      };

      if (!layout || !Array.isArray(layout.widgets)) {
        return { text: "Could not parse overlay layout.", success: false };
      }

      const widget = layout.widgets.find((w) => w.type === widgetType);
      if (!widget) {
        const types = layout.widgets.map((w) => w.type).join(", ");
        return {
          text: `Widget type "${widgetType}" not found. Available: ${types}`,
          success: false,
        };
      }

      const enable = action === "enable";
      if (widget.enabled === enable) {
        return {
          text: `Widget "${widgetType}" is already ${enable ? "enabled" : "disabled"}.`,
          success: true,
        };
      }

      // Mutate and save
      const updated = {
        ...layout,
        widgets: layout.widgets.map((w) =>
          w.type === widgetType ? { ...w, enabled: enable } : w,
        ),
      };

      const saveResult = await apiPost(`/api/stream/overlay-layout${qs}`, {
        layout: updated,
      });
      if (!saveResult.ok) {
        return {
          text: `Failed to save overlay layout: HTTP ${saveResult.status}`,
          success: false,
        };
      }

      return {
        text: `Widget "${widgetType}" ${enable ? "enabled" : "disabled"} on stream overlay.`,
        success: true,
      };
    } catch (err) {
      return {
        text: `Failed to manage widget: ${err instanceof Error ? err.message : String(err)}`,
        success: false,
      };
    }
  },

  parameters: [
    {
      name: "widgetType",
      description:
        "Widget type to manage: viewer-count, alert-popup, action-ticker, thought-bubble, branding, custom-html, peon-hud, peon-glass, peon-sakura.",
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "action",
      description: '"enable" or "disable".',
      required: true,
      schema: { type: "string" as const },
    },
    {
      name: "destinationId",
      description:
        "Optional destination ID for per-destination overlay layouts.",
      required: false,
      schema: { type: "string" as const },
    },
  ],
};
