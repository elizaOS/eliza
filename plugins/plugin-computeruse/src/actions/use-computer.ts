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

const MOCK_SCREENSHOT_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+R4QAAAAASUVORK5CYII=";

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "on" ||
    normalized === "fixture"
  );
}

function isFalsyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  );
}

function isMockComputerUseEnabled(): boolean {
  const explicit = process.env.MILADY_TEST_COMPUTERUSE_BACKEND;
  if (isFalsyEnv(explicit)) return false;
  if (isTruthyEnv(explicit)) return true;
  return process.env.MILADY_BENCHMARK_USE_MOCKS === "1";
}

function getComputerUseService(
  runtime: IAgentRuntime,
): ComputerUseService | null {
  return (
    (runtime.getService("computeruse") as unknown as ComputerUseService) ?? null
  );
}

function buildMockDesktopResult(
  params: DesktopActionParams,
): ComputerActionResult {
  if (params.action === "detect_elements") {
    return {
      success: true,
      message: "Mocked desktop element scan completed.",
      screenshot: MOCK_SCREENSHOT_BASE64,
      data: {
        elements: [
          {
            role: "textbox",
            label: "Amount",
            coordinate: params.coordinate ?? [640, 360],
          },
        ],
      },
    };
  }

  if (params.action === "ocr") {
    return {
      success: true,
      message: "Mocked OCR completed.",
      screenshot: MOCK_SCREENSHOT_BASE64,
      data: { text: "Expense form\nAmount\n$42.50" },
    };
  }

  const message =
    params.action === "screenshot"
      ? "Mocked desktop screenshot captured."
      : `Mocked desktop action completed: ${params.action}.`;

  return {
    success: true,
    message,
    screenshot: MOCK_SCREENSHOT_BASE64,
    data: {
      mocked: true,
      action: params.action,
      coordinate: params.coordinate,
      startCoordinate: params.startCoordinate,
      text: params.text,
      key: params.key,
      modifiers: params.modifiers,
      button: params.button,
      clicks: params.clicks,
      scrollDirection: params.scrollDirection,
      scrollAmount: params.scrollAmount,
    },
  };
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
    "CLICK_WITH_MODIFIERS",
    "TAKE_SCREENSHOT",
    "CAPTURE_SCREEN",
    "SEE_SCREEN",
  ],
  description:
    "Control the local desktop. This action can inspect the current screen, move the mouse, click, drag, type, press keys, scroll, and perform modified clicks. It is intended for real application interaction when the agent needs to operate the user's computer directly.\n\n" +
    "Available actions:\n" +
    "- screenshot: Capture the current screen state. No parameters needed.\n" +
    "- click: Left-click at pixel coordinates. Requires coordinate: [x, y].\n" +
    "- click_with_modifiers: Hold modifiers such as ctrl, shift, alt, or cmd while clicking. Requires coordinate and modifiers.\n" +
    "- double_click: Double-click at coordinates. Requires coordinate: [x, y].\n" +
    "- right_click: Right-click at coordinates. Requires coordinate: [x, y].\n" +
    "- mouse_move: Move cursor without clicking. Requires coordinate: [x, y].\n" +
    "- type: Type text at the current cursor position. Requires text.\n" +
    "- key: Press a single key (e.g. Return, Tab, Escape, F5). Requires key.\n" +
    "- key_combo: Press a key combination (e.g. ctrl+c, cmd+shift+s, alt+F4). Requires key.\n" +
    "- scroll: Scroll at a position. Requires coordinate, scrollDirection (up/down/left/right), optional scrollAmount.\n" +
    "- drag: Drag from one point to another. Requires startCoordinate and coordinate.\n" +
    "- detect_elements: Stub for upstream parity on local machines.\n" +
    "- ocr: Stub for upstream parity on local machines.\n\n" +
    "Always take a screenshot first to see the current screen state before performing actions. " +
    "After each action, a screenshot is automatically returned showing the result.",

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
      name: "modifiers",
      description:
        "Modifier keys to hold during click_with_modifiers, e.g. ['cmd', 'shift'] or ['ctrl'].",
      required: false,
      schema: { type: "array", items: { type: "string" } },
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
      schema: { type: "number", minimum: 1, maximum: 20, default: 3 },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    const service = getComputerUseService(runtime);
    return service !== null || isMockComputerUseEnabled();
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
      if (!isMockComputerUseEnabled()) {
        return { success: false, error: "ComputerUseService not available" };
      }
      const mockResult = buildMockDesktopResult(params);
      const text = formatDesktopResultText(params, mockResult);
      await deliverResult(params, mockResult, text, callback);
      return toComputerUseActionResult({
        action: params.action,
        result: mockResult,
        text,
        suppressClipboard: true,
      });
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
};
