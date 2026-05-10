/**
 * DESKTOP parent action — single canonical action that dispatches to the
 * underlying desktop ops (file, window, terminal). Built on the same
 * `op`/`subaction` pattern as BROWSER. Future ops (`screenshot`, `ocr`,
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
  readSubaction,
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
 * Resolved DESKTOP payload. `action` semantics depend on the chosen `op` (file /
 * window / terminal); dispatch narrows before calling per-op handlers.
 */
type DesktopParameters = Omit<
  Partial<FileActionParams>,
  "action"
> &
  Omit<Partial<WindowActionParams>, "action"> &
  Omit<Partial<TerminalActionParams>, "action"> & {
    op?: DesktopOp;
    subaction?: DesktopOp;
    action?:
      | FileActionType
      | WindowActionType
      | TerminalActionType;
  };

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
    "Supported ops: `file` (read/write/edit/append/delete/exists/list/delete_directory/upload/download/list_downloads), " +
    "`window` (list/focus/switch/arrange/move/minimize/maximize/restore/close), and " +
    "`terminal` (connect/execute/read/type/clear/close/execute_command). " +
    "Future ops `screenshot`, `ocr`, and `detect_elements` are reserved on the enum but currently live on COMPUTER_USE.",
  descriptionCompressed:
    "Single DESKTOP action; op=file|window|terminal dispatches to the matching computer-use op (screenshot/ocr/detect_elements reserved).",
  parameters: [
    {
      name: "subaction",
      description:
        "Desktop operation group. Reserved future values: screenshot, ocr, detect_elements (currently on COMPUTER_USE).",
      required: true,
      schema: {
        type: "string",
        enum: [...DESKTOP_OPS, "screenshot", "ocr", "detect_elements"],
      },
    },
    {
      name: "action",
      description:
        "Sub-op verb for the chosen op (e.g. read/write for file, list/focus for window, execute for terminal).",
      required: false,
      schema: { type: "string" },
    },
    // File params.
    {
      name: "path",
      description: "Primary file or directory path (file op).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "filepath",
      description: "Upstream alias for path (file op).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "dirpath",
      description: "Upstream alias for directory path (file op).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "content",
      description: "Content for write, append, or upload (file op).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "encoding",
      description: "Encoding for read/download (file op).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "oldText",
      description: "Replacement source text for edit (file op).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "newText",
      description: "Replacement destination text for edit (file op).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "old_text",
      description: "Upstream edit source text (file op).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "new_text",
      description: "Upstream edit destination text (file op).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "find",
      description: "Upstream alias for old_text (file op).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "replace",
      description: "Upstream alias for new_text (file op).",
      required: false,
      schema: { type: "string" },
    },
    // Window params.
    {
      name: "windowId",
      description: "Window identifier (window op).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "windowTitle",
      description: "Window title or app-name query (window op).",
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
      description: "Shell command (terminal op execute / execute_command).",
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
      description: "Timeout in seconds (terminal op).",
      required: false,
      schema: { type: "number", default: 30 },
    },
    {
      name: "timeoutSeconds",
      description: "Alias for timeout (terminal op).",
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
    const op = readSubaction<DesktopOp>(
      params as Record<string, unknown>,
      {
        allowed: DESKTOP_OPS,
        keys: ["op", "subaction"],
      },
    );

    return dispatchSubaction(
      op,
      {
        file: () => handleFileOp(service, params as FileActionParams, callback),
        window: () =>
          handleWindowOp(service, params as WindowActionParams, callback),
        terminal: () =>
          handleTerminalOp(service, params as TerminalActionParams, callback),
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
            "Local filesystem read maps to DESKTOP subaction=file with action=read; the computer-use service handles the path.",
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
            "Window inventory routes to DESKTOP subaction=window with action=list.",
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
            "Shell execution belongs on DESKTOP subaction=terminal with action=execute and command='git status'.",
        },
      },
    ],
  ],
};
