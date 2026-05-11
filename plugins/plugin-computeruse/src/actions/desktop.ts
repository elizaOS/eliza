/**
 * DESKTOP parent action — single canonical action that dispatches to the
 * underlying desktop ops (file, window, terminal). Built on the same
 * `action` discriminator pattern as BROWSER. Future ops (`screenshot`, `ocr`,
 * `detect_elements`) are reserved in the enum but not yet implemented here —
 * canonical screen capture / OCR / element detection live on the
 * COMPUTER_USE action and stay there until intentionally moved.
 */

import {
  type Action,
  type ActionResult,
  dispatchSubaction,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import type { ComputerUseService } from "../services/computer-use-service.js";
import type {
  FileActionParams,
  FileActionType,
  TerminalActionParams,
  TerminalActionType,
  WindowActionParams,
  WindowActionType,
} from "../types.js";
import type { DesktopOp } from "./desktop-handlers.js";
import {
  DESKTOP_OPS,
  handleFileOp,
  handleTerminalOp,
  handleWindowOp,
} from "./desktop-handlers.js";
import { resolveActionParams } from "./helpers.js";

/**
 * Resolved DESKTOP payload. Canonical `action` chooses the desktop operation
 * group; nested `operation` chooses the file/window/terminal verb. Legacy
 * callers may still send `subaction`/`op` for the group and `action` for the
 * nested verb.
 */
type DesktopParameters = Omit<
  Partial<FileActionParams>,
  "action"
> &
  Omit<Partial<WindowActionParams>, "action"> &
  Omit<Partial<TerminalActionParams>, "action"> & {
    action?: DesktopOp | FileActionType | WindowActionType | TerminalActionType;
    op?: DesktopOp;
    subaction?: DesktopOp;
    operation?: FileActionType | WindowActionType | TerminalActionType;
  };

function normalizeDesktopToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return normalized.length > 0 ? normalized : undefined;
}

function isDesktopOp(value: unknown): value is DesktopOp {
  return (
    typeof value === "string" &&
    (DESKTOP_OPS as readonly string[]).includes(value)
  );
}

function resolveDesktopOp(params: DesktopParameters): DesktopOp | undefined {
  const action = normalizeDesktopToken(params.action);
  if (isDesktopOp(action)) return action;
  const subaction = normalizeDesktopToken(params.subaction);
  if (isDesktopOp(subaction)) return subaction;
  const op = normalizeDesktopToken(params.op);
  if (isDesktopOp(op)) return op;
  return undefined;
}

function resolveDesktopOperation(
  params: DesktopParameters,
): FileActionType | WindowActionType | TerminalActionType | undefined {
  const operation = normalizeDesktopToken(params.operation);
  if (operation) {
    return operation as FileActionType | WindowActionType | TerminalActionType;
  }
  const legacyAction = normalizeDesktopToken(params.action);
  if (legacyAction && !isDesktopOp(legacyAction)) {
    return legacyAction as FileActionType | WindowActionType | TerminalActionType;
  }
  return undefined;
}

export const desktopAction: Action = {
  name: "DESKTOP",
  contexts: [
    "files",
    "terminal",
    "code",
    "browser",
    "screen_time",
    "automation",
  ],
  contextGate: {
    anyOf: [
      "files",
      "terminal",
      "code",
      "browser",
      "screen_time",
      "automation",
    ],
  },
  roleGate: { minRole: "USER" },
  similes: [
    // Old per-verb action names — preserved so older planner-side callers and
    // training data still resolve to DESKTOP.
    "FILE_ACTION",
    "MANAGE_WINDOW",
    "TERMINAL_ACTION",
    // Generic aliases.
    "DESKTOP",
    "USE_DESKTOP",
    "DESKTOP_ACTION",
  ],
  description:
    "Single DESKTOP action — dispatches local desktop operations through the computer-use service. " +
    "Supported actions: `file` (read/write/edit/append/delete/exists/list/delete_directory/upload/download/list_downloads), " +
    "`window` (list/focus/switch/arrange/move/minimize/maximize/restore/close), and " +
    "`terminal` (connect/execute/read/type/clear/close/execute_command). " +
    "Future actions `screenshot`, `ocr`, and `detect_elements` are reserved on the enum but currently live on COMPUTER_USE.",
  descriptionCompressed:
    "Single DESKTOP action; action=file|window|terminal dispatches to matching desktop operation (screenshot/ocr/detect_elements reserved).",
  parameters: [
    {
      name: "action",
      description:
        "Desktop operation group. Reserved future values: screenshot, ocr, detect_elements (currently on COMPUTER_USE).",
      required: true,
      schema: {
        type: "string",
        enum: [...DESKTOP_OPS, "screenshot", "ocr", "detect_elements"],
      },
    },
    {
      name: "operation",
      description:
        "Operation verb for the chosen action group (e.g. read/write for file, list/focus for window, execute for terminal).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "subaction",
      description: "Legacy alias for action.",
      required: false,
      schema: {
        type: "string",
        enum: [...DESKTOP_OPS, "screenshot", "ocr", "detect_elements"],
      },
    },
    // File params.
    {
      name: "path",
      description: "Primary file or directory path (file action).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "filepath",
      description: "Upstream alias for path (file action).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "dirpath",
      description: "Upstream alias for directory path (file action).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "content",
      description: "Content for write, append, or upload (file action).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "encoding",
      description: "Encoding for read/download (file action).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "oldText",
      description: "Replacement source text for edit (file action).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "newText",
      description: "Replacement destination text for edit (file action).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "old_text",
      description: "Upstream edit source text (file action).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "new_text",
      description: "Upstream edit destination text (file action).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "find",
      description: "Upstream alias for old_text (file action).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "replace",
      description: "Upstream alias for new_text (file action).",
      required: false,
      schema: { type: "string" },
    },
    // Window params.
    {
      name: "windowId",
      description: "Window identifier (window action).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "windowTitle",
      description: "Window title or app-name query (window action).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "arrangement",
      description:
        "Layout for window arrange: tile, cascade, vertical, or horizontal.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "x",
      description: "Target X coordinate for window move.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "y",
      description: "Target Y coordinate for window move.",
      required: false,
      schema: { type: "number" },
    },
    // Terminal params.
    {
      name: "command",
      description: "Shell command (terminal action execute / execute_command).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "cwd",
      description: "Working directory for terminal connect or execute.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "sessionId",
      description: "Terminal session ID alias.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "session_id",
      description: "Upstream terminal session ID alias.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "text",
      description: "Text for terminal type.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "timeout",
      description: "Timeout in seconds (terminal action).",
      required: false,
      schema: { type: "number", default: 30 },
    },
    {
      name: "timeoutSeconds",
      description: "Alias for timeout (terminal action).",
      required: false,
      schema: { type: "number", default: 30 },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service =
      (runtime.getService("computeruse") as ComputerUseService) ??
      null;
    if (!service) return false;
    const caps = service.getCapabilities();
    return (
      caps.fileSystem.available ||
      caps.windowList.available ||
      caps.terminal.available
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service =
      (runtime.getService("computeruse") as ComputerUseService) ??
      null;
    if (!service) {
      return { success: false, error: "ComputerUseService not available" };
    }

    const params = resolveActionParams<DesktopParameters>(message, options);
    const op = resolveDesktopOp(params);
    const handlerParams = {
      ...params,
      action: resolveDesktopOperation(params),
    };

    return dispatchSubaction(
      op,
      {
        file: () =>
          handleFileOp(service, handlerParams as FileActionParams, callback),
        window: () =>
          handleWindowOp(service, handlerParams as WindowActionParams, callback),
        terminal: () =>
          handleTerminalOp(
            service,
            handlerParams as TerminalActionParams,
            callback,
          ),
      },
      undefined,
    );
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Read the file /tmp/notes.md.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Reading the file.",
          actions: ["DESKTOP"],
          thought:
            "Local filesystem read maps to DESKTOP action=file with operation=read; the computer-use service handles the path.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "List the open windows on my desktop.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Listing windows.",
          actions: ["DESKTOP"],
          thought:
            "Window inventory routes to DESKTOP action=window with operation=list.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Run `git status` in the repo terminal session.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Running the command.",
          actions: ["DESKTOP"],
          thought:
            "Shell execution belongs on DESKTOP action=terminal with operation=execute and command='git status'.",
        },
      },
    ],
  ],
};
