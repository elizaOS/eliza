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
import type { ComputerActionResult, DesktopActionParams } from "../types.js";
import {
  buildScreenshotAttachment,
  resolveActionParams,
  toComputerUseActionResult,
} from "./helpers.js";

function getComputerUseService(
  runtime: IAgentRuntime,
): ComputerUseService | null {
  return (runtime.getService("computeruse") as ComputerUseService) ?? null;
}

function formatDesktopResultText(
  params: DesktopActionParams,
  result: ComputerActionResult,
): string {
  if (!result.success) {
    if (result.permissionDenied) {
      return `Desktop action failed because ${result.permissionType} permission is missing.`;
    }
    if (result.approvalRequired) {
      return `Desktop action "${params.action}" is waiting for approval (${result.approvalId}).`;
    }
    return `Desktop action failed: ${result.error}`;
  }

  if (params.action === "screenshot") {
    return result.message ?? "Here is the current screen.";
  }
  return result.message ?? `Completed ${params.action}.`;
}

async function deliverResult(
  params: DesktopActionParams,
  result: ComputerActionResult,
  text: string,
  callback?: HandlerCallback,
): Promise<void> {
  if (!callback) return;
  await callback({
    text,
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

export const useComputerAction: Action = {
  name: "COMPUTER_USE",
  contexts: [
    "browser",
    "files",
    "terminal",
    "screen_time",
    "automation",
    "admin",
  ],
  contextGate: {
    anyOf: [
      "browser",
      "files",
      "terminal",
      "screen_time",
      "automation",
      "admin",
    ],
  },
  roleGate: { minRole: "OWNER" },
  similes: [
    "USE_COMPUTER",
    "CONTROL_COMPUTER",
    "COMPUTER_ACTION",
    "DESKTOP_ACTION",
    "CLICK",
    "CLICK_SCREEN",
    "TYPE_TEXT",
    "PRESS_KEY",
    "KEY_COMBO",
    "KEY_DOWN",
    "KEY_UP",
    "SCROLL_SCREEN",
    "MOVE_MOUSE",
    "DRAG",
    "DRAG_TO",
    "MOUSE_CLICK",
    "MOUSE_DOWN",
    "MOUSE_UP",
    "MIDDLE_CLICK",
    "CLICK_WITH_MODIFIERS",
    "TAKE_SCREENSHOT",
    "CAPTURE_SCREEN",
    "SEE_SCREEN",
    "GET_ACCESSIBILITY_TREE",
    "FIND_ELEMENT",
  ],
  description:
    "computer_use:\n  purpose: Canonical cross-platform computer-use action for real desktop interaction on macOS, Linux, and Windows when direct computer operation is required.\n  guidance: Take a screenshot before acting. After each desktop action, the result includes a screenshot when available. Use this standard plugin action, not a LifeOps wrapper, for Finder/Desktop/native-app/browser/file/terminal workflows on the owner's machine.\n  actions: screenshot/click/click_with_modifiers/double_click/right_click/middle_click/mouse_down/mouse_up/mouse_move/type/key/key_down/key_up/key_combo/scroll/drag/drag_to/left_click_drag/detect_elements/find_element/ocr/accessibility_tree.",
  descriptionCompressed:
    "Canonical cross-platform desktop control: screenshot/click/modified click/double/right/middle/down/up/move/type/key/key_down/key_up/key_combo/scroll/drag/detect_elements/find_element/ocr/accessibility_tree.",
  routingHint:
    "desktop/computer/native-app/Finder/window screenshots or control -> COMPUTER_USE; never invent takeScreenshot",

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
          "middle_click",
          "mouse_down",
          "mouse_up",
          "mouse_move",
          "type",
          "key",
          "key_down",
          "key_up",
          "key_combo",
          "scroll",
          "drag",
          "left_click_drag",
          "drag_to",
          "detect_elements",
          "find_element",
          "ocr",
          "accessibility_tree",
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
      name: "modifiers",
      description:
        "Modifier keys to hold during click_with_modifiers, e.g. ['cmd', 'shift'] or ['ctrl'].",
      required: false,
      schema: { type: "array", items: { type: "string" } },
    },
    {
      name: "query",
      description:
        "Text query for find_element against AX/OCR id, label, role, source, or actions.",
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
      schema: { type: "number", minimum: 1, maximum: 20, default: 3 },
    },
    {
      name: "displayId",
      description:
        "Display the coordinate is local to. Required for any coordinate-bearing action on multi-monitor hosts. See the `computerState` provider for the live `displays[]` list.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "coordSource",
      description:
        "Coordinate space of the coordinate fields: 'logical' (default; matches display.bounds) or 'backing' (raw retina pixels — macOS only).",
      required: false,
      schema: { type: "string", enum: ["logical", "backing"] },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service = getComputerUseService(runtime);
    return service !== null;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const params = resolveActionParams<DesktopActionParams>(message, options);
    params.action ??= "screenshot";

    const service = getComputerUseService(runtime);
    if (!service) {
      return { success: false, error: "ComputerUseService not available" };
    }

    const result = await service.executeDesktopAction(params);
    const text = formatDesktopResultText(params, result);
    await deliverResult(params, result, text, callback);
    return toComputerUseActionResult({
      action: params.action,
      result,
      text,
      suppressClipboard: true,
    });
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: { text: "Take a screenshot of my screen.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Capturing the screen.",
          actions: ["COMPUTER_USE"],
          thought:
            "User asked for a screenshot of the desktop; COMPUTER_USE action=screenshot is the canonical handler.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: { text: "Click the Send button on the page.", source: "chat" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Clicking Send.",
          actions: ["COMPUTER_USE"],
          thought:
            "Direct UI click on a desktop control belongs in COMPUTER_USE action=click; pass the coordinate of the visible button.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Type 'Hello team' in the focused text box.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Typing the text.",
          actions: ["COMPUTER_USE"],
          thought:
            "Keyboard input into the focused field maps to COMPUTER_USE action=type with the literal text payload.",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Press Cmd+Shift+T to reopen the closed tab.",
          source: "chat",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Sending the key combo.",
          actions: ["COMPUTER_USE"],
          thought:
            "A multi-key shortcut routes to COMPUTER_USE action=key_combo with key='cmd+shift+t' so the desktop service triggers it as a single chord.",
        },
      },
    ],
  ],
};
