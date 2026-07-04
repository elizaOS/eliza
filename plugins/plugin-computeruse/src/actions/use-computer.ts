/**
 * COMPUTER_USE parent action — the umbrella desktop verb (screenshot, click, type,
 * key, scroll, drag, open, launch, …). Resolves params, enforces the OWNER role
 * and approval gate, dispatches through ComputerUseService, and returns a
 * screenshot-bearing result. Subactions are promoted to virtual top-level actions
 * (COMPUTER_USE_CLICK, …) at registration.
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
import type {
  ComputerActionResult,
  DesktopActionParams,
  DesktopActionType,
} from "../types.js";
import {
  buildScreenshotAttachment,
  resolveActionParams,
  toComputerUseActionResult,
} from "./helpers.js";
import { withApprovalRelay } from "./progress.js";

function approvalOwnerIdFromMemory(message: Memory): string | undefined {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const telegramUserId = (metadata as Record<string, unknown>).telegramUserId;
  return typeof telegramUserId === "string" && telegramUserId.length > 0
    ? telegramUserId
    : undefined;
}

function getComputerUseService(
  runtime: IAgentRuntime,
): ComputerUseService | null {
  return (runtime.getService("computeruse") as ComputerUseService) ?? null;
}

const DESKTOP_ACTIONS = new Set<DesktopActionType>([
  "screenshot",
  "click",
  "click_with_modifiers",
  "double_click",
  "right_click",
  "mouse_move",
  "middle_click",
  "mouse_down",
  "mouse_up",
  "type",
  "key",
  "key_combo",
  "key_down",
  "key_up",
  "scroll",
  "drag",
  "get_cursor_position",
  "detect_elements",
  "ocr",
  "open",
  "launch",
  "kill_app",
  "set_value",
]);

type ComputerUseActionParams = Omit<DesktopActionParams, "action"> & {
  action?: DesktopActionType | "resolve_approval";
  approvalId?: string;
  approved?: boolean;
  reason?: string;
};

type ApprovalDecision = {
  approvalId: string;
  approved: boolean;
  reason?: string;
  ownerMismatch?: boolean;
};

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

function parseApprovalDecision(
  params: ComputerUseActionParams,
  message: Memory,
): ApprovalDecision | null {
  if (params.action === "resolve_approval") {
    const approvalId = params.approvalId?.trim();
    if (!approvalId || typeof params.approved !== "boolean") {
      return null;
    }
    return {
      approvalId,
      approved: params.approved,
      reason: params.reason,
    };
  }

  const text = message.content?.text?.trim() ?? "";
  const compactMatch = /^cua:([^:]+):(approve|deny)(?::u([^:]+))?$/.exec(text);
  if (compactMatch) {
    const ownerId = compactMatch[3];
    const messageOwnerId = approvalOwnerIdFromMemory(message);
    if (ownerId && messageOwnerId && ownerId !== messageOwnerId) {
      return {
        approvalId: compactMatch[1] ?? "",
        approved: false,
        reason: "Approval callback owner mismatch",
        ownerMismatch: true,
      };
    }
    return {
      approvalId: compactMatch[1] ?? "",
      approved: compactMatch[2] === "approve",
      reason: `Resolved from chat button (${compactMatch[2]})`,
    };
  }

  const match = /^(approve|deny):([A-Za-z0-9_-]+)$/.exec(text);
  if (!match) {
    return null;
  }
  return {
    approved: match[1] === "approve",
    approvalId: match[2] ?? "",
    reason: `Resolved from chat button (${match[1]})`,
  };
}

function toDesktopActionParams(
  params: ComputerUseActionParams,
): DesktopActionParams | null {
  const action = params.action ?? "screenshot";
  if (!DESKTOP_ACTIONS.has(action as DesktopActionType)) {
    return null;
  }
  return {
    ...params,
    action: action as DesktopActionType,
  };
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
    "chat",
    "browser",
    "files",
    "terminal",
    "screen_time",
    "automation",
    "admin",
  ],
  contextGate: {
    anyOf: [
      "chat",
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
    "SCROLL_SCREEN",
    "MOVE_MOUSE",
    "DRAG",
    "MOUSE_CLICK",
    "CLICK_WITH_MODIFIERS",
    "TAKE_SCREENSHOT",
    "CAPTURE_SCREEN",
    "SEE_SCREEN",
    "APPROVE_COMPUTER_USE",
    "DENY_COMPUTER_USE",
  ],
  description:
    "computer_use: real desktop control on macOS/Linux/Windows. Screenshot before acting. Results include screenshot when available. Use for Finder/Desktop/native-app/browser/file/terminal on owner's machine. actions: screenshot/click/click_with_modifiers/double_click/right_click/mouse_move/middle_click/mouse_down/mouse_up/type/key/key_combo/key_down/key_up/scroll/drag/detect_elements/ocr/open/launch. mouse_down/up + key_down/up are press-and-hold primitives (button held until released); drag accepts a multi-point `path`; open(target) opens a file/URL/folder; launch(app,appArgs) starts an app and returns its pid. Also resolves pending computer-use approvals from approve:<id> / deny:<id> chat button callbacks.",
  descriptionCompressed:
    "Desktop: screenshot|click|double|right|middle|move|down|up|type|key|scroll|drag|detect|ocr|open|launch|approve",
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
          "mouse_move",
          "middle_click",
          "mouse_down",
          "mouse_up",
          "type",
          "key",
          "key_combo",
          "key_down",
          "key_up",
          "scroll",
          "drag",
          "get_cursor_position",
          "detect_elements",
          "ocr",
          "open",
          "launch",
          "kill_app",
          "set_value",
          "resolve_approval",
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
      name: "path",
      description:
        "Multi-point polyline [[x,y],...] (≥2 points) for drag; traces every waypoint with the button held. Supersedes startCoordinate/coordinate when present.",
      required: false,
      schema: {
        type: "array",
        items: { type: "array", items: { type: "number" } },
      },
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
        "Modifier keys for click_with_modifiers, e.g. ['cmd','shift'] or ['ctrl'].",
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
      name: "button",
      description:
        "Mouse button for click_with_modifiers and mouse_down/mouse_up (default left).",
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
        "Display for coordinate. Required for coordinate actions on multi-monitor. See computerState displays[].",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "coordSource",
      description:
        "Coordinate space: logical default matches display.bounds; backing raw retina pixels macOS only.",
      required: false,
      schema: { type: "string", enum: ["logical", "backing"] },
    },
    {
      name: "approvalId",
      description:
        "Pending computer-use approval id for action=resolve_approval.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "approved",
      description: "Approval decision for action=resolve_approval.",
      required: false,
      schema: { type: "boolean" },
    },
    {
      name: "reason",
      description: "Optional reason for an approval decision.",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "target",
      description:
        "File path / URL / folder to open with the OS default handler (action=open).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "app",
      description:
        "Application name or executable path to launch (action=launch).",
      required: false,
      schema: { type: "string" },
    },
    {
      name: "appArgs",
      description: "Arguments for the launched application (action=launch).",
      required: false,
      schema: { type: "array", items: { type: "string" } },
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
    const params = resolveActionParams<ComputerUseActionParams>(
      message,
      options,
    );

    const service = getComputerUseService(runtime);
    if (!service) {
      return { success: false, error: "ComputerUseService not available" };
    }

    const approvalDecision = parseApprovalDecision(params, message);
    if (approvalDecision) {
      if (approvalDecision.ownerMismatch) {
        const text =
          "Computer-use approval callback does not belong to this user.";
        if (callback) {
          await callback({ text }, "COMPUTER_USE");
        }
        return {
          success: false,
          error: text,
          text,
          data: {
            source: "computeruse",
            computerUseAction: "COMPUTER_USE",
            approvalId: approvalDecision.approvalId,
          },
        };
      }
      const resolution = service.resolveApproval(
        approvalDecision.approvalId,
        approvalDecision.approved,
        approvalDecision.reason,
      );
      const verb = approvalDecision.approved ? "approved" : "denied";
      const text = resolution
        ? `Computer-use approval ${approvalDecision.approvalId} ${verb}.`
        : `Computer-use approval ${approvalDecision.approvalId} is not pending.`;
      if (callback) {
        await callback({ text }, "COMPUTER_USE");
      }
      return {
        success: resolution !== null,
        text,
        data: {
          source: "computeruse",
          computerUseAction: "COMPUTER_USE",
          approval: resolution,
        },
      };
    }

    const desktopParams = toDesktopActionParams(params);
    if (!desktopParams) {
      return {
        success: false,
        error: `Unknown COMPUTER_USE action: ${String(params.action)}`,
      };
    }

    const result: ComputerActionResult = await withApprovalRelay(
      service,
      callback,
      () => service.executeDesktopAction(desktopParams),
      { ownerId: approvalOwnerIdFromMemory(message) },
    );
    const text = formatDesktopResultText(desktopParams, result);
    await deliverResult(desktopParams, result, text, callback);
    return toComputerUseActionResult({
      action: desktopParams.action,
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
