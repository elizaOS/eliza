import type {
  Action,
  ActionExample,
  HandlerOptions,
  Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  BROWSER_SERVICE_TYPE,
  type BrowserService,
} from "../browser-service.js";
import { executeBrowserAutofillLogin } from "./browser-autofill-login.js";
import {
  type BrowserWorkspaceCommand,
  executeBrowserWorkspaceCommand,
  getBrowserWorkspaceMode,
} from "../workspace/browser-workspace.js";

/**
 * Targets are the registered browser backends. The agent uses what is
 * available; specifying a target overrides the default. `workspace` is the
 * current default (electrobun-embedded BrowserView with JSDOM fallback).
 * `bridge` (Chrome/Safari companion) and `computeruse` (puppeteer Chromium)
 * are reserved for the BrowserService target-registry refactor — see
 * follow-up work.
 */
export type BrowserTarget = "workspace" | "bridge" | "computeruse";

type BrowserWorkspaceSubaction =
  | "back"
  | "click"
  | "close"
  | "forward"
  | "get"
  | "hide"
  | "navigate"
  | "open"
  | "press"
  | "reload"
  | "screenshot"
  | "show"
  | "snapshot"
  | "state"
  | "tab"
  | "type"
  | "wait"
  | "realistic-click"
  | "realistic-fill"
  | "realistic-type"
  | "realistic-press"
  | "cursor-move"
  | "cursor-hide";

type BrowserActionSubaction = BrowserWorkspaceSubaction | "autofill-login";

type BrowserActionParameters = {
  /**
   * Optional target override. Default: the BrowserService active target
   * (currently always `workspace`). Forces a specific backend when set.
   */
  target?: BrowserTarget;
  id?: string;
  key?: string;
  pixels?: number;
  script?: string;
  selector?: string;
  /**
   * Canonical browser action. Legacy `subaction` remains accepted.
   */
  action?:
    | BrowserWorkspaceSubaction
    | "autofill-login"
    | "info"
    | "context"
    | "get_context"
    | "list_tabs"
    | "open_tab"
    | "close_tab"
    | "switch_tab";
  subaction?: BrowserActionSubaction;
  /** Registrable hostname for `action: "autofill-login"`. */
  domain?: string;
  /** Saved login username for autofill-login (optional). */
  username?: string;
  /** When true with autofill-login, submit after filling. */
  submit?: boolean;
  tabAction?: "close" | "list" | "new" | "switch";
  text?: string;
  timeoutMs?: number;
  url?: string;
  /** Cursor animation duration (ms) for realistic-* + cursor-* subactions. */
  cursorDurationMs?: number;
  /** Per-character delay for realistic-type / realistic-fill (ms). */
  perCharDelayMs?: number;
  /** Replace existing input value when filling (vs append). */
  replace?: boolean;
  /** Cursor target X (CSS pixels) for cursor-move. */
  x?: number;
  /** Cursor target Y (CSS pixels) for cursor-move. */
  y?: number;
  /** Hint that the agent is operating in a watch-mode (page-browser) scope. */
  watchMode?: boolean;
};

function getMessageText(message: Memory | undefined): string {
  const content = message?.content;
  if (typeof content === "string") {
    return content;
  }
  return typeof content?.text === "string" ? content.text : "";
}

function extractFirstUrl(value: string): string | null {
  const match = value.match(/https?:\/\/[^\s<>"'`]+/i);
  return match?.[0] ?? null;
}

function inferBrowserSubaction(
  params: BrowserActionParameters | undefined,
  messageText: string,
): BrowserWorkspaceCommand["subaction"] | "autofill-login" {
  if (params?.action === "autofill-login" || params?.subaction === "autofill-login") {
    return "autofill-login";
  }

  const legacySubaction = normalizeLegacyBrowserAction(params?.action);
  if (legacySubaction) {
    return legacySubaction;
  }
  if (params?.subaction) {
    return params.subaction;
  }

  if (params?.tabAction) {
    return "tab";
  }

  // In watch mode the user is observing the agent drive the browser; prefer
  // the realistic-* subactions so the cursor moves and pointer events fire
  // faithfully. Default-mode (no watcher) keeps the leaner click()/value=
  // path for speed.
  const watchMode = params?.watchMode === true;

  if (params?.selector && params?.text) {
    return watchMode ? "realistic-fill" : "type";
  }

  if (params?.selector) {
    return watchMode ? "realistic-click" : "click";
  }

  if (params?.url?.trim() || extractFirstUrl(messageText)) {
    return params?.id ? "navigate" : "open";
  }

  return "state";
}

function normalizeLegacyBrowserAction(
  action: BrowserActionParameters["action"] | undefined,
): BrowserWorkspaceCommand["subaction"] | undefined {
  switch (action) {
    case "info":
    case "context":
    case "get_context":
      return "state";
    case "list_tabs":
    case "open_tab":
    case "close_tab":
    case "switch_tab":
      return "tab";
    case "autofill-login":
      return undefined;
    case undefined:
      return undefined;
    default:
      return action;
  }
}

function normalizeLegacyTabAction(
  action: BrowserActionParameters["action"] | undefined,
): BrowserActionParameters["tabAction"] | undefined {
  switch (action) {
    case "list_tabs":
      return "list";
    case "open_tab":
      return "new";
    case "close_tab":
      return "close";
    case "switch_tab":
      return "switch";
    default:
      return undefined;
  }
}

function formatBrowserSessionResult(
  command: BrowserWorkspaceCommand,
  result: Awaited<ReturnType<typeof executeBrowserWorkspaceCommand>>,
): string {
  if (result.tabs) {
    const labels = result.tabs
      .map((tab) => `- ${tab.title} (${tab.url})`)
      .join("\n");
    return labels
      ? `Browser tabs (${result.mode}):\n${labels}`
      : `No browser session tabs are open (${result.mode}).`;
  }

  if (result.closed) {
    return `Browser closed (${result.mode}).`;
  }

  if (result.tab) {
    return `${command.subaction} completed in ${result.mode} mode.\n${result.tab.title}\n${result.tab.url}`;
  }

  if (result.value !== undefined) {
    if (
      command.subaction === "cursor-move" &&
      result.value !== null &&
      typeof result.value === "object" &&
      "x" in result.value &&
      "y" in result.value
    ) {
      const cursor = result.value as { x: number; y: number };
      return `Cursor moved to (${Math.round(cursor.x)}, ${Math.round(cursor.y)}) in ${result.mode} mode.`;
    }
    const serialized =
      typeof result.value === "string"
        ? result.value
        : JSON.stringify(result.value, null, 2);
    return `Browser ${command.subaction} result (${result.mode}):\n${serialized}`;
  }

  if (result.snapshot?.data) {
    return `Browser ${command.subaction} captured a preview in ${result.mode} mode.`;
  }

  return `Browser ${command.subaction} completed in ${result.mode} mode.`;
}

export const browserAction: Action = {
  name: "BROWSER",
  contexts: ["browser", "web", "automation", "secrets"],
  roleGate: { minRole: "OWNER" },
  similes: [
    "BROWSE_SITE",
    "BROWSER_SESSION",
    "CONTROL_BROWSER",
    "CONTROL_BROWSER_SESSION",
    "MANAGE_ELIZA_BROWSER_WORKSPACE",
    "MANAGE_LIFEOPS_BROWSER",
    "NAVIGATE_SITE",
    "OPEN_SITE",
    "USE_BROWSER",
    "BROWSER_ACTION",
    "BROWSER_AUTOFILL_LOGIN",
    "AGENT_AUTOFILL",
    "AUTOFILL_BROWSER_LOGIN",
    "AUTOFILL_LOGIN",
    "FILL_BROWSER_CREDENTIALS",
    "LOG_INTO_SITE",
    "SIGN_IN_TO_SITE",
  ],
  description:
    "Single BROWSER action — control whichever browser target is registered. Targets are pluggable: `workspace` (electrobun-embedded BrowserView, the default; falls back to a JSDOM web mode when the desktop bridge isn't configured), `bridge` (the user's real Chrome/Safari via the Agent Browser Bridge companion extension), and `computeruse` (a local puppeteer-driven Chromium via plugin-computeruse). The agent uses what is available — the BrowserService picks the active target when none is specified. Use `subaction: \"autofill-login\"` with `domain` (and optional `username`, `submit`) to vault-gated autofill into an open workspace tab.",
  descriptionCompressed:
    "Browser tab/page control: open/navigate/click/type/screenshot/state; subaction autofill-login + domain autofill vault-gated credential into workspace tab pre-authorized in Settings Vault Logins. Bridge settings/status use MANAGE_BROWSER_BRIDGE.",
  validate: async () => true,
  handler: async (runtime, message, _state, options) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | BrowserActionParameters
      | undefined;
    const messageText = getMessageText(message);
    const subaction = inferBrowserSubaction(params, messageText);

    if (subaction === "autofill-login") {
      return executeBrowserAutofillLogin(runtime, message, options);
    }

    const url =
      params?.url?.trim() || extractFirstUrl(messageText) || undefined;

    const command: BrowserWorkspaceCommand = {
      id: params?.id?.trim(),
      key: params?.key?.trim(),
      pixels: params?.pixels,
      script: params?.script,
      selector: params?.selector?.trim(),
      subaction,
      tabAction: params?.tabAction ?? normalizeLegacyTabAction(params?.action),
      text: params?.text,
      timeoutMs: params?.timeoutMs,
      url,
      cursorDurationMs: params?.cursorDurationMs,
      perCharDelayMs: params?.perCharDelayMs,
      replace: params?.replace,
      x: params?.x,
      y: params?.y,
    };

    const browserService = runtime.getService<BrowserService>(
      BROWSER_SERVICE_TYPE,
    );

    try {
      logger.info(
        `[BROWSER] ${command.subaction} via target=${params?.target ?? "auto"} (workspace mode=${getBrowserWorkspaceMode(process.env)})`,
      );
      const result = browserService
        ? await browserService.execute(command, params?.target)
        : await executeBrowserWorkspaceCommand(command);

      return {
        text: formatBrowserSessionResult(command, result),
        success: true,
        values: {
          success: true,
          mode: result.mode,
          subaction: result.subaction,
        },
        data: {
          actionName: "BROWSER",
          command,
          result,
        },
      };
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : "Browser action failed";
      logger.warn(`[BROWSER] Failed: ${messageText}`);
      return {
        text: `Browser action failed: ${messageText}`,
        success: false,
        values: { success: false, error: "BROWSER_FAILED" },
        data: {
          actionName: "BROWSER",
          command,
        },
      };
    }
  },
  parameters: [
    {
      name: "action",
      description:
        "Browser action to perform. Legacy subaction is also accepted.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "back",
          "click",
          "close",
          "context",
          "forward",
          "get",
          "get_context",
          "hide",
          "info",
          "list_tabs",
          "navigate",
          "open",
          "open_tab",
          "press",
          "reload",
          "screenshot",
          "show",
          "snapshot",
          "state",
          "tab",
          "type",
          "wait",
          "close_tab",
          "switch_tab",
          "realistic-click",
          "realistic-fill",
          "realistic-type",
          "realistic-press",
          "cursor-move",
          "cursor-hide",
          "autofill-login",
        ],
      },
    },
    {
      name: "subaction",
      description: "Legacy alias for action.",
      required: false,
      schema: {
        type: "string" as const,
        enum: [
          "back",
          "click",
          "close",
          "forward",
          "get",
          "hide",
          "navigate",
          "open",
          "press",
          "reload",
          "screenshot",
          "show",
          "snapshot",
          "state",
          "tab",
          "type",
          "wait",
          "realistic-click",
          "realistic-fill",
          "realistic-type",
          "realistic-press",
          "cursor-move",
          "cursor-hide",
          "autofill-login",
        ],
      },
    },
    {
      name: "tabAction",
      description: "Tab operation when subaction is tab",
      required: false,
      schema: {
        type: "string" as const,
        enum: ["close", "list", "new", "switch"],
      },
    },
    {
      name: "domain",
      description:
        "Required when subaction is autofill-login: registrable hostname (e.g. `github.com`).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "username",
      description:
        "When using autofill-login: specific saved login; omit for most recently modified.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "submit",
      description:
        "When using autofill-login: submit the form after filling (default false).",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "id",
      description: "Session or tab id to target",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "url",
      description: "URL for open or navigate",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "selector",
      description: "Selector for click, type, or wait",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "text",
      description: "Text for type",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "key",
      description: "Keyboard key for press",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "pixels",
      description: "Scroll distance in pixels",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "timeoutMs",
      description: "Command timeout in milliseconds",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "script",
      description: "Script for eval",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "watchMode",
      description:
        "Hint that the user is watching; prefers realistic-* subactions for click/fill so the cursor moves visibly and pointer events fire faithfully.",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "cursorDurationMs",
      description: "Cursor animation duration (ms) for realistic-* subactions",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "perCharDelayMs",
      description: "Per-character delay for realistic-type/realistic-fill (ms)",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "replace",
      description:
        "Replace existing input value when filling (vs append) — applies to realistic-fill",
      required: false,
      schema: { type: "boolean" as const },
    },
    {
      name: "x",
      description: "Cursor target X (CSS pixels) for cursor-move",
      required: false,
      schema: { type: "number" as const },
    },
    {
      name: "y",
      description: "Cursor target Y (CSS pixels) for cursor-move",
      required: false,
      schema: { type: "number" as const },
    },
  ],
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Open elizaos.ai in a new browser tab.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "open completed in desktop mode.\nelizaOS\nhttps://elizaos.ai",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Click the sign-in button on that page.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "click completed in desktop mode.",
        },
      },
    ],
  ] as ActionExample[][],
};
