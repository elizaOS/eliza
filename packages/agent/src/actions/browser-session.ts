import type {
  Action,
  ActionExample,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { hasOwnerAccess } from "../security/access.js";
import {
  type BrowserWorkspaceCommand,
  executeBrowserWorkspaceCommand,
  getBrowserWorkspaceMode,
} from "../services/browser-workspace.js";

type BrowserSessionParameters = {
  id?: string;
  key?: string;
  pixels?: number;
  script?: string;
  selector?: string;
  subaction?:
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
  params: BrowserSessionParameters | undefined,
  messageText: string,
): BrowserWorkspaceCommand["subaction"] {
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

function formatBrowserSessionResult(
  command: BrowserWorkspaceCommand,
  result: Awaited<ReturnType<typeof executeBrowserWorkspaceCommand>>,
): string {
  if (result.tabs) {
    const labels = result.tabs
      .map((tab) => `- ${tab.title} (${tab.url})`)
      .join("\n");
    return labels
      ? `Browser session tabs (${result.mode}):\n${labels}`
      : `No browser session tabs are open (${result.mode}).`;
  }

  if (result.closed) {
    return `Browser session closed (${result.mode}).`;
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
    return `Browser session ${command.subaction} result (${result.mode}):\n${serialized}`;
  }

  if (result.snapshot?.data) {
    return `Browser session ${command.subaction} captured a preview in ${result.mode} mode.`;
  }

  return `Browser session ${command.subaction} completed in ${result.mode} mode.`;
}

export const browserSessionAction: Action = {
  name: "BROWSER_SESSION",
  contexts: ["browser", "web", "automation"],
  roleGate: { minRole: "ADMIN" },
  similes: [
    "BROWSE_SITE",
    "CONTROL_BROWSER_SESSION",
    "NAVIGATE_SITE",
    "OPEN_SITE",
    "USE_BROWSER",
  ],
  description:
    "Control the Eliza browser workspace through one session surface. Uses the real desktop browser bridge or hosted Eliza Cloud browser when available, and falls back to the limited embedded web mode only when no real browser session backend is configured.",
  descriptionCompressed:
    "control Eliza browser workspace through one session surface use real desktop browser bridge host Eliza Cloud browser available, fall back limit embedd web mode real browser session backend configur",
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    return hasOwnerAccess(runtime, message);
  },
  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner may control browser sessions.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: "BROWSER_SESSION" },
      };
    }

    const params = (options as HandlerOptions | undefined)?.parameters as
      | BrowserSessionParameters
      | undefined;
    const messageText = getMessageText(message);
    const url =
      params?.url?.trim() || extractFirstUrl(messageText) || undefined;
    const subaction = inferBrowserSubaction(params, messageText);

    const command: BrowserWorkspaceCommand = {
      id: params?.id?.trim(),
      key: params?.key?.trim(),
      pixels: params?.pixels,
      script: params?.script,
      selector: params?.selector?.trim(),
      subaction,
      tabAction: params?.tabAction,
      text: params?.text,
      timeoutMs: params?.timeoutMs,
      url,
      cursorDurationMs: params?.cursorDurationMs,
      perCharDelayMs: params?.perCharDelayMs,
      replace: params?.replace,
      x: params?.x,
      y: params?.y,
    };

    try {
      logger.info(
        `[browser-session] ${command.subaction} via ${getBrowserWorkspaceMode(process.env)}`,
      );
      const result = await executeBrowserWorkspaceCommand(command);

      return {
        text: formatBrowserSessionResult(command, result),
        success: true,
        values: {
          success: true,
          mode: result.mode,
          subaction: result.subaction,
        },
        data: {
          actionName: "BROWSER_SESSION",
          command,
          result,
        },
      };
    } catch (error) {
      const messageText =
        error instanceof Error ? error.message : "Browser session failed";
      logger.warn(`[browser-session] Failed: ${messageText}`);
      return {
        text: `Browser session failed: ${messageText}`,
        success: false,
        values: { success: false, error: "BROWSER_SESSION_FAILED" },
        data: {
          actionName: "BROWSER_SESSION",
          command,
        },
      };
    }
  },
  parameters: [
    {
      name: "subaction",
      description: "Browser session action to perform",
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
