/**
 * WINDOW parent action — manages local desktop windows (list / focus /
 * switch / arrange / move / minimize / maximize / restore / close).
 *
 * Pointer and keyboard primitives live on COMPUTER_USE. File and shell
 * operations live on the FILE and SHELL actions in their own plugins —
 * this plugin no longer exposes them.
 */

import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import type { ComputerUseService } from "../services/computer-use-service.js";
import type { WindowActionParams, WindowActionType } from "../types.js";
import { handleWindowOp } from "./window-handlers.js";
import { resolveActionParams } from "./helpers.js";

const WINDOW_ACTIONS = [
  "list",
  "focus",
  "switch",
  "arrange",
  "move",
  "minimize",
  "maximize",
  "restore",
  "close",
] as const satisfies readonly WindowActionType[];

/**
 * Resolved WINDOW payload. Canonical `action` chooses the verb; legacy
 * callers may still send `subaction` or `op`.
 */
type WindowParameters = Omit<Partial<WindowActionParams>, "action"> & {
  action?: WindowActionType;
  subaction?: WindowActionType;
  op?: WindowActionType;
};

function normalizeWindowToken(value: unknown): WindowActionType | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((WINDOW_ACTIONS as readonly string[]).includes(normalized)) {
    return normalized as WindowActionType;
  }
  return undefined;
}

function resolveWindowAction(
  params: WindowParameters,
): WindowActionType | undefined {
  return (
    normalizeWindowToken(params.action) ??
    normalizeWindowToken(params.subaction) ??
    normalizeWindowToken(params.op)
  );
}

export const windowAction: Action = {
  name: "WINDOW",
  contexts: ["screen_time", "automation"],
  contextGate: {
    anyOf: ["screen_time", "automation"],
  },
  roleGate: { minRole: "USER" },
  similes: [
    // Old per-verb name — preserved so older planner callers and training
    // data still resolve to WINDOW.
    "MANAGE_WINDOW",
    // Generic aliases.
    "WINDOW",
    "USE_WINDOW",
    "WINDOW_ACTION",
  ],
  description:
    "Single WINDOW action — manages local desktop windows through the computer-use service. " +
    "Supported actions: list, focus, switch, arrange, move, minimize, maximize, restore, close. " +
    "Pointer and keyboard primitives belong on COMPUTER_USE; file and shell operations belong on FILE and SHELL.",
  descriptionCompressed:
    "Single WINDOW action; action=list|focus|switch|arrange|move|minimize|maximize|restore|close manages local desktop windows.",
  parameters: [
    {
      name: "action",
      description: "Window operation verb.",
      required: true,
      schema: {
        type: "string",
        enum: [...WINDOW_ACTIONS],
      },
    },
    {
      name: "subaction",
      description: "Legacy alias for action.",
      required: false,
      schema: {
        type: "string",
        enum: [...WINDOW_ACTIONS],
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
      description: "Window title or app-name query.",
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
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service =
      (runtime.getService("computeruse") as ComputerUseService) ?? null;
    if (!service) return false;
    return service.getCapabilities().windowList.available;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service =
      (runtime.getService("computeruse") as ComputerUseService) ?? null;
    if (!service) {
      return { success: false, error: "ComputerUseService not available" };
    }

    const params = resolveActionParams<WindowParameters>(message, options);
    const action = resolveWindowAction(params) ?? "list";

    return handleWindowOp(
      service,
      { ...params, action } as WindowActionParams,
      callback,
    );
  },

  examples: [
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
          actions: ["WINDOW"],
          thought:
            "Window inventory routes to WINDOW action=list.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Bring the Slack window to the front.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Focusing Slack.",
          actions: ["WINDOW"],
          thought:
            "Activating a window by app name routes to WINDOW action=focus with windowTitle='Slack'.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Tile all my open windows.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Tiling the windows.",
          actions: ["WINDOW"],
          thought:
            "Arrangement requests route to WINDOW action=arrange with the chosen arrangement.",
        },
      },
    ],
  ],
};
