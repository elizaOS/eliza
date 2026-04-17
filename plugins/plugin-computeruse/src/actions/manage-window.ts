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
import { resolveActionParams } from "./helpers.js";

export const manageWindowAction: Action = {
  name: "MANAGE_WINDOW",
  similes: [
    "LIST_WINDOWS",
    "FOCUS_WINDOW",
    "SWITCH_WINDOW",
    "MINIMIZE_WINDOW",
    "MAXIMIZE_WINDOW",
    "CLOSE_WINDOW",
    "WINDOW_MANAGEMENT",
  ],
  description:
    "Manage desktop windows through the local runtime. This includes listing visible windows, focusing or switching windows, minimizing, maximizing, restoring, closing, and parity no-op arrange/move commands.\n\n" +
    "Why this exists: it lets the agent coordinate multiple local apps while staying inside the same approval and capability model as the rest of computer use.",
  descriptionCompressed: "Desktop window mgmt: list, focus, minimize, maximize, close.",
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
      description: "Window title alias.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "window",
      description: "Upstream alias for window target.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "title",
      description: "Upstream alias for window target.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "arrangement",
      description: "Arrangement name for arrange.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "x",
      description: "Target x position for move.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "y",
      description: "Target y position for move.",
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
  ) => {
    const service =
      (runtime.getService("computeruse") as unknown as ComputerUseService) ??
      null;
    if (!service) {
      return { success: false, error: "ComputerUseService not available" };
    }

    const params = resolveActionParams<WindowActionParams>(message, options);
    params.action ??= "list";

    const result = await service.executeWindowAction(params);

    if (callback) {
      await callback({
        text: result.windows
          ? result.windows.length > 0
            ? `Open windows:\n${result.windows
                .map((window) => `[${window.id}] ${window.app} — ${window.title}`)
                .join("\n")}`
            : "No visible windows found."
          : result.success
            ? result.message ?? `Completed window action ${params.action}.`
            : `Window action failed: ${result.error}`,
      });
    }

    return result as unknown as any;
  },
};
