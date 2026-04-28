/**
 * MANAGE_WINDOW action — list, focus, switch, arrange, move, minimize, maximize, restore, and close windows.
 *
 * Provides window management capabilities across macOS, Linux, and Windows.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ComputerUseService } from "../services/computer-use-service.js";
import type { WindowActionParams, WindowActionResult } from "../types.js";
import {
  resolveActionParams,
  toComputerUseActionResult,
} from "./helpers.js";

function formatWindowResultText(
  params: WindowActionParams,
  result: WindowActionResult,
): string {
  if (result.windows) {
    const windowText =
      result.windows.length > 0
        ? result.windows.map((w) => `[${w.id}] ${w.app} - ${w.title}`).join("\n")
        : "No visible windows found.";
    return `Open windows:\n${windowText}`;
  }

  return result.success
    ? (result.message ?? `Window ${params.action} completed.`)
    : result.approvalRequired
      ? `Window action is waiting for approval (${result.approvalId}).`
      : `Window action failed: ${result.error}`;
}

export const manageWindowAction: Action = {
  name: "MANAGE_WINDOW",
  similes: [
    "LIST_WINDOWS",
    "FOCUS_WINDOW",
    "SWITCH_WINDOW",
    "ARRANGE_WINDOWS",
    "MOVE_WINDOW",
    "MINIMIZE_WINDOW",
    "MAXIMIZE_WINDOW",
    "CLOSE_WINDOW",
    "WINDOW_MANAGEMENT",
  ],
  description:
    "Manage desktop windows — list all visible windows, bring a window to the front, " +
    "arrange or move windows, minimize, maximize, restore, or close a window.\n\n" +
    "Available actions:\n" +
    "- list: List all visible windows with their IDs, titles, and app names.\n" +
    "- focus: Bring a window to the front. Requires windowId.\n" +
    "- switch: Switch to a window by ID, title, or app name.\n" +
    "- arrange: Expose the upstream arrange_windows stub for layout workflows.\n" +
    "- move: Expose the upstream move_window stub for positional workflows.\n" +
    "- minimize: Minimize a window. Requires windowId.\n" +
    "- maximize: Maximize a window. Requires windowId.\n" +
    "- restore: Restore a minimized or maximized window.\n" +
    "- close: Close a window. Requires windowId.\n\n" +
    "Use 'list' first to discover window IDs, then use other actions to manage them.",

  parameters: [
    {
      name: "action",
      description: "Window action to perform.",
      required: true,
      schema: {
        type: "string",
        enum: [
          "list",
          "focus",
          "switch",
          "arrange",
          "move",
          "minimize",
          "maximize",
          "restore",
          "close",
        ],
      },
    },
    {
      name: "windowId",
      description: "Window identifier.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "windowTitle",
      description:
        "Window title or app-name query for switch/restore/focus operations.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "arrangement",
      description:
        "Layout hint for the arrange action. Upstream exposes this as a stub.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "x",
      description:
        "Target X coordinate for move. Upstream exposes this as a stub.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "y",
      description:
        "Target Y coordinate for move. Upstream exposes this as a stub.",
      required: false,
      schema: { type: "number" },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service =
      (runtime.getService("computeruse") as unknown as ComputerUseService) ??
      null;
    return !!service && service.getCapabilities().windowList.available;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service =
      (runtime.getService("computeruse") as unknown as ComputerUseService) ??
      null;
    if (!service) {
      return { success: false, error: "ComputerUseService not available" };
    }

    const params = resolveActionParams<WindowActionParams>(message, options);
    params.action ??= "list";

    const result = await service.executeWindowAction(params);
    const text = formatWindowResultText(params, result);

    if (callback) {
      await callback({ text });
    }

    return toComputerUseActionResult({
      action: params.action,
      result,
      text,
      suppressClipboard: true,
    });
  },
};
