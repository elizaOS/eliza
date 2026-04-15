/**
 * USE_COMPUTER action — desktop mouse/keyboard/scroll/drag + screenshot.
 *
 * This is the primary action for controlling the user's desktop. It supports
 * clicking, typing, key presses, key combos, scrolling, dragging, mouse
 * movement, and taking screenshots.
 *
 * After every mutation action (click, type, etc.), a screenshot is
 * automatically captured and returned so the agent can see the result.
 */

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
    "Control the computer desktop by performing mouse and keyboard actions, or capture a screenshot of the current screen. " +
    "Use this to interact with any application visible on the user's desktop.\n\n" +
    "Available actions:\n" +
    "- screenshot: Capture the current screen state. No parameters needed.\n" +
    "- click: Left-click at pixel coordinates. Requires coordinate: [x, y].\n" +
    "- double_click: Double-click at coordinates. Requires coordinate: [x, y].\n" +
    "- right_click: Right-click at coordinates. Requires coordinate: [x, y].\n" +
    "- mouse_move: Move cursor without clicking. Requires coordinate: [x, y].\n" +
    "- type: Type text at the current cursor position. Requires text.\n" +
    "- key: Press a single key (e.g. Return, Tab, Escape, F5). Requires key.\n" +
    "- key_combo: Press a key combination (e.g. ctrl+c, cmd+shift+s, alt+F4). Requires key.\n" +
    "- scroll: Scroll at a position. Requires coordinate, scrollDirection (up/down/left/right), optional scrollAmount.\n" +
    "- drag: Drag from one point to another. Requires startCoordinate and coordinate.\n\n" +
    "Always take a screenshot first to see the current screen state before performing actions. " +
    "After each action, a screenshot is automatically returned showing the result.",

  parameters: [
    {
      name: "action",
      description: "The desktop action to perform",
      required: true,
      schema: {
        type: "string",
        enum: [
          "screenshot", "click", "double_click", "right_click",
          "mouse_move", "type", "key", "key_combo", "scroll", "drag",
        ],
      },
    },
    {
      name: "coordinate",
      description: "Target [x, y] pixel coordinates on screen. Required for click, double_click, right_click, mouse_move, scroll, drag (end point).",
      required: false,
      schema: { type: "array", items: { type: "number" } },
    },
    {
      name: "startCoordinate",
      description: "Start [x, y] coordinates for drag action.",
      required: false,
      schema: { type: "array", items: { type: "number" } },
    },
    {
      name: "text",
      description: "Text to type. Required for 'type' action.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "key",
      description: "Key name (e.g. Return, Tab, Escape) for 'key' action, or combo string (e.g. ctrl+c, cmd+shift+s) for 'key_combo' action.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "scrollDirection",
      description: "Direction to scroll: up, down, left, right. Default: down.",
      required: false,
      schema: { type: "string", enum: ["up", "down", "left", "right"] },
    },
    {
      name: "scrollAmount",
      description: "Number of scroll ticks (1-100). Default: 3.",
      required: false,
      schema: { type: "number", minimum: 1, maximum: 100, default: 3 },
    },
  ],

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Take a screenshot so I can see what's on screen." },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll capture the current screen.", action: "USE_COMPUTER" },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Click on the search bar at the top of the screen." },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll click on the search bar.", action: "USE_COMPUTER" },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Type 'hello world' into the text field." },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll type that text.", action: "USE_COMPUTER" },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Press Ctrl+S to save the file." },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll press Ctrl+S to save.", action: "USE_COMPUTER" },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Scroll down on this page." },
      },
      {
        name: "{{agentName}}",
        content: { text: "I'll scroll down.", action: "USE_COMPUTER" },
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

    // Extract params from handler options
    const params = ((options as Record<string, unknown>)?.parameters ?? {}) as DesktopActionParams;

    // Fallback: try to extract from message content
    if (!params.action && message.content && typeof message.content === "object") {
      const content = message.content as Record<string, unknown>;
      if (content.action) {
        Object.assign(params, content);
      }
    }

    if (!params.action) {
      // Default to screenshot if no action specified
      params.action = "screenshot";
    }

    const result = await service.executeDesktopAction(params);

    if (callback) {
      const text = result.success
        ? params.action === "screenshot"
          ? "Here is the current screen."
          : `Action "${params.action}" completed successfully.`
        : `Action failed: ${result.error}`;

      await callback({
        text,
        ...(result.screenshot
          ? {
              attachments: [
                {
                  id: `screenshot-${Date.now()}`,
                  url: `data:image/png;base64,${result.screenshot}`,
                  title: "Screenshot",
                  source: "computeruse",
                  description: `Screen capture after ${params.action}`,
                  contentType: "image" as const,
                },
              ],
            }
          : {}),
      });
    }

    return { success: result.success, data: { screenshot: !!result.screenshot } };
  },
};
