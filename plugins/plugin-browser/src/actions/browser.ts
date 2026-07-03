import type {
  Action,
  ActionExample,
  Content,
  HandlerCallback,
  HandlerOptions,
  Memory,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  BROWSER_SERVICE_TYPE,
  type BrowserService,
} from "../browser-service.js";
import {
  type BrowserWorkspaceCommand,
  type BrowserWorkspaceCommandResult,
  executeBrowserWorkspaceCommand,
  getBrowserWorkspaceMode,
} from "../workspace/browser-workspace.js";
import {
  WAIT_FOR_URL_DEFAULT_POLL_INTERVAL_MS,
  WAIT_FOR_URL_DEFAULT_TIMEOUT_MS,
  waitForUrl,
} from "./wait-for-url.js";

/**
 * Targets are the registered browser backends. The agent uses what is
 * available; specifying a target overrides automatic routing. `workspace`
 * is the app-owned browser surface, `bridge` is the paired Chrome/Safari
 * companion, `stagehand` is the Playwright/Stagehand fallback, and other
 * plugins may register additional target ids.
 */
export type BrowserTarget = string;

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

type BrowserWorkspaceAction =
  | BrowserWorkspaceSubaction
  | "realistic_click"
  | "realistic_fill"
  | "realistic_type"
  | "realistic_press"
  | "cursor_move"
  | "cursor_hide";

type BrowserActionSubaction =
  | BrowserWorkspaceSubaction
  | "autofill-login"
  | "wait-for-url";
type BrowserActionValue =
  | BrowserWorkspaceAction
  | "autofill_login"
  | "autofill-login"
  | "wait_for_url"
  | "wait-for-url";
type NormalizedBrowserAction =
  | BrowserWorkspaceSubaction
  | "autofill-login"
  | "wait-for-url"
  | "info"
  | "context"
  | "get_context"
  | "list_tabs"
  | "open_tab"
  | "close_tab"
  | "switch_tab";

type BrowserActionParameters = {
  /**
   * Optional target override. Default: the BrowserService active target
   * selected from registered targets. Forces a specific backend when set.
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
    | BrowserActionValue
    | "info"
    | "context"
    | "get_context"
    | "list_tabs"
    | "open_tab"
    | "close_tab"
    | "switch_tab";
  subaction?: BrowserActionSubaction;
  /** For action=wait_for_url: substring or regex to match the tab URL. */
  pattern?: string;
  /** For action=wait_for_url: poll cadence in ms (default ~2000). */
  pollIntervalMs?: number;
  /** Registrable hostname for `action: "autofill_login"`. */
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
  /** Emit one compact progress callback after the browser step dispatches. */
  streamProgress?: boolean;
  /** Optional rationale to show in the compact progress callback. */
  rationale?: string;
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
): BrowserWorkspaceCommand["subaction"] | "autofill-login" | "wait-for-url" {
  const normalizedAction = normalizeBrowserAction(params?.action);
  if (
    normalizedAction === "autofill-login" ||
    params?.subaction === "autofill-login"
  ) {
    return "autofill-login";
  }

  if (
    normalizedAction === "wait-for-url" ||
    params?.subaction === "wait-for-url"
  ) {
    return "wait-for-url";
  }

  const legacySubaction = normalizeLegacyBrowserAction(normalizedAction);
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

function normalizeBrowserAction(
  action: BrowserActionParameters["action"] | undefined,
): NormalizedBrowserAction | undefined {
  switch (action) {
    case "realistic_click":
      return "realistic-click";
    case "realistic_fill":
      return "realistic-fill";
    case "realistic_type":
      return "realistic-type";
    case "realistic_press":
      return "realistic-press";
    case "cursor_move":
      return "cursor-move";
    case "cursor_hide":
      return "cursor-hide";
    case "autofill_login":
      return "autofill-login";
    case "wait_for_url":
    case "wait-for-url":
      return "wait-for-url";
    default:
      return action as NormalizedBrowserAction | undefined;
  }
}

function normalizeLegacyBrowserAction(
  action: BrowserActionParameters["action"] | undefined,
): BrowserWorkspaceCommand["subaction"] | undefined {
  const normalizedAction = normalizeBrowserAction(action);
  switch (normalizedAction) {
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
    case "wait-for-url":
      return undefined;
    case undefined:
      return undefined;
    default:
      return isWorkspaceSubaction(normalizedAction)
        ? normalizedAction
        : undefined;
  }
}

function isWorkspaceSubaction(
  action: unknown,
): action is BrowserWorkspaceCommand["subaction"] {
  return (
    action === "back" ||
    action === "click" ||
    action === "close" ||
    action === "forward" ||
    action === "get" ||
    action === "hide" ||
    action === "navigate" ||
    action === "open" ||
    action === "press" ||
    action === "reload" ||
    action === "screenshot" ||
    action === "show" ||
    action === "snapshot" ||
    action === "state" ||
    action === "tab" ||
    action === "type" ||
    action === "wait" ||
    action === "realistic-click" ||
    action === "realistic-fill" ||
    action === "realistic-type" ||
    action === "realistic-press" ||
    action === "cursor-move" ||
    action === "cursor-hide"
  );
}

function normalizeLegacyTabAction(
  action: BrowserActionParameters["action"] | undefined,
): BrowserActionParameters["tabAction"] | undefined {
  switch (normalizeBrowserAction(action)) {
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

function browserProgressRationale(
  command: BrowserWorkspaceCommand,
  params: BrowserActionParameters | undefined,
  messageText: string,
): string {
  const explicit = params?.rationale?.trim();
  if (explicit) return explicit;

  switch (command.subaction) {
    case "open":
    case "navigate":
      return command.url ? `open ${command.url}` : "open requested page";
    case "click":
    case "realistic-click":
      return command.selector
        ? `click ${command.selector}`
        : "click requested target";
    case "type":
    case "realistic-fill":
    case "realistic-type":
      return command.selector
        ? `fill ${command.selector}`
        : "type requested text";
    case "press":
    case "realistic-press":
      return command.key ? `press ${command.key}` : "press requested key";
    case "tab":
      return command.tabAction
        ? `${command.tabAction} browser tab`
        : "manage browser tabs";
    case "wait":
      return command.selector
        ? `wait for ${command.selector}`
        : "wait for browser state";
    case "state":
      return messageText.trim() || "read browser state";
    default:
      return `run browser ${command.subaction}`;
  }
}

function buildBrowserStepProgressContent(
  command: BrowserWorkspaceCommand,
  params: BrowserActionParameters | undefined,
  messageText: string,
  success: boolean,
  error?: string,
): Content {
  const rationale = error
    ? `failed: ${error}`
    : browserProgressRationale(command, params, messageText);
  return {
    text: `Step 1: ${command.subaction} — ${rationale}`,
    source: "action_progress",
    merge: "replace",
    metadata: {
      transient: true,
      compactProgress: true,
      progress: {
        source: "browser",
        actionName: "BROWSER",
        step: 1,
        kind: command.subaction,
        rationale,
        success,
        error,
      },
    },
  };
}

async function emitBrowserStepProgress(
  callback: HandlerCallback | undefined,
  command: BrowserWorkspaceCommand,
  params: BrowserActionParameters | undefined,
  messageText: string,
  success: boolean,
  error?: string,
): Promise<void> {
  if (params?.streamProgress !== true || !callback) return;
  try {
    await callback(
      buildBrowserStepProgressContent(
        command,
        params,
        messageText,
        success,
        error,
      ),
      "BROWSER",
    );
  } catch (callbackError) {
    logger.warn(
      {
        src: "plugin:browser",
        action: command.subaction,
        error:
          callbackError instanceof Error
            ? callbackError.message
            : String(callbackError),
      },
      "Failed to emit browser progress callback",
    );
  }
}

function currentUrlFromResult(
  result: BrowserWorkspaceCommandResult,
): string | null {
  if (result.tab?.url) {
    return result.tab.url;
  }
  if (typeof result.value === "string" && result.value.trim()) {
    return result.value.trim();
  }
  if (Array.isArray(result.tabs)) {
    const visible = result.tabs.find((tab) => tab.visible) ?? result.tabs[0];
    if (visible?.url) {
      return visible.url;
    }
  }
  return null;
}

/**
 * Reads the current tab URL via the active browser target. Prefers a targeted
 * `get url` (cheap), falling back to `state` for backends that don't implement
 * the get-url mode. Returns null when the URL is not yet readable.
 */
async function readCurrentBrowserUrl(
  browserService: BrowserService | null,
  target: BrowserTarget | undefined,
  tabId: string | undefined,
): Promise<string | null> {
  const run = async (
    command: BrowserWorkspaceCommand,
  ): Promise<BrowserWorkspaceCommandResult> =>
    browserService
      ? browserService.execute(command, target)
      : executeBrowserWorkspaceCommand(command);

  try {
    const got = await run({
      subaction: "get",
      getMode: "url",
      id: tabId,
    });
    const url = currentUrlFromResult(got);
    if (url) {
      return url;
    }
  } catch (error) {
    logger.debug(
      `[BROWSER] wait_for_url get-url poll failed, falling back to state: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const state = await run({ subaction: "state", id: tabId });
    const url = currentUrlFromResult(state);
    if (url) {
      return url;
    }
  } catch (error) {
    logger.debug(
      `[BROWSER] wait_for_url state poll could not read URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const tabs = await run({ subaction: "list" });
    if (Array.isArray(tabs.tabs)) {
      const tab = tabId
        ? tabs.tabs.find((entry) => entry.id === tabId)
        : (tabs.tabs.find((entry) => entry.visible) ?? tabs.tabs[0]);
      return tab?.url ?? null;
    }
  } catch (error) {
    logger.debug(
      `[BROWSER] wait_for_url tab-list poll could not read URL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return null;
}

/**
 * Handles `action: "wait_for_url"`. Optionally opens/navigates to a starting
 * URL, tells the user it is watching, then polls the tab URL against `pattern`,
 * streaming a status update each poll. Resolves with a typed success/timeout
 * result and never throws on timeout.
 */
async function executeBrowserWaitForUrl(
  runtime: Parameters<NonNullable<Action["handler"]>>[0],
  params: BrowserActionParameters | undefined,
  messageText: string,
  callback: HandlerCallback | undefined,
): Promise<ReturnType<NonNullable<Action["handler"]>>> {
  const pattern = (params?.pattern ?? "").trim();
  if (!pattern) {
    const text =
      "wait_for_url needs a `pattern` (substring or regex) to watch for.";
    logger.warn(`[BROWSER] ${text}`);
    return {
      text,
      success: false,
      values: { success: false, error: "BROWSER_WAIT_FOR_URL_NO_PATTERN" },
      data: { actionName: "BROWSER", subaction: "wait_for_url" },
    };
  }

  const browserService =
    runtime.getService<BrowserService>(BROWSER_SERVICE_TYPE) ?? null;
  const target = params?.target;
  const startUrl =
    params?.url?.trim() || extractFirstUrl(messageText) || undefined;
  const timeoutMs = params?.timeoutMs ?? WAIT_FOR_URL_DEFAULT_TIMEOUT_MS;
  const pollIntervalMs =
    params?.pollIntervalMs ?? WAIT_FOR_URL_DEFAULT_POLL_INTERVAL_MS;

  let tabId = params?.id?.trim() || undefined;

  // Optionally launch the starting URL so the user can act on it.
  if (startUrl) {
    const openCommand: BrowserWorkspaceCommand = {
      subaction: tabId ? "navigate" : "open",
      url: startUrl,
      id: tabId,
    };
    try {
      const opened = browserService
        ? await browserService.execute(openCommand, target)
        : await executeBrowserWorkspaceCommand(openCommand);
      tabId = opened.tab?.id ?? tabId;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[BROWSER] wait_for_url could not open ${startUrl}: ${reason}`,
      );
      return {
        text: `Couldn't open ${startUrl} to watch for "${pattern}": ${reason}`,
        success: false,
        values: { success: false, error: "BROWSER_WAIT_FOR_URL_OPEN_FAILED" },
        data: { actionName: "BROWSER", subaction: "wait_for_url" },
      };
    }
  }

  await callback?.({
    text: startUrl
      ? `I opened ${startUrl} — watching for "${pattern}" and I'll resume when it's reached.`
      : `Watching the current tab for "${pattern}" — I'll resume when it's reached.`,
  });

  logger.info(
    `[BROWSER] wait_for_url pattern="${pattern}" timeoutMs=${timeoutMs} pollIntervalMs=${pollIntervalMs} target=${target ?? "auto"}`,
  );

  const outcome = await waitForUrl(
    { pattern, timeoutMs, pollIntervalMs },
    {
      getCurrentUrl: () => readCurrentBrowserUrl(browserService, target, tabId),
      emitStatus: async (text) => {
        await callback?.({ text });
      },
    },
  );

  return {
    text: outcome.message,
    success: outcome.matched,
    userFacingText: outcome.message,
    values: {
      success: outcome.matched,
      subaction: "wait_for_url",
      status: outcome.status,
      matched: outcome.matched,
      polls: outcome.polls,
    },
    data: {
      actionName: "BROWSER",
      subaction: "wait_for_url",
      outcome,
    },
  };
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
    "BROWSER action. Control registered browser target: app workspace, bridge Chrome/Safari companion, computeruse Chromium, or Stagehand fallback. BrowserService picks target if omitted. action=autofill_login + domain vault-gated autofills open workspace tab. action=wait_for_url + pattern opens an optional url then watches the tab and resumes when its URL matches (OAuth callback, deploy/CI done), streaming progress.",
  descriptionCompressed:
    "Browser open|navigate|click|type|screenshot|state|autofill_login|wait_for_url; bridge status elsewhere",
  routingHint:
    "drive an INTERACTIVE web browser session — navigate/click/type across pages, log into a site, or autofill saved credentials on a real browser target -> BROWSER; to fetch ONE URL's contents in a single shot -> WEB_FETCH, to answer an open-web question -> WEB_SEARCH, or to control native desktop apps/Finder/windows on the machine -> COMPUTER_USE",
  validate: async () => true,
  handler: async (
    runtime,
    message,
    _state,
    options,
    callback?: HandlerCallback,
  ) => {
    const params = (options as HandlerOptions | undefined)?.parameters as
      | BrowserActionParameters
      | undefined;
    const messageText = getMessageText(message);
    const subaction = inferBrowserSubaction(params, messageText);

    if (subaction === "autofill-login") {
      const { executeBrowserAutofillLogin } = await import(
        "./browser-autofill-login.js"
      );
      return executeBrowserAutofillLogin(runtime, message, options);
    }

    if (subaction === "wait-for-url") {
      return executeBrowserWaitForUrl(runtime, params, messageText, callback);
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
      value: params?.text,
      timeoutMs: params?.timeoutMs,
      url,
      cursorDurationMs: params?.cursorDurationMs,
      perCharDelayMs: params?.perCharDelayMs,
      replace: params?.replace,
      x: params?.x,
      y: params?.y,
    };

    const browserService =
      runtime.getService<BrowserService>(BROWSER_SERVICE_TYPE);

    try {
      logger.info(
        `[BROWSER] ${command.subaction} via target=${params?.target ?? "auto"} (workspace mode=${getBrowserWorkspaceMode(process.env)})`,
      );
      const result = browserService
        ? await browserService.execute(command, params?.target)
        : await executeBrowserWorkspaceCommand(command);
      await emitBrowserStepProgress(
        callback,
        command,
        params,
        messageText,
        true,
      );

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
      const errorText =
        error instanceof Error ? error.message : "Browser action failed";
      logger.warn(`[BROWSER] Failed: ${errorText}`);
      await emitBrowserStepProgress(
        callback,
        command,
        params,
        messageText,
        false,
        errorText,
      );
      return {
        text: `Browser action failed: ${errorText}`,
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
      name: "target",
      description:
        "Optional browser target id. Common values: workspace, bridge, computeruse, stagehand.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "streamProgress",
      description:
        "When true, emit a compact Step 1 progress callback after the browser command dispatches.",
      required: false,
      schema: { type: "boolean" as const, default: false },
    },
    {
      name: "rationale",
      description: "Optional rationale shown in streamProgress callback text.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "action",
      description:
        "Browser action. Snake_case canonical; legacy kebab-case and subaction accepted.",
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
          "realistic_click",
          "realistic_fill",
          "realistic_type",
          "realistic_press",
          "cursor_move",
          "cursor_hide",
          "autofill_login",
          "wait_for_url",
        ],
      },
    },
    {
      name: "pattern",
      description:
        "For action=wait_for_url: substring or /regex/ to match the tab URL (e.g. callback?code=, or /\\/done$/).",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "pollIntervalMs",
      description: "For action=wait_for_url: poll cadence in ms. Default 2000.",
      required: false,
      schema: { type: "number" as const },
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
        "Required for action=autofill_login: registrable hostname, e.g. github.com.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "username",
      description: "For autofill-login: saved login username; omit for latest.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "submit",
      description: "For autofill-login: submit after filling. Default false.",
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
        "User watching hint; prefer realistic-* click/fill, visible cursor, pointer events.",
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
      description: "For realistic-fill: replace existing input, not append.",
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
    [
      {
        name: "{{name1}}",
        content: {
          text: "Open the GitHub OAuth page and let me know when it redirects back to our callback.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I opened https://github.com/login/oauth/authorize — watching for \"callback?code=\" and I'll resume when it's reached.",
          actions: ["BROWSER"],
        },
      },
    ],
  ] as ActionExample[][],
};
