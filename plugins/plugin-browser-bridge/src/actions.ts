/**
 * Agent Browser Bridge actions.
 *
 * These four actions cover the bridge-extension management surface that the
 * `BrowserWorkspaceView` UI exposes (Install, Reveal Folder, Open Manager,
 * Refresh). The browsing/tab actions are already covered by the
 * `BROWSER_SESSION` super-action in `@elizaos/agent` and are intentionally
 * not duplicated here.
 *
 * Each action calls directly into the local packaging helpers (the same code
 * path the route layer uses) rather than going back through HTTP, so the
 * actions can run inside the runtime process without an HTTP round trip.
 */

import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type {
  BrowserBridgeCompanionPackageStatus,
  BrowserBridgeCompanionStatus,
} from "./contracts.js";
import {
  buildBrowserBridgeCompanionPackage,
  getBrowserBridgeCompanionPackageStatus,
  openBrowserBridgeCompanionManager,
  openBrowserBridgeCompanionPackagePath,
} from "./packaging.js";
import {
  BROWSER_BRIDGE_ROUTE_SERVICE_TYPE,
  type BrowserBridgeRouteService,
} from "./service.js";

const INSTALL_NAME = "BROWSER_BRIDGE_INSTALL";
const REVEAL_FOLDER_NAME = "BROWSER_BRIDGE_REVEAL_FOLDER";
const OPEN_MANAGER_NAME = "BROWSER_BRIDGE_OPEN_MANAGER";
const REFRESH_NAME = "BROWSER_BRIDGE_REFRESH";
const BROWSER_BRIDGE_KEYWORDS = [
  "browser bridge",
  "agent browser bridge",
  "extension",
  "chrome extension",
  "companion",
  "install",
  "reveal",
  "folder",
  "manager",
  "refresh",
  "extensión",
  "navegador",
  "instalar",
  "carpeta",
  "extension",
  "navigateur",
  "installer",
  "dossier",
  "erweiterung",
  "installieren",
  "ordner",
  "estensione",
  "installare",
  "cartella",
  "拡張機能",
  "ブラウザ",
  "インストール",
  "フォルダ",
  "扩展",
  "浏览器",
  "安装",
  "文件夹",
  "확장",
  "브라우저",
  "설치",
] as const;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasSelectedContext(
  state: State | undefined,
  contexts: readonly string[],
): boolean {
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
  return contexts.some((context) => selected.has(context));
}

function hasBrowserBridgeIntent(
  message: Memory,
  state: State | undefined,
): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string"
      ? state.values.recentMessages
      : "",
  ]
    .join("\n")
    .toLowerCase();
  return BROWSER_BRIDGE_KEYWORDS.some((keyword) =>
    text.includes(keyword.toLowerCase()),
  );
}

function validateBrowserBridgeAction(
  contexts: readonly string[],
): (
  _runtime: IAgentRuntime,
  message: Memory,
  state?: State,
) => Promise<boolean> {
  return async (_runtime, message, state) =>
    hasSelectedContext(state, contexts) ||
    hasBrowserBridgeIntent(message, state);
}

/**
 * BROWSER_BRIDGE_INSTALL — mirrors the UI "Install" button.
 *
 * 1. Builds the Chrome unpacked extension if it has not been built yet.
 * 2. Reveals the build folder in the host file manager.
 * 3. Opens the chrome://extensions manager (best-effort; does not fail if
 *    Chrome cannot be opened).
 */
export const browserBridgeInstallAction: Action = {
  name: INSTALL_NAME,
  contexts: ["browser", "connectors", "settings"],
  contextGate: { anyOf: ["browser", "connectors", "settings"] },
  roleGate: { minRole: "USER" },
  similes: ["INSTALL_BROWSER_BRIDGE", "SETUP_BROWSER_BRIDGE"],
  description: JSON.stringify({
    browser_bridge_install: {
      purpose:
        "Prepare the Agent Browser Bridge Chrome extension for unpacked install.",
      steps: [
        "build_if_needed",
        "reveal_build_folder",
        "open_chrome_extensions",
      ],
      params: "none",
    },
  }),
  descriptionCompressed: "Install browser companion extension.",
  validate: validateBrowserBridgeAction(["browser", "connectors", "settings"]),
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state,
    _options,
  ): Promise<ActionResult> => {
    try {
      let status: BrowserBridgeCompanionPackageStatus =
        getBrowserBridgeCompanionPackageStatus();
      if (!status.chromeBuildPath) {
        status = await buildBrowserBridgeCompanionPackage("chrome");
      }

      const reveal = await openBrowserBridgeCompanionPackagePath(
        "chrome_build",
        { revealOnly: true },
      );

      let openedManager = true;
      try {
        await openBrowserBridgeCompanionManager("chrome");
      } catch (err) {
        openedManager = false;
        logger.warn(
          `[${INSTALL_NAME}] could not open chrome://extensions: ${describeError(err)}`,
        );
      }

      const text = openedManager
        ? `Chrome is ready. Click Load unpacked and choose ${reveal.path}.`
        : `The Agent Browser Bridge folder is ready at ${reveal.path}. Open chrome://extensions, click Load unpacked, and choose that folder.`;

      return {
        text,
        success: true,
        values: { success: true, openedManager },
        data: {
          actionName: INSTALL_NAME,
          path: reveal.path,
          openedManager,
          status,
        },
      };
    } catch (err) {
      const text = `Failed to prepare the Agent Browser Bridge extension: ${describeError(err)}`;
      logger.warn(`[${INSTALL_NAME}] ${text}`);
      return {
        text,
        success: false,
        values: { success: false, error: "BROWSER_BRIDGE_INSTALL_FAILED" },
        data: { actionName: INSTALL_NAME },
      };
    }
  },
  parameters: [],
  examples: [],
};

/**
 * BROWSER_BRIDGE_REVEAL_FOLDER — mirrors the UI "Reveal folder" button.
 * Opens the Chrome unpacked-extension build folder in the host file manager.
 */
export const browserBridgeRevealFolderAction: Action = {
  name: REVEAL_FOLDER_NAME,
  contexts: ["browser", "files", "connectors", "settings"],
  contextGate: { anyOf: ["browser", "files", "connectors", "settings"] },
  roleGate: { minRole: "USER" },
  similes: ["REVEAL_BROWSER_BRIDGE_FOLDER", "OPEN_BROWSER_BRIDGE_FOLDER"],
  description: JSON.stringify({
    browser_bridge_reveal_folder: {
      purpose:
        "Reveal the Agent Browser Bridge Chrome extension folder in the host file manager.",
      params: "none",
    },
  }),
  descriptionCompressed: "Reveal companion folder in Finder.",
  validate: validateBrowserBridgeAction([
    "browser",
    "files",
    "connectors",
    "settings",
  ]),
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state,
    _options,
  ): Promise<ActionResult> => {
    try {
      const reveal = await openBrowserBridgeCompanionPackagePath(
        "chrome_build",
        { revealOnly: true },
      );
      const text = `Revealed the Agent Browser Bridge folder at ${reveal.path}.`;
      return {
        text,
        success: true,
        values: { success: true },
        data: {
          actionName: REVEAL_FOLDER_NAME,
          path: reveal.path,
        },
      };
    } catch (err) {
      const text = `Failed to reveal the Agent Browser Bridge extension folder: ${describeError(err)}`;
      logger.warn(`[${REVEAL_FOLDER_NAME}] ${text}`);
      return {
        text,
        success: false,
        values: {
          success: false,
          error: "BROWSER_BRIDGE_REVEAL_FOLDER_FAILED",
        },
        data: { actionName: REVEAL_FOLDER_NAME },
      };
    }
  },
  parameters: [],
  examples: [],
};

/**
 * BROWSER_BRIDGE_OPEN_MANAGER — mirrors the UI "Open chrome://extensions"
 * button. Opens the Chrome extensions manager.
 */
export const browserBridgeOpenManagerAction: Action = {
  name: OPEN_MANAGER_NAME,
  contexts: ["browser", "connectors", "settings"],
  contextGate: { anyOf: ["browser", "connectors", "settings"] },
  roleGate: { minRole: "USER" },
  similes: ["OPEN_CHROME_EXTENSIONS", "OPEN_BROWSER_BRIDGE_MANAGER"],
  description: JSON.stringify({
    browser_bridge_open_manager: {
      purpose:
        "Open chrome://extensions so the user can load the unpacked Agent Browser Bridge extension.",
      params: "none",
    },
  }),
  descriptionCompressed: "Open browser companion manager UI.",
  validate: validateBrowserBridgeAction(["browser", "connectors", "settings"]),
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state,
    _options,
  ): Promise<ActionResult> => {
    try {
      await openBrowserBridgeCompanionManager("chrome");
      const text =
        "Opened Chrome extensions. Click Load unpacked and choose the Agent Browser Bridge folder.";
      return {
        text,
        success: true,
        values: { success: true },
        data: { actionName: OPEN_MANAGER_NAME },
      };
    } catch (err) {
      const text = `Failed to open Chrome extensions: ${describeError(err)}`;
      logger.warn(`[${OPEN_MANAGER_NAME}] ${text}`);
      return {
        text,
        success: false,
        values: {
          success: false,
          error: "BROWSER_BRIDGE_OPEN_MANAGER_FAILED",
        },
        data: { actionName: OPEN_MANAGER_NAME },
      };
    }
  },
  parameters: [],
  examples: [],
};

/**
 * BROWSER_BRIDGE_REFRESH — mirrors the UI "Refresh" button.
 *
 * The UI's refresh path re-fetches `/api/browser-bridge/companions` and
 * `/api/browser-bridge/packages`. From inside the runtime we call directly
 * into the equivalent service + packaging helpers and return the snapshot
 * so the agent can reason about the current connection state.
 */
export const browserBridgeRefreshAction: Action = {
  name: REFRESH_NAME,
  contexts: ["browser", "connectors", "settings"],
  contextGate: { anyOf: ["browser", "connectors", "settings"] },
  roleGate: { minRole: "USER" },
  similes: [
    "REFRESH_BROWSER_BRIDGE",
    "REFRESH_BROWSER_BRIDGE_CONNECTION",
    "RELOAD_BROWSER_BRIDGE_STATUS",
  ],
  description: JSON.stringify({
    browser_bridge_refresh: {
      purpose:
        "Refresh Agent Browser Bridge connection status, paired companions, and packaging artifact paths.",
      provider_state:
        "Prefer provider state for passive status context; use this action for an explicit live refresh.",
      params: "none",
    },
  }),
  descriptionCompressed: "Refresh companion connection state.",
  validate: validateBrowserBridgeAction(["browser", "connectors", "settings"]),
  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state,
    _options,
  ): Promise<ActionResult> => {
    try {
      const status = getBrowserBridgeCompanionPackageStatus();

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
            error: "BROWSER_BRIDGE_SERVICE_UNAVAILABLE",
          },
          data: {
            actionName: REFRESH_NAME,
            status,
            companions,
          },
        };
      }

      companions = (await service.listBrowserCompanions()).slice(0, 25);
      const connected = companions.length > 0;
      const text = connected
        ? `Refreshed Agent Browser Bridge connection status: ${companions.length} paired companion(s).`
        : "Refreshed Agent Browser Bridge connection status: no paired companions.";

      return {
        text,
        success: true,
        values: {
          success: true,
          connected,
          companionCount: companions.length,
        },
        data: {
          actionName: REFRESH_NAME,
          status,
          companions,
        },
      };
    } catch (err) {
      const text = `Failed to refresh Agent Browser Bridge status: ${describeError(err)}`;
      logger.warn(`[${REFRESH_NAME}] ${text}`);
      return {
        text,
        success: false,
        values: { success: false, error: "BROWSER_BRIDGE_REFRESH_FAILED" },
        data: { actionName: REFRESH_NAME },
      };
    }
  },
  parameters: [],
  examples: [],
};

export const browserBridgeActions: Action[] = [
  browserBridgeInstallAction,
  browserBridgeRevealFolderAction,
  browserBridgeOpenManagerAction,
  browserBridgeRefreshAction,
];
