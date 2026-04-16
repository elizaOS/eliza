import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { DesktopActionParams } from "../types.js";
import type { ComputerUseService } from "../services/computer-use-service.js";
import {
  buildScreenshotAttachment,
  resolveActionParams,
} from "./helpers.js";

export const useComputerAction: Action = {
  name: "USE_COMPUTER",
  similes: [
    "CONTROL_COMPUTER",
    "COMPUTER_ACTION",
    "DESKTOP_ACTION",
    "CLICK",
    "CLICK_SCREEN",
    "TYPE_TEXT",
    "PRESS_KEY",
    "KEY_COMBO",
    "SCROLL_SCREEN",
    "MOVE_MOUSE",
    "DRAG",
    "MOUSE_CLICK",
  ],
  description:
    "Control the local desktop. This action can inspect the current screen, move the mouse, click, drag, type, press keys, scroll, and perform modified clicks. It is intended for real application interaction when the agent needs to operate the user's computer directly.\n\n" +
    "Available actions:\n" +
    "- screenshot: capture the current screen.\n" +
    "- click: left click at coordinate.\n" +
    "- click_with_modifiers: click while holding modifier keys such as shift/cmd/ctrl.\n" +
    "- double_click: double click at coordinate.\n" +
    "- right_click: right click at coordinate.\n" +
    "- mouse_move: move the cursor to coordinate.\n" +
    "- type: type text into the focused application.\n" +
    "- key: press a single key.\n" +
    "- key_combo: press a key combination like ctrl+c or cmd+shift+s.\n" +
    "- scroll: scroll at a coordinate in a direction.\n" +
    "- drag: drag from startCoordinate to coordinate.\n" +
    "- detect_elements / ocr: parity stubs preserved from upstream; they return an explicit local-runtime not-available error.\n\n" +
    "Why this exists: it lets the agent operate arbitrary desktop software, not just browser pages or the terminal. Start with a screenshot when visual context is needed, then act using exact coordinates and follow-up screenshots.",
  parameters: [
    {
      name: "action",
      description: "Desktop action to perform.",
      required: true,
      schema: {
        type: "string",
        enum: [
          "screenshot",
          "click",
          "click_with_modifiers",
          "double_click",
          "right_click",
          "mouse_move",
          "type",
          "key",
          "key_combo",
          "scroll",
          "drag",
          "detect_elements",
          "ocr",
        ],
      },
    },
    {
      name: "coordinate",
      description: "Target [x, y] pixel coordinate.",
      required: false,
      schema: { type: "array", items: { type: "number" } },
    },
    {
      name: "startCoordinate",
      description: "Start [x, y] pixel coordinate for drag.",
      required: false,
      schema: { type: "array", items: { type: "number" } },
    },
    {
      name: "text",
      description: "Text to type.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "key",
      description: "Single key or combo string depending on action.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "modifiers",
      description: "Modifier keys for click_with_modifiers.",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
    {
      name: "button",
      description: "Mouse button for click_with_modifiers.",
      required: false,
      schema: { type: "string", enum: ["left", "middle", "right"] },
    },
    {
      name: "clicks",
      description: "Number of clicks for click_with_modifiers.",
      required: false,
      schema: { type: "number", minimum: 1, maximum: 5 },
    },
    {
      name: "scrollDirection",
      description: "Scroll direction.",
      required: false,
      schema: { type: "string", enum: ["up", "down", "left", "right"] },
    },
    {
      name: "scrollAmount",
      description: "Scroll tick count.",
      required: false,
      schema: { type: "number", minimum: 1, maximum: 100, default: 3 },
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
    return !!service;
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

    const params = resolveActionParams<DesktopActionParams>(message, options);
    params.action ??= "screenshot";

    const result = await service.executeDesktopAction(params);

    if (callback) {
      await callback({
        text: result.success
          ? params.action === "screenshot"
            ? "Here is the current screen."
            : result.message ?? `Completed ${params.action}.`
          : `Desktop action failed: ${result.error}`,
        ...(result.screenshot
          ? {
              attachments: [
                buildScreenshotAttachment({
                  idPrefix: "computeruse-screenshot",
                  screenshot: result.screenshot,
                  title: "Screenshot",
                  description:
                    params.action === "screenshot"
                      ? "Current screen capture"
                      : `Screen capture after ${params.action}`,
                }),
              ],
            }
          : {}),
      });
    }

    return result as unknown as any;
  },
};
