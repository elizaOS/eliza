/**
 * MANAGE_BROWSER_BRIDGE — single action that covers the bridge-extension
 * management surface (Install, Reveal Folder, Open Manager, Refresh) that the
 * `BrowserWorkspaceView` UI exposes.
 *
 * This replaces the four previously-separate actions
 * (`BROWSER_BRIDGE_INSTALL`, `BROWSER_BRIDGE_REVEAL_FOLDER`,
 * `BROWSER_BRIDGE_OPEN_MANAGER`, `BROWSER_BRIDGE_REFRESH`) — folded into one
 * because each one took zero parameters and only differed in which packaging
 * helper it called. One action with an `action` parameter is the right agent
 * surface; the LLM picks the child action.
 *
 * Calls directly into the local packaging helpers (the same code path the
 * route layer uses) rather than going back through HTTP, so the action runs
 * inside the runtime process without an HTTP round trip.
 *
 * Authorization: OWNER only. The bridge is local-machine plumbing —
 * installing a browser extension, opening Chrome's extensions page,
 * inspecting paired companions — that should never be triggered by a
 * non-owner user.
 *
 * Validation: keyword-based on the message (and recent messages) using a
 * deliberately liberal multilingual set covering "browser", "bridge",
 * "chrome / safari / firefox / brave / edge / arc / opera / vivaldi",
 * "extension", "companion", "install", "manager", "reveal", "refresh",
 * "connection", "pair", and Spanish / French / German / Italian / Japanese /
 * Chinese / Korean / Portuguese / Russian / Arabic / Hindi / Turkish /
 * Vietnamese / Thai / Polish / Dutch / Indonesian / Hebrew variants.
 */

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger, ModelType, parseKeyValueXml } from "@elizaos/core";
import type {
  BrowserBridgeCompanionPackageStatus,
  BrowserBridgeCompanionStatus,
} from "../contracts.js";
import {
  buildBrowserBridgeCompanionPackage,
  getBrowserBridgeCompanionPackageStatus,
  openBrowserBridgeCompanionManager,
  openBrowserBridgeCompanionPackagePath,
} from "../packaging.js";
import {
  BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  type BrowserBridgeRouteService,
} from "../service.js";

const ACTION_NAME = "MANAGE_BROWSER_BRIDGE";
const MAX_BROWSER_BRIDGE_TEXT_LENGTH = 3000;
const BROWSER_BRIDGE_TIMEOUT_MS = 30_000;

export const BROWSER_BRIDGE_SUBACTIONS = [
  "install",
  "reveal_folder",
  "open_manager",
  "refresh",
] as const;
export type BrowserBridgeSubaction = (typeof BROWSER_BRIDGE_SUBACTIONS)[number];

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withBrowserBridgeTimeout<T>(
  promise: Promise<T>,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label} timed out`)),
        BROWSER_BRIDGE_TIMEOUT_MS,
      ),
    ),
  ]);
}

const SELECTED_CONTEXT_KEYS = [
  "browser",
  "files",
  "connectors",
  "settings",
  "automation",
  "admin",
] as const;

function hasSelectedContext(state: State | undefined): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect(
    (state?.values as Record<string, unknown> | undefined)?.selectedContexts,
  );
  collect(
    (state?.data as Record<string, unknown> | undefined)?.selectedContexts,
  );
  const contextObject = (state?.data as Record<string, unknown> | undefined)
    ?.contextObject as
    | {
        trajectoryPrefix?: { selectedContexts?: unknown };
        metadata?: { selectedContexts?: unknown };
      }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return SELECTED_CONTEXT_KEYS.some((context) => selected.has(context));
}

type ManageBrowserBridgeParameters = {
  action?: BrowserBridgeSubaction;
  subaction?: BrowserBridgeSubaction;
};

function normalizeSubaction(
  raw: string | undefined,
): BrowserBridgeSubaction | null {
  if (!raw) return null;
  const trimmed = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  return (BROWSER_BRIDGE_SUBACTIONS as readonly string[]).includes(trimmed)
    ? (trimmed as BrowserBridgeSubaction)
    : null;
}

/**
 * Pick the bridge subaction the user wants via the model's structured output
 * instead of English-only regex (#10470) — only consulted when the caller did
 * not pass an explicit `action`/`subaction` param. Defaults to "install" on any
 * failure (the safe first-time-setup operation).
 */
async function extractBrowserBridgeSubaction(
  runtime: IAgentRuntime,
  text: string,
): Promise<BrowserBridgeSubaction> {
  if (!text.trim()) return "install";
  const prompt = `The user is managing the browser companion extension. Pick the single operation they want — this must work in any language, so do not rely on English keywords.

- install: set up / install / pair the companion extension (the default)
- reveal_folder: reveal the extension's build folder in the file manager
- open_manager: open the browser's extension manager page
- refresh: refresh / reconnect / sync / check the companion status

Request:
${text}

Return ONLY:
<response><subaction>install|reveal_folder|open_manager|refresh</subaction></response>`;
  try {
    const raw = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
    const cleaned = raw.replace(/```(?:xml)?/gi, "").trim();
    const wrapped = cleaned.includes("<response>")
      ? cleaned
      : `<response>${cleaned}</response>`;
    const parsed = parseKeyValueXml(wrapped) ?? {};
    const sub =
      typeof parsed.subaction === "string" ? parsed.subaction.trim() : "";
    if ((BROWSER_BRIDGE_SUBACTIONS as readonly string[]).includes(sub)) {
      return sub as BrowserBridgeSubaction;
    }
  } catch (error) {
    logger.warn(
      `[${ACTION_NAME}] subaction extraction failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return "install";
}

async function runInstall(): Promise<ActionResult> {
  let status: BrowserBridgeCompanionPackageStatus =
    getBrowserBridgeCompanionPackageStatus();
  if (!status.chromeBuildPath) {
    status = await withBrowserBridgeTimeout(
      buildBrowserBridgeCompanionPackage("chrome"),
      "browser bridge package build",
    );
  }
  const reveal = await withBrowserBridgeTimeout(
    openBrowserBridgeCompanionPackagePath("chrome_build", { revealOnly: true }),
    "browser bridge reveal",
  );
  let openedManager = true;
  try {
    await withBrowserBridgeTimeout(
      openBrowserBridgeCompanionManager("chrome"),
      "browser bridge manager open",
    );
  } catch (err) {
    openedManager = false;
    logger.warn(
      `[${ACTION_NAME}] could not open chrome://extensions: ${describeError(err)}`,
    );
  }
  const text = (
    openedManager
      ? `Chrome is ready. Click Load unpacked and choose ${reveal.path}.`
      : `The Agent Browser Bridge folder is ready at ${reveal.path}. Open chrome://extensions, click Load unpacked, and choose that folder.`
  ).slice(0, MAX_BROWSER_BRIDGE_TEXT_LENGTH);
  return {
    text,
    success: true,
    values: { success: true, subaction: "install", openedManager },
    data: {
      actionName: ACTION_NAME,
      subaction: "install",
      path: reveal.path,
      openedManager,
      status,
    },
  };
}

async function runRevealFolder(): Promise<ActionResult> {
  const reveal = await withBrowserBridgeTimeout(
    openBrowserBridgeCompanionPackagePath("chrome_build", { revealOnly: true }),
    "browser bridge reveal",
  );
  const text =
    `Revealed the Agent Browser Bridge folder at ${reveal.path}.`.slice(
      0,
      MAX_BROWSER_BRIDGE_TEXT_LENGTH,
    );
  return {
    text,
    success: true,
    values: { success: true, subaction: "reveal_folder" },
    data: {
      actionName: ACTION_NAME,
      subaction: "reveal_folder",
      path: reveal.path,
    },
  };
}

async function runOpenManager(): Promise<ActionResult> {
  await withBrowserBridgeTimeout(
    openBrowserBridgeCompanionManager("chrome"),
    "browser bridge manager open",
  );
  const text =
    "Opened Chrome extensions. Click Load unpacked and choose the Agent Browser Bridge folder.".slice(
      0,
      MAX_BROWSER_BRIDGE_TEXT_LENGTH,
    );
  return {
    text,
    success: true,
    values: { success: true, subaction: "open_manager" },
    data: { actionName: ACTION_NAME, subaction: "open_manager" },
  };
}

async function runRefresh(runtime: IAgentRuntime): Promise<ActionResult> {
  const status = getBrowserBridgeCompanionPackageStatus();
  let settings: Awaited<
    ReturnType<BrowserBridgeRouteService["getBrowserSettings"]>
  > | null = null;
  let companions: BrowserBridgeCompanionStatus[] = [];
  const service = runtime.getService<BrowserBridgeRouteService>(
    BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  );
  if (!service) {
    return {
      text: "Agent Browser Bridge package status is available, but companion status cannot be read because the Browser Bridge service is not registered.",
      success: false,
      values: {
        success: false,
        subaction: "refresh",
        error: "BROWSER_BRIDGE_SERVICE_UNAVAILABLE",
      },
      data: {
        actionName: ACTION_NAME,
        subaction: "refresh",
        status,
        settings,
        companions,
      },
    };
  }
  settings = await service.getBrowserSettings();
  companions = (await service.listBrowserCompanions()).slice(0, 25);
  const connected = companions.length > 0;
  const text = [
    "Refreshed Agent Browser Bridge settings.",
    `Tracking: ${settings.trackingMode}.`,
    `Browser control: ${settings.allowBrowserControl ? "on" : "off"}.`,
    connected
      ? `Companions: ${companions.length} paired.`
      : "Companions: none paired.",
  ].join(" ");
  return {
    text,
    success: true,
    values: {
      success: true,
      subaction: "refresh",
      connected,
      trackingMode: settings.trackingMode,
      allowBrowserControl: settings.allowBrowserControl,
      companionCount: companions.length,
    },
    data: {
      actionName: ACTION_NAME,
      subaction: "refresh",
      status,
      settings,
      companions,
    },
  };
}

export const manageBrowserBridgeAction: Action = {
  name: ACTION_NAME,
  contexts: ["browser", "files", "connectors", "settings"],
  contextGate: { anyOf: ["browser", "files", "connectors", "settings"] },
  roleGate: { minRole: "OWNER" },
  similes: [
    // Install / setup synonyms
    "INSTALL_BROWSER_BRIDGE",
    "SETUP_BROWSER_BRIDGE",
    "PAIR_BROWSER",
    "CONNECT_BROWSER",
    "ADD_BROWSER_EXTENSION",
    // Reveal folder synonyms
    "REVEAL_BROWSER_BRIDGE_FOLDER",
    "OPEN_BROWSER_BRIDGE_FOLDER",
    "SHOW_BROWSER_EXTENSION_FOLDER",
    // Open manager synonyms
    "OPEN_CHROME_EXTENSIONS",
    "OPEN_BROWSER_BRIDGE_MANAGER",
    "OPEN_EXTENSION_MANAGER",
    // Refresh synonyms
    "REFRESH_BROWSER_BRIDGE",
    "REFRESH_BROWSER_BRIDGE_CONNECTION",
    "RELOAD_BROWSER_BRIDGE_STATUS",
    "RECONNECT_BROWSER",
    // Generic
    "MANAGE_CHROME_EXTENSION",
    "MANAGE_SAFARI_EXTENSION",
    "BROWSER_BRIDGE_INSTALL",
    "BROWSER_BRIDGE_REVEAL_FOLDER",
    "BROWSER_BRIDGE_OPEN_MANAGER",
    "BROWSER_BRIDGE_REFRESH",
  ],
  description:
    "Owner-only Agent Browser Bridge management for Chrome/Safari. Actions: refresh status/settings/connection, install build+reveal setup, reveal_folder open build folder, open_manager chrome://extensions only on explicit ask. Infer action if omitted.",
  descriptionCompressed:
    "Browser Bridge: refresh|install|reveal_folder|open_manager chrome://extensions",
  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
  ): Promise<boolean> => {
    return hasSelectedContext(state);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
  ): Promise<ActionResult> => {
    const params = (options as { parameters?: ManageBrowserBridgeParameters })
      ?.parameters;
    const subaction =
      normalizeSubaction(params?.action) ??
      normalizeSubaction(params?.subaction) ??
      (await extractBrowserBridgeSubaction(
        runtime,
        typeof message.content?.text === "string" ? message.content.text : "",
      ));
    try {
      switch (subaction) {
        case "install":
          return await runInstall();
        case "reveal_folder":
          return await runRevealFolder();
        case "open_manager":
          return await runOpenManager();
        case "refresh":
          return await runRefresh(runtime);
        default: {
          const exhaustive: never = subaction;
          throw new Error(
            `Unsupported MANAGE_BROWSER_BRIDGE subaction: ${exhaustive}`,
          );
        }
      }
    } catch (err) {
      const text =
        `Failed MANAGE_BROWSER_BRIDGE ${subaction}: ${describeError(err)}`.slice(
          0,
          MAX_BROWSER_BRIDGE_TEXT_LENGTH,
        );
      logger.warn(`[${ACTION_NAME}] ${text}`);
      return {
        text,
        success: false,
        values: {
          success: false,
          subaction,
          error: `MANAGE_BROWSER_BRIDGE_${subaction.toUpperCase()}_FAILED`,
        },
        data: { actionName: ACTION_NAME, subaction },
      };
    }
  },
  parameters: [
    {
      name: "action",
      description:
        "Bridge action. refresh=status/settings; open_manager only explicit chrome://extensions; install setup; reveal_folder build folder. Infer if omitted.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [...BROWSER_BRIDGE_SUBACTIONS],
      },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Show the browser bridge status.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Refreshing the browser bridge status.",
          actions: ["MANAGE_BROWSER_BRIDGE"],
          thought:
            "Show/status request maps to MANAGE_BROWSER_BRIDGE action=refresh.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Install the agent browser bridge extension.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Building and revealing the bridge extension.",
          actions: ["MANAGE_BROWSER_BRIDGE"],
          thought: "Setup intent maps to MANAGE_BROWSER_BRIDGE action=install.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Open chrome://extensions for me.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Opening the extension manager.",
          actions: ["MANAGE_BROWSER_BRIDGE"],
          thought:
            "Explicit chrome://extensions request maps to MANAGE_BROWSER_BRIDGE action=open_manager.",
        },
      },
    ],
  ],
};
