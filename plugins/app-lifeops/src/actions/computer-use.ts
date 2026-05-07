/**
 * LifeOps computer-use action.
 *
 * Thin wrapper over @elizaos/plugin-computeruse's useComputerAction with
 * LifeOps-specific access control (owner-only) and an opt-out feature flag
 * (ELIZA_LIFEOPS_COMPUTER_USE_ENABLED=0). If the plugin package is not
 * installed in the workspace, exports an unavailable action that returns a clear
 * "not installed" result instead of crashing the plugin load.
 */

import { hasOwnerAccess } from "@elizaos/agent/security/access";
import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";

const ACTION_NAME = "COMPUTER_USE";
const COMPUTER_USE_PACKAGE = "@elizaos/plugin-computeruse";
const ACTION_NAMES = {
  desktop: "USE_COMPUTER",
  browser: "BROWSER_ACTION",
  window: "MANAGE_WINDOW",
  file: "FILE_ACTION",
  terminal: "TERMINAL_ACTION",
} as const;
const COMPUTER_USE_CONTEXTS = ["browser", "automation", "files", "terminal", "admin"] as const;
const COMPUTER_USE_KEYWORDS = [
  "computer",
  "desktop",
  "screenshot",
  "screen",
  "click",
  "drag",
  "keyboard",
  "window",
  "finder",
  "terminal",
  "browser",
  "file",
  "carpeta",
  "pantalla",
  "clic",
  "teclado",
  "ordinateur",
  "bureau",
  "écran",
  "clavier",
  "fenêtre",
  "computer",
  "bildschirm",
  "tastatur",
  "fenster",
  "computador",
  "tela",
  "teclado",
  "computadora",
  "schermo",
  "tastiera",
  "finestra",
  "スクリーンショット",
  "画面",
  "クリック",
  "キーボード",
  "截图",
  "屏幕",
  "点击",
  "键盘",
  "스크린샷",
  "화면",
  "클릭",
  "키보드",
] as const;

type ComputerUseSurface = keyof typeof ACTION_NAMES;

interface LoadedComputerUseActions {
  desktop: Action | null;
  browser: Action | null;
  window: Action | null;
  file: Action | null;
  terminal: Action | null;
}

function hasSelectedContext(state: State | undefined): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect((state?.values as Record<string, unknown> | undefined)?.selectedContexts);
  collect((state?.data as Record<string, unknown> | undefined)?.selectedContexts);
  const contextObject = (state?.data as Record<string, unknown> | undefined)?.contextObject as
    | { trajectoryPrefix?: { selectedContexts?: unknown }; metadata?: { selectedContexts?: unknown } }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return COMPUTER_USE_CONTEXTS.some((context) => selected.has(context));
}

function hasComputerUseIntent(message: Memory, state: State | undefined): boolean {
  const text = [
    typeof message.content?.text === "string" ? message.content.text : "",
    typeof state?.values?.recentMessages === "string" ? state.values.recentMessages : "",
  ]
    .join("\n")
    .toLowerCase();
  return COMPUTER_USE_KEYWORDS.some((keyword) => text.includes(keyword.toLowerCase()));
}

function isComputerUseEnabled(): boolean {
  return process.env.ELIZA_LIFEOPS_COMPUTER_USE_ENABLED !== "0";
}

function resolveWrapperParams(
  message: Memory,
  options?: HandlerOptions,
): Record<string, unknown> {
  const params = {
    ...(((options as Record<string, unknown> | undefined)?.parameters ??
      {}) as Record<string, unknown>),
  };

  if (message.content && typeof message.content === "object") {
    for (const [key, value] of Object.entries(
      message.content as Record<string, unknown>,
    )) {
      if (params[key] === undefined) {
        params[key] = value;
      }
    }
  }

  return params;
}

function readSurface(
  params: Record<string, unknown>,
): ComputerUseSurface | null {
  const value =
    typeof params.surface === "string"
      ? params.surface.trim().toLowerCase()
      : null;
  if (
    value === "desktop" ||
    value === "browser" ||
    value === "window" ||
    value === "file" ||
    value === "terminal"
  ) {
    return value;
  }
  return null;
}

function readNormalizedStringParam(
  params: Record<string, unknown>,
  key: string,
): string {
  const value = params[key];
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isDesktopAlias(value: string): boolean {
  return (
    value === "finder" ||
    value === "open_finder" ||
    value === "open finder" ||
    value === "desktop" ||
    value === "screenshot" ||
    value === "take_screenshot"
  );
}

function selectSurface(params: Record<string, unknown>): ComputerUseSurface {
  const explicitSurface = readSurface(params);
  if (explicitSurface) {
    return explicitSurface;
  }

  const action = readNormalizedStringParam(params, "action");
  const command = readNormalizedStringParam(params, "command");
  if (isDesktopAlias(action) || isDesktopAlias(command)) {
    return "desktop";
  }

  if (
    readNormalizedStringParam(params, "url") ||
    readNormalizedStringParam(params, "selector") ||
    ["navigate", "click", "type", "wait", "browser"].includes(action)
  ) {
    return "browser";
  }

  if (
    readNormalizedStringParam(params, "path") ||
    [
      "read",
      "write",
      "list",
      "delete",
      "move",
      "copy",
      "mkdir",
      "file",
    ].includes(action)
  ) {
    return "file";
  }

  if (
    command ||
    ["execute", "run", "shell", "terminal", "command"].includes(action)
  ) {
    return "terminal";
  }

  if (
    readNormalizedStringParam(params, "windowId") ||
    ["window", "focus", "resize", "move_window"].includes(action)
  ) {
    return "window";
  }

  return "desktop";
}

async function loadComputerUseActions(): Promise<LoadedComputerUseActions | null> {
  try {
    // Dynamic import so a missing peer dependency does not break plugin load.
    const mod = (await import(/* @vite-ignore */ COMPUTER_USE_PACKAGE)) as {
      default?: { actions?: readonly Action[] };
      computerUsePlugin?: { actions?: readonly Action[] };
    };
    const plugin = mod.computerUsePlugin ?? mod.default;
    if (!plugin?.actions?.length) {
      return null;
    }
    const byName = new Map(
      plugin.actions.map((action) => [action.name, action]),
    );
    return {
      desktop: byName.get(ACTION_NAMES.desktop) ?? null,
      browser: byName.get(ACTION_NAMES.browser) ?? null,
      window: byName.get(ACTION_NAMES.window) ?? null,
      file: byName.get(ACTION_NAMES.file) ?? null,
      terminal: byName.get(ACTION_NAMES.terminal) ?? null,
    };
  } catch (error) {
    if (!isMissingComputerUsePackageError(error)) {
      throw error;
    }
    return null;
  }
}

function isMissingComputerUsePackageError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") &&
    error.message.includes(COMPUTER_USE_PACKAGE)
  );
}

let cachedActions: LoadedComputerUseActions | null | undefined;

async function getLoadedActions(): Promise<LoadedComputerUseActions | null> {
  if (cachedActions === undefined) {
    cachedActions = await loadComputerUseActions();
  }
  return cachedActions;
}

const unavailableExamples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: { text: "Take a screenshot of my desktop" },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "The @elizaos/plugin-computeruse package is not installed. Install it and restart the agent to enable desktop automation.",
      },
    },
  ],
];
function stringifyInvalidDelegateResult(value: unknown): string {
  return typeof value === "string"
    ? value
    : JSON.stringify(value, (_key, nestedValue) =>
        typeof nestedValue === "bigint" ? String(nestedValue) : nestedValue,
      );
}

export const computerUseAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "USE_COMPUTER",
    "DESKTOP_AUTOMATION",
    "CONTROL_DESKTOP",
    "TAKE_SCREENSHOT",
    "OPEN_APP",
    "FINDER",
    "TERMINAL_COMMAND",
  ],
  tags: [
    "always-include",
    "finder",
    "desktop screenshot",
    "create folder",
    "portal upload",
    "upload deck",
    "speaker portal",
    "browser workflow",
    "form filling",
    "when i send the deck",
    "future upload policy",
  ],
  description:
    "Control the owner's full desktop / OS at the machine level via " +
    "@elizaos/plugin-computeruse. This is the ONLY action for OS-level desktop " +
    "operations: take a screenshot of the desktop / screen, click at " +
    "coordinates (x, y), drag, key press / keyboard combo, open a native " +
    "application, Finder operations, terminal commands, and window management. " +
    "Owner-only. Disabled when ELIZA_LIFEOPS_COMPUTER_USE_ENABLED=0.",
  descriptionCompressed:
    "control owner desktop OS via plugin-computeruse: desktop browser window file terminal surfaces; feature-gated",
  contexts: [...COMPUTER_USE_CONTEXTS],
  contextGate: { anyOf: [...COMPUTER_USE_CONTEXTS] },
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,

  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<boolean> => {
    if (!isComputerUseEnabled()) return false;
    if (!(await hasOwnerAccess(runtime, message))) return false;
    return hasSelectedContext(state) || hasComputerUseIntent(message, state);
  },

  parameters: [
    {
      name: "surface",
      description:
        "Computer-use surface to route to. Use browser, file, terminal, window, or desktop when the operation is ambiguous.",
      required: false,
      schema: {
        type: "string",
        enum: ["desktop", "browser", "window", "file", "terminal"],
      },
    },
    {
      name: "action",
      description:
        "Underlying computer-use action name, such as screenshot, navigate, read, execute, or focus.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "url",
      description: "Browser target URL.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "selector",
      description: "Browser selector for click/type/wait.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "path",
      description: "Filesystem path for file operations.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "command",
      description: "Terminal command for shell execution.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "windowId",
      description: "Window target for window-management operations.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "coordinate",
      description: "Desktop or browser coordinate [x, y].",
      required: false,
      schema: { type: "array", items: { type: "number" } },
    },
    {
      name: "text",
      description: "Text payload for typing, OCR, or browser waits.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "key",
      description: "Desktop key or key combo.",
      required: false,
      schema: { type: "string" },
    },
  ],

  examples: [
    ...unavailableExamples,
    [
      {
        name: "{{name1}}",
        content: {
          text: "When I send over the deck, upload it to the portal for me.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Once you send the deck, I'll handle the portal upload on your machine and keep it gated behind your delivery and approval.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Open Finder and create a new folder called Q2-Reports on my desktop.",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I'll handle that on your Mac with computer use.",
        },
      },
    ],
  ],

  handler: async (
    runtime,
    message,
    state,
    options,
    callback,
  ): Promise<ActionResult> => {
    if (!isComputerUseEnabled()) {
      return {
        text: "Computer use is disabled (ELIZA_LIFEOPS_COMPUTER_USE_ENABLED=0).",
        success: false,
        values: { success: false, error: "COMPUTER_USE_DISABLED" },
        data: { actionName: ACTION_NAME },
      };
    }
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner may drive computer use.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: ACTION_NAME },
      };
    }

    const actions = await getLoadedActions();
    if (!actions) {
      return {
        text: "The @elizaos/plugin-computeruse package is not installed. Install it and restart the agent to enable desktop automation.",
        success: false,
        values: { success: false, error: "COMPUTER_USE_NOT_INSTALLED" },
        data: { actionName: ACTION_NAME },
      };
    }
    const params = resolveWrapperParams(message, options);
    const surface = selectSurface(params);
    const base = actions[surface];
    if (!base) {
      return {
        text: `The ${surface} computer-use delegate is not available.`,
        success: false,
        values: {
          success: false,
          error: "COMPUTER_USE_DELEGATE_UNAVAILABLE",
          surface,
        },
        data: { actionName: ACTION_NAME, surface },
      };
    }

    if (typeof base.handler !== "function") {
      return {
        text: `Computer-use delegate ${base.name} does not expose a handler.`,
        success: false,
        values: {
          success: false,
          error: "COMPUTER_USE_HANDLER_MISSING",
          delegate: base.name,
        },
        data: { actionName: ACTION_NAME, delegate: base.name },
      };
    }

    const result = await base.handler(
      runtime,
      message,
      state,
      options,
      callback,
      [],
    );
    if (
      result &&
      typeof result === "object" &&
      typeof (result as { success?: unknown }).success === "boolean"
    ) {
      return result as ActionResult;
    }
    return {
      text: `Computer-use delegate ${base.name} returned an invalid action result.`,
      success: false,
      values: {
        success: false,
        error: "COMPUTER_USE_INVALID_RESULT",
        delegate: base.name,
      },
      data: {
        actionName: ACTION_NAME,
        delegate: base.name,
        raw: stringifyInvalidDelegateResult(result),
      },
    };
  },
};
