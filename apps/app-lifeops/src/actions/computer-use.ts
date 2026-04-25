/**
 * LifeOps computer-use action.
 *
 * Thin wrapper over @elizaos/plugin-computeruse's useComputerAction with
 * LifeOps-specific access control (owner-only) and an opt-out feature flag
 * (ELIZA_LIFEOPS_COMPUTER_USE_ENABLED=0). If the plugin package is not
 * installed in the workspace, exports an unavailable action that returns a clear
 * "not installed" result instead of crashing the plugin load.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { hasOwnerAccess } from "@elizaos/agent";

const ACTION_NAME = "LIFEOPS_COMPUTER_USE";
const ACTION_NAMES = {
  desktop: "USE_COMPUTER",
  browser: "BROWSER_ACTION",
  window: "MANAGE_WINDOW",
  file: "FILE_ACTION",
  terminal: "TERMINAL_ACTION",
} as const;

type ComputerUseSurface = keyof typeof ACTION_NAMES;

interface LoadedComputerUseActions {
  desktop: Action | null;
  browser: Action | null;
  window: Action | null;
  file: Action | null;
  terminal: Action | null;
}

const DESKTOP_COMMAND_ALIASES = new Set([
  "finder",
  "open_finder",
  "create_folder",
  "new_folder",
  "desktop_screenshot",
  "take_screenshot",
  "capture_screen",
  "screenshot",
]);

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

function inferSurface(params: Record<string, unknown>): ComputerUseSurface {
  const explicitSurface =
    typeof params.surface === "string"
      ? params.surface.trim().toLowerCase()
      : null;
  if (
    explicitSurface === "desktop" ||
    explicitSurface === "browser" ||
    explicitSurface === "window" ||
    explicitSurface === "file" ||
    explicitSurface === "terminal"
  ) {
    return explicitSurface;
  }

  const action =
    typeof params.action === "string" ? params.action.trim().toLowerCase() : "";
  const command =
    typeof params.command === "string"
      ? params.command.trim().toLowerCase()
      : "";

  if (DESKTOP_COMMAND_ALIASES.has(action) || DESKTOP_COMMAND_ALIASES.has(command)) {
    return "desktop";
  }

  if (
    params.path !== undefined ||
    params.filepath !== undefined ||
    params.dirpath !== undefined ||
    params.oldText !== undefined ||
    params.newText !== undefined ||
    params.old_text !== undefined ||
    params.new_text !== undefined ||
    params.find !== undefined ||
    params.replace !== undefined ||
    action === "write" ||
    action === "append" ||
    action === "delete" ||
    action === "exists" ||
    action === "list" ||
    action === "delete_directory" ||
    action === "upload" ||
    action === "download" ||
    action === "list_downloads"
  ) {
    return "file";
  }

  if (
    params.command !== undefined ||
    params.sessionId !== undefined ||
    params.session_id !== undefined ||
    action === "execute" ||
    action === "execute_command" ||
    action === "read" ||
    action === "clear"
  ) {
    return "terminal";
  }

  if (
    params.windowId !== undefined ||
    params.windowTitle !== undefined ||
    params.window !== undefined ||
    params.title !== undefined ||
    params.arrangement !== undefined ||
    action === "focus" ||
    action === "switch" ||
    action === "arrange" ||
    action === "move" ||
    action === "minimize" ||
    action === "maximize" ||
    action === "restore" ||
    action === "close"
  ) {
    return "window";
  }

  if (
    params.url !== undefined ||
    params.selector !== undefined ||
    params.tabId !== undefined ||
    params.tab_index !== undefined ||
    params.index !== undefined ||
    params.code !== undefined ||
    params.timeout !== undefined ||
    params.direction !== undefined ||
    action === "open" ||
    action === "connect" ||
    action === "navigate" ||
    action === "dom" ||
    action === "get_dom" ||
    action === "clickables" ||
    action === "get_clickables" ||
    action === "execute" ||
    action === "state" ||
    action === "info" ||
    action === "context" ||
    action === "wait" ||
    action === "list_tabs" ||
    action === "open_tab" ||
    action === "close_tab" ||
    action === "switch_tab"
  ) {
    return "browser";
  }

  return "desktop";
}

async function loadComputerUseActions(): Promise<LoadedComputerUseActions | null> {
  try {
    // Dynamic import so a missing peer dependency does not break plugin load.
    const mod = (await import(
      /* @vite-ignore */ "@elizaos/plugin-computeruse" as unknown as string
    )) as {
      default?: { actions?: readonly Action[] };
      computerUsePlugin?: { actions?: readonly Action[] };
    };
    const plugin = mod.computerUsePlugin ?? mod.default;
    if (!plugin?.actions?.length) {
      return null;
    }
    const byName = new Map(plugin.actions.map((action) => [action.name, action]));
    return {
      desktop: byName.get(ACTION_NAMES.desktop) ?? null,
      browser: byName.get(ACTION_NAMES.browser) ?? null,
      window: byName.get(ACTION_NAMES.window) ?? null,
      file: byName.get(ACTION_NAMES.file) ?? null,
      terminal: byName.get(ACTION_NAMES.terminal) ?? null,
    };
  } catch {
    return null;
  }
}

let cachedActions: LoadedComputerUseActions | null | undefined;

async function getLoadedActions(): Promise<LoadedComputerUseActions | null> {
  if (cachedActions === undefined) {
    cachedActions = await loadComputerUseActions();
  }
  return cachedActions;
}

function selectDelegateAction(
  actions: LoadedComputerUseActions,
  message: Memory,
  options?: HandlerOptions,
): Action | null {
  const params = resolveWrapperParams(message, options);
  const preferredSurface = inferSurface(params);
  return (
    actions[preferredSurface] ??
    actions.desktop ??
    actions.browser ??
    actions.window ??
    actions.file ??
    actions.terminal ??
    null
  );
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

export const lifeOpsComputerUseAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: [
    "USE_COMPUTER",
    "DESKTOP_AUTOMATION",
    "COMPUTER_USE",
    "CONTROL_DESKTOP",
    "FINDER",
    "OPEN_FINDER",
    "CREATE_FOLDER",
    "NEW_FOLDER",
    "TAKE_SCREENSHOT",
    "CAPTURE_SCREEN",
    "PORTAL_UPLOAD",
    "UPLOAD_DECK",
    "REQUEST_UPLOAD",
    "UPLOAD_TO_PORTAL",
    "PORTAL_ASSET_UPLOAD",
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
    "Control the owner's desktop (screenshots, mouse, keyboard, browser, " +
    "windows, files, terminal) via @elizaos/plugin-computeruse. Use this for " +
    "portal uploads, Finder/Desktop tasks like creating folders or taking " +
    "screenshots, browser form-filling, and other on-machine workflows the " +
    "assistant should perform directly, including standing instructions like " +
    "'when I send the file, upload it to the portal for me.' Select this action " +
    "even before the file arrives when the user is delegating that future upload " +
    "workflow; the action can hold the task and ask for portal/file details later. " +
    "Do not use this merely to ask the owner for a missing document or updated ID copy; if the workflow is blocked waiting on the owner to send an artifact, use an intervention or inbox action unless the assistant is actually operating a browser, portal, or file surface. Owner-only. " +
    "Disabled when ELIZA_LIFEOPS_COMPUTER_USE_ENABLED=0.",
  suppressPostActionContinuation: true,

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (!isComputerUseEnabled()) return false;
    if (!(await hasOwnerAccess(runtime, message))) return false;
    const actions = await getLoadedActions();
    const base = actions
      ? selectDelegateAction(actions, message)
      : null;
    if (!base?.validate) return true;
    return base.validate(runtime, message, undefined);
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

  handler: async (runtime, message, state, options, callback): Promise<ActionResult> => {
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
    const base = actions
      ? selectDelegateAction(actions, message, options)
      : null;
    if (!base) {
      return {
        text: "The @elizaos/plugin-computeruse package is not installed. Install it and restart the agent to enable desktop automation.",
        success: false,
        values: { success: false, error: "COMPUTER_USE_NOT_INSTALLED" },
        data: { actionName: ACTION_NAME },
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

    const result = await base.handler(runtime, message, state, options, callback, []);
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
      data: { actionName: ACTION_NAME, delegate: base.name, raw: result },
    };
  },
};
