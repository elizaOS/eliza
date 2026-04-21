import type {
  Action,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type {
  ComputerActionResult,
  DesktopActionParams,
} from "../types.js";
import type { ComputerUseService } from "../services/computer-use-service.js";
import {
  buildScreenshotAttachment,
  resolveActionParams,
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

async function deliverResult(
  params: DesktopActionParams,
  result: ComputerActionResult,
  callback?: HandlerCallback,
): Promise<void> {
  if (!callback) return;
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
    "TAKE_SCREENSHOT",
    "CAPTURE_SCREEN",
    "SCREEN_CAPTURE",
    "GET_SCREENSHOT",
    "SEE_SCREEN",
    "LOOK_AT_SCREEN",
    "VIEW_SCREEN",
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
  descriptionCompressed: "Desktop control: mouse, keyboard, screenshot, scroll, drag. For direct app interaction.",
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
    const service = getComputerUseService(runtime);
    return service !== null || isMockComputerUseEnabled();
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions,
    callback?: HandlerCallback,
  ) => {
    const params = resolveActionParams<DesktopActionParams>(message, options);
    params.action ??= "screenshot";

    const service = getComputerUseService(runtime);
    if (!service) {
      if (!isMockComputerUseEnabled()) {
        return { success: false, error: "ComputerUseService not available" };
      }
      const mockResult = buildMockDesktopResult(params);
      await deliverResult(params, mockResult, callback);
      return mockResult as unknown as any;
    }

    const result = await service.executeDesktopAction(params);
    await deliverResult(params, result, callback);

    return result as unknown as any;
  },
};
