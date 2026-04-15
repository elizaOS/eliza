/**
 * MANAGE_WINDOW action — list, focus, switch, arrange, move, minimize, maximize, restore, and close windows.
 *
 * Provides window management capabilities across macOS, Linux, and Windows.
 */

import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { WindowActionParams } from "../types.js";
import type { ComputerUseService } from "../services/computer-use-service.js";

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
      description: "Window management action to perform",
      required: true,
      schema: {
        type: "string",
        enum: ["list", "focus", "switch", "arrange", "move", "minimize", "maximize", "restore", "close"],
      },
    },
    {
      name: "windowId",
      description: "Window identifier (from list action). Required for focus, minimize, maximize, close.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "windowTitle",
      description: "Window title or app-name query for switch/restore/focus operations.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "arrangement",
      description: "Layout hint for the arrange action. Upstream exposes this as a stub.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "x",
      description: "Target X coordinate for move. Upstream exposes this as a stub.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "y",
      description: "Target Y coordinate for move. Upstream exposes this as a stub.",
      required: false,
      schema: { type: "number" },
    },
  ],

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "What windows are open?" },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll list the open windows.", action: "MANAGE_WINDOW" },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Bring the Chrome window to the front." },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll focus the Chrome window.", action: "MANAGE_WINDOW" },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    const service = runtime.getService("computeruse") as unknown as ComputerUseService | undefined;
    return !!service;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ) => {
    const service = runtime.getService("computeruse") as unknown as ComputerUseService | undefined;
    if (!service) {
      return { success: false, error: "ComputerUseService not available" };
    }

    const params = ((options as Record<string, unknown>)?.parameters ?? {}) as WindowActionParams;

    if (!params.action && message.content && typeof message.content === "object") {
      const content = message.content as Record<string, unknown>;
      if (content.action) {
        Object.assign(params, content);
      }
    }

    if (!params.action) {
      params.action = "list";
    }

    const result = await service.executeWindowAction(params);

    if (callback) {
      if (result.windows) {
        const windowText = result.windows.length > 0
          ? result.windows.map((w) => `[${w.id}] ${w.app} — ${w.title}`).join("\n")
          : "No visible windows found.";
        await callback({ text: `Open windows:\n${windowText}` });
      } else {
        await callback({
          text: result.success
            ? result.message ?? `Window ${params.action} completed.`
            : result.approvalRequired
              ? `Window action is waiting for approval (${result.approvalId}).`
              : `Window action failed: ${result.error}`,
        });
      }
    }

    return { success: result.success };
  },
};
