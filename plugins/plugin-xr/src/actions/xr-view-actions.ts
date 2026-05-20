import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  XR_SERVICE_TYPE,
  type XRSessionService,
} from "../services/xr-session-service.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

function getService(runtime: IAgentRuntime): XRSessionService | null {
  return runtime.getService<XRSessionService>(XR_SERVICE_TYPE) ?? null;
}

function firstConnectionId(svc: XRSessionService): string | null {
  return svc.getConnections()[0]?.id ?? null;
}

function agentBaseUrl(runtime: IAgentRuntime): string {
  const port = (runtime as unknown as { port?: number }).port ?? 31337;
  return process.env.XR_AGENT_URL ?? `http://localhost:${port}`;
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
  ): Promise<ActionResult | undefined> => {
    const svc = getService(runtime);
    if (!svc) {
      await callback?.({ text: "No XR session service available." });
      return { success: false };
    }

    const viewId =
      (options?.viewId as string | undefined) ??
      extractViewId(message.content.text ?? "");
    if (!viewId) {
      await callback?.({
        text: "Please specify which view to open. Try XR_LIST_VIEWS to see available views.",
      });
      return { success: false };
    }

    const connId = firstConnectionId(svc);
    if (!connId) {
      await callback?.({ text: "No XR device is connected." });
      return { success: false };
    }

    const base = agentBaseUrl(runtime);
    const scale = (options?.scale as number | undefined) ?? 1.0;
    svc.openView(connId, viewId, base, { scale, followMode: "billboard" });
    await callback?.({ text: `Opening ${viewId} view on your headset.` });
    return { success: true };
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

  handler: async (
    runtime,
    message,
    _state,
    options,
    callback,
  ): Promise<ActionResult | undefined> => {
    const svc = getService(runtime);
    if (!svc) {
      await callback?.({ text: "No XR service." });
      return { success: false };
    }

    const viewId =
      (options?.viewId as string | undefined) ??
      extractViewId(message.content.text ?? "");
    const connId = firstConnectionId(svc);
    if (!connId) {
      await callback?.({ text: "No XR device connected." });
      return { success: false };
    }

    if (viewId) {
      svc.closeView(connId, viewId);
      await callback?.({ text: `Closed ${viewId}.` });
    } else {
      // Close all
      for (const view of [
        "wallet",
        "training",
        "companion",
        "task-coordinator",
        "views-manager",
      ]) {
        svc.closeView(connId, view);
      }
      await callback?.({ text: "Closed all XR panels." });
    }
    return { success: true };
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

  handler: async (
    runtime,
    message,
    _state,
    options,
    callback,
  ): Promise<ActionResult | undefined> => {
    const svc = getService(runtime);
    if (!svc) {
      await callback?.({ text: "No XR service." });
      return { success: false };
    }
    const viewId =
      (options?.viewId as string | undefined) ??
      extractViewId(message.content.text ?? "");
    const connId = firstConnectionId(svc);
    if (!connId || !viewId) {
      await callback?.({ text: "Specify a view id." });
      return { success: false };
    }
    svc.switchView(connId, viewId);
    await callback?.({ text: `Switched to ${viewId}.` });
    return { success: true };
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
          text: "Available XR views: wallet, training, companion, task-coordinator.",
          action: "XR_LIST_VIEWS",
        },
      },
    ],
  ],

  validate: async (runtime) => {
    const svc = getService(runtime);
    return svc !== null;
  },

  handler: async (
    runtime,
    _message,
    _state,
    options,
    callback,
  ): Promise<ActionResult | undefined> => {
    const svc = getService(runtime);
    if (!svc) {
      await callback?.({ text: "No XR service." });
      return { success: false };
    }

    // Collect XR view declarations from all registered plugins
    const xrViews = collectXRViews(runtime);

    const connId = firstConnectionId(svc);
    if (connId && (options?.sendCatalog as boolean | undefined) !== false) {
      svc.sendViewsCatalog(connId, xrViews);
    }

    if (xrViews.length === 0) {
      await callback?.({ text: "No XR views are currently registered." });
      return { success: true };
    }

    const list = xrViews.map((v) => `• ${v.label} (id: ${v.id})`).join("\n");
    await callback?.({
      text: `Available XR views:\n${list}\n\nSay "open [view name]" to launch one.`,
    });
    return { success: true };
  },
};

// ── XR_RESIZE_VIEW ─────────────────────────────────────────────────────────

export const xrResizeViewAction: Action = {
  name: "XR_RESIZE_VIEW",
  similes: ["RESIZE_XR_PANEL", "XR_MAKE_BIGGER", "XR_MAKE_SMALLER", "XR_SCALE"],
  description:
    "Resizes or repositions the active XR view panel. Accepts scale (0.5 = half, 2.0 = double) and distance.",
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

  handler: async (
    runtime,
    message,
    _state,
    options,
    callback,
  ): Promise<ActionResult | undefined> => {
    const svc = getService(runtime);
    if (!svc) {
      await callback?.({ text: "No XR service." });
      return { success: false };
    }
    const connId = firstConnectionId(svc);
    if (!connId) {
      await callback?.({ text: "No XR device connected." });
      return { success: false };
    }

    const text = message.content.text?.toLowerCase() ?? "";
    let scale = (options?.scale as number | undefined) ?? 1.0;
    let distance = (options?.distance as number | undefined) ?? 1.5;

    if (
      text.includes("bigger") ||
      text.includes("larger") ||
      text.includes("bigger")
    )
      scale = 1.5;
    if (text.includes("smaller") || text.includes("tiny")) scale = 0.6;
    if (text.includes("closer") || text.includes("nearer")) distance = 0.8;
    if (
      text.includes("farther") ||
      text.includes("further") ||
      text.includes("away")
    )
      distance = 2.5;
    if (text.includes("fullscreen") || text.includes("full screen")) {
      svc.resizeView(connId, "", { scale: 2.0, fullscreen: true });
      await callback?.({ text: "Panel fullscreened." });
      return { success: true };
    }

    const viewId = (options?.viewId as string | undefined) ?? "";
    svc.resizeView(connId, viewId, { scale, distance });
    await callback?.({ text: `Panel resized to ${scale}× at ${distance}m.` });
    return { success: true };
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** Extract a likely view id from natural language */
function extractViewId(text: string): string {
  const lower = text.toLowerCase();
  const known = [
    "wallet",
    "companion",
    "training",
    "task-coordinator",
    "views-manager",
    "polymarket",
    "vincent",
    "steward",
    "shopify",
    "phone",
    "contacts",
    "messages",
    "babylon",
    "2004scape",
    "defense-of-the-agents",
  ];
  for (const id of known) {
    if (lower.includes(id.replace("-", " ")) || lower.includes(id)) return id;
  }
  // Try to extract quoted word
  const quoted = text.match(/["']([^"']+)["']/);
  if (quoted) return quoted[1]!;
  return "";
}

/** Collect all XR-typed views from registered plugins */
function collectXRViews(
  runtime: IAgentRuntime,
): Array<{ id: string; label: string; icon?: string; description?: string }> {
  const plugins =
    (
      runtime as unknown as {
        plugins?: Array<{
          views?: Array<{
            id: string;
            label: string;
            viewType?: string;
            icon?: string;
            description?: string;
          }>;
        }>;
      }
    ).plugins ?? [];
  const seen = new Set<string>();
  const result: Array<{
    id: string;
    label: string;
    icon?: string;
    description?: string;
  }> = [];
  for (const plugin of plugins) {
    for (const view of plugin.views ?? []) {
      if (view.viewType === "xr" && !seen.has(view.id)) {
        seen.add(view.id);
        result.push({
          id: view.id,
          label: view.label,
          icon: view.icon,
          description: view.description,
        });
      }
    }
  }
  return result;
}
