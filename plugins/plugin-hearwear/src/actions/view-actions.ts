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

    const base = agentBaseUrl(runtime);
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
      text = "Closed all XR panels.";
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

  handler: async (runtime, _message, _state, options, callback) => {
    const svc = getService(runtime);
    if (!svc) {
      const text = "No XR service.";
      await callback?.({ text });
      return { success: false, text };
    }

    // Collect XR view declarations from all registered plugins
    const xrViews = collectXRViews(runtime);

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

  handler: async (runtime, message, _state, options, callback) => {
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

    const inputText = message.content.text?.toLowerCase() ?? "";
    let scale = (options?.scale as number | undefined) ?? 1.0;
    let distance = (options?.distance as number | undefined) ?? 1.5;

    if (
      inputText.includes("bigger") ||
      inputText.includes("larger") ||
      inputText.includes("bigger")
    )
      scale = 1.5;
    if (inputText.includes("smaller") || inputText.includes("tiny"))
      scale = 0.6;
    if (inputText.includes("closer") || inputText.includes("nearer"))
      distance = 0.8;
    if (
      inputText.includes("farther") ||
      inputText.includes("further") ||
      inputText.includes("away")
    )
      distance = 2.5;
    if (inputText.includes("fullscreen") || inputText.includes("full screen")) {
      svc.resizeView(connId, "", { scale: 2.0, fullscreen: true });
      const text = "Panel fullscreened.";
      await callback?.({ text });
      return { success: true, text };
    }

    const viewId = (options?.viewId as string | undefined) ?? "";
    svc.resizeView(connId, viewId, { scale, distance });
    const text = `Panel resized to ${scale}× at ${distance}m.`;
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
  if (quoted) return quoted[1] ?? "";
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
