/**
 * XR view actions open, close, switch, list, and resize app views inside
 * connected headset sessions.
 */
import { listViews } from "@elizaos/agent/api/views-registry";
import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  XR_SERVICE_TYPE,
  type XRSessionService,
} from "../services/xr-session-service.ts";

function getService(runtime: IAgentRuntime): XRSessionService | null {
  return runtime.getService<XRSessionService>(XR_SERVICE_TYPE) ?? null;
}

function firstConnectionId(svc: XRSessionService): string | null {
  return svc.getConnections()[0]?.id ?? null;
}

function agentBaseUrl(): string {
  // The API port is orchestrator-assigned, so view URLs read it from env.
  const port =
    process.env.ELIZA_API_PORT?.trim() ||
    process.env.ELIZA_PORT?.trim() ||
    "31337";
  return process.env.XR_AGENT_URL ?? `http://localhost:${port}`;
}

/** Read a structured action param (planner-emitted `options.parameters`, with a
 *  legacy top-level `options` fallback). No natural-language inference (#10471). */
function readRawParam(options: unknown, key: string): unknown {
  const opts = (options ?? {}) as Record<string, unknown>;
  const fromParams = (opts.parameters as Record<string, unknown> | undefined)?.[
    key
  ];
  return fromParams ?? opts[key];
}

function readStringParam(options: unknown, key: string): string | undefined {
  const value = readRawParam(options, key);
  return typeof value === "string" ? value : undefined;
}

function readNumberParam(options: unknown, key: string): number | undefined {
  const value = readRawParam(options, key);
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readBooleanParam(options: unknown, key: string): boolean | undefined {
  const value = readRawParam(options, key);
  return typeof value === "boolean" ? value : undefined;
}

// ── XR_OPEN_VIEW ───────────────────────────────────────────────────────────

export const xrOpenViewAction: Action = {
  name: "XR_OPEN_VIEW",
  similes: ["OPEN_XR_VIEW", "SHOW_XR_PANEL", "XR_SHOW", "XR_LAUNCH"],
  description:
    "Opens a view panel on the connected XR headset by view id. Use XR_LIST_VIEWS first to discover available view ids.",
  examples: [
    [
      { name: "user", content: { text: "open the wallet in XR" } },
      {
        name: "agent",
        content: {
          text: "Opening wallet view on your headset.",
          action: "XR_OPEN_VIEW",
        },
      },
    ],
    [
      { name: "user", content: { text: "show training dashboard in XR" } },
      {
        name: "agent",
        content: { text: "Launching training panel.", action: "XR_OPEN_VIEW" },
      },
    ],
  ],

  validate: async (runtime): Promise<boolean> => {
    const svc = getService(runtime);
    return svc?.hasActiveConnections() ?? false;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback,
  ) => {
    const svc = getService(runtime);
    if (!svc) {
      const text = "No XR session service available.";
      await callback?.({ text });
      return { success: false, text };
    }

    const viewId =
      (options?.viewId as string | undefined) ??
      extractViewId(message.content.text ?? "");
    if (!viewId) {
      const text =
        "Please specify which view to open. Try XR_LIST_VIEWS to see available views.";
      await callback?.({ text });
      return { success: false, text };
    }

    const connId = firstConnectionId(svc);
    if (!connId) {
      const text = "No XR device is connected.";
      await callback?.({ text });
      return { success: false, text };
    }

    const base = agentBaseUrl();
    const scale = (options?.scale as number | undefined) ?? 1.0;
    svc.openView(connId, viewId, base, { scale, followMode: "billboard" });
    const text = `Opening ${viewId} view on your headset.`;
    await callback?.({ text });
    return { success: true, text };
  },
};

// ── XR_CLOSE_VIEW ──────────────────────────────────────────────────────────

export const xrCloseViewAction: Action = {
  name: "XR_CLOSE_VIEW",
  similes: ["CLOSE_XR_VIEW", "HIDE_XR_PANEL", "XR_CLOSE", "XR_DISMISS"],
  description: "Closes a specific view panel on the connected XR headset.",
  examples: [
    [
      { name: "user", content: { text: "close the wallet panel" } },
      {
        name: "agent",
        content: { text: "Closing wallet panel.", action: "XR_CLOSE_VIEW" },
      },
    ],
  ],

  validate: async (runtime) => {
    const svc = getService(runtime);
    return svc?.hasActiveConnections() ?? false;
  },

  handler: async (runtime, message, _state, options, callback) => {
    const svc = getService(runtime);
    if (!svc) {
      const text = "No XR service.";
      await callback?.({ text });
      return { success: false, text };
    }

    const viewId =
      (options?.viewId as string | undefined) ??
      extractViewId(message.content.text ?? "");
    const connId = firstConnectionId(svc);
    if (!connId) {
      const text = "No XR device connected.";
      await callback?.({ text });
      return { success: false, text };
    }

    let text: string;
    if (viewId) {
      svc.closeView(connId, viewId);
      text = `Closed ${viewId}.`;
      await callback?.({ text });
    } else {
      const views = collectXRViews();
      for (const view of views) {
        svc.closeView(connId, view.id);
      }
      text =
        views.length > 0 ? "Closed all XR panels." : "No XR panels to close.";
      await callback?.({ text });
    }
    return { success: true, text };
  },
};

// ── XR_SWITCH_VIEW ─────────────────────────────────────────────────────────

export const xrSwitchViewAction: Action = {
  name: "XR_SWITCH_VIEW",
  similes: ["SWITCH_XR_VIEW", "XR_GO_TO", "XR_NAVIGATE"],
  description:
    "Switches the active (foreground) view on the XR headset without closing others.",
  examples: [
    [
      { name: "user", content: { text: "switch to companion in XR" } },
      {
        name: "agent",
        content: {
          text: "Switching to companion view.",
          action: "XR_SWITCH_VIEW",
        },
      },
    ],
  ],

  validate: async (runtime) => {
    const svc = getService(runtime);
    return svc?.hasActiveConnections() ?? false;
  },

  handler: async (runtime, message, _state, options, callback) => {
    const svc = getService(runtime);
    if (!svc) {
      const text = "No XR service.";
      await callback?.({ text });
      return { success: false, text };
    }
    const viewId =
      (options?.viewId as string | undefined) ??
      extractViewId(message.content.text ?? "");
    const connId = firstConnectionId(svc);
    if (!connId || !viewId) {
      const text = "Specify a view id.";
      await callback?.({ text });
      return { success: false, text };
    }
    svc.switchView(connId, viewId);
    const text = `Switched to ${viewId}.`;
    await callback?.({ text });
    return { success: true, text };
  },
};

// ── XR_LIST_VIEWS ──────────────────────────────────────────────────────────

export const xrListViewsAction: Action = {
  name: "XR_LIST_VIEWS",
  similes: ["LIST_XR_VIEWS", "XR_VIEWS", "WHAT_XR_VIEWS", "SHOW_XR_LAUNCHER"],
  description:
    "Lists all views available on the XR device and optionally sends a launcher catalog to the headset. Use this before XR_OPEN_VIEW.",
  examples: [
    [
      { name: "user", content: { text: "what can I open in XR?" } },
      {
        name: "agent",
        content: {
          text: "Available XR views are registered by the loaded plugins.",
          action: "XR_LIST_VIEWS",
        },
      },
    ],
  ],

  validate: async (runtime) => {
    const svc = getService(runtime);
    return svc !== null;
  },

  handler: async (runtime, _message, _state, options, callback) => {
    const svc = getService(runtime);
    if (!svc) {
      const text = "No XR service.";
      await callback?.({ text });
      return { success: false, text };
    }

    // Collect XR view declarations from all registered plugins
    const xrViews = collectXRViews();

    const connId = firstConnectionId(svc);
    if (connId && (options?.sendCatalog as boolean | undefined) !== false) {
      svc.sendViewsCatalog(connId, xrViews);
    }

    if (xrViews.length === 0) {
      const text = "No XR views are currently registered.";
      await callback?.({ text });
      return { success: true, text };
    }

    const list = xrViews.map((v) => `• ${v.label} (id: ${v.id})`).join("\n");
    const text = `Available XR views:\n${list}\n\nSay "open [view name]" to launch one.`;
    await callback?.({ text });
    return { success: true, text };
  },
};

// ── XR_RESIZE_VIEW ─────────────────────────────────────────────────────────

export const xrResizeViewAction: Action = {
  name: "XR_RESIZE_VIEW",
  similes: ["RESIZE_XR_PANEL", "XR_MAKE_BIGGER", "XR_MAKE_SMALLER", "XR_SCALE"],
  description:
    "Resizes or repositions the active XR view panel. Set scale (0.5 = half, 1.0 = default, 2.0 = double), distance in meters (1.5 = default, smaller = closer), or fullscreen.",
  parameters: [
    {
      name: "scale",
      description:
        "Panel scale multiplier — e.g. 1.5 for bigger, 0.6 for smaller, 1.0 default.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "distance",
      description:
        "Panel distance from the user in meters — e.g. 0.8 for closer, 2.5 for farther, 1.5 default.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "fullscreen",
      description: "Set true to fullscreen the panel.",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "viewId",
      description:
        "Optional id of the view/panel to resize; defaults to the active panel.",
      required: false,
      schema: { type: "string" },
    },
  ],
  examples: [
    [
      { name: "user", content: { text: "make the panel bigger" } },
      {
        name: "agent",
        content: { text: "Scaling up the panel.", action: "XR_RESIZE_VIEW" },
      },
    ],
    [
      { name: "user", content: { text: "make it smaller and move closer" } },
      {
        name: "agent",
        content: {
          text: "Resizing and moving panel closer.",
          action: "XR_RESIZE_VIEW",
        },
      },
    ],
  ],

  validate: async (runtime) => {
    const svc = getService(runtime);
    return svc?.hasActiveConnections() ?? false;
  },

  handler: async (runtime, _message, _state, options, callback) => {
    const svc = getService(runtime);
    if (!svc) {
      const text = "No XR service.";
      await callback?.({ text });
      return { success: false, text };
    }
    const connId = firstConnectionId(svc);
    if (!connId) {
      const text = "No XR device connected.";
      await callback?.({ text });
      return { success: false, text };
    }

    // #10471: scale/distance/fullscreen come from structured params the planner
    // emits (in any language), not from English keywords in the user's text.
    const viewId = readStringParam(options, "viewId") ?? "";
    const scale = readNumberParam(options, "scale");
    const distance = readNumberParam(options, "distance");
    const fullscreen = readBooleanParam(options, "fullscreen") ?? false;

    if (fullscreen) {
      svc.resizeView(connId, viewId, { scale: scale ?? 2.0, fullscreen: true });
      const text = "Panel fullscreened.";
      await callback?.({ text });
      return { success: true, text };
    }

    const finalScale = scale ?? 1.0;
    const finalDistance = distance ?? 1.5;
    svc.resizeView(connId, viewId, {
      scale: finalScale,
      distance: finalDistance,
    });
    const text = `Panel resized to ${finalScale}× at ${finalDistance}m.`;
    await callback?.({ text });
    return { success: true, text };
  },
};

// ── Aliases for facewear consumers ────────────────────────────────────────

export const facewearOpenViewAction = xrOpenViewAction;
export const facewearCloseViewAction = xrCloseViewAction;
export const facewearSwitchViewAction = xrSwitchViewAction;
export const facewearListViewsAction = xrListViewsAction;
export const facewearResizeViewAction = xrResizeViewAction;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract a likely view id from natural language */
export function extractViewId(text: string): string {
  const lower = text.toLowerCase();
  for (const view of collectXRViews()) {
    const terms = [view.id, view.id.replace(/-/g, " "), view.label].map(
      (term) => term.toLowerCase(),
    );
    if (terms.some((term) => term && lower.includes(term))) {
      return view.id;
    }
  }
  const quoted = text.match(/["']([^"']+)["']/);
  if (quoted) return quoted[1] ?? "";
  return "";
}

type XRViewSummary = {
  id: string;
  label: string;
  icon?: string;
  description?: string;
};

/** Collect all XR-typed views from registered plugins */
export function collectXRViews(): XRViewSummary[] {
  const byId = new Map<string, XRViewSummary>();
  for (const view of listViews({ developerMode: true, viewType: "xr" })) {
    if (view.viewType !== "xr") continue;
    byId.set(view.id, {
      id: view.id,
      label: view.label,
      icon: view.icon,
      description: view.description,
    });
  }
  return [...byId.values()].sort(
    (a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id),
  );
}
