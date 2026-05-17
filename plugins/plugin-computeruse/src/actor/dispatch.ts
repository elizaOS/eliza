/**
 * WS7 — Dispatch layer.
 *
 * Single entry point that validates a resolved `ProposedAction` and routes
 * it to a `ComputerInterface`. Errors are returned as structured
 * `ActionResult.error` values — we don't let exceptions escape the cascade
 * boundary, so the agent loop can recover by re-prompting the Brain.
 *
 * Validation:
 *   - displayId must exist
 *   - point coords (when present) must be inside the display's local bounds
 *   - text/key/keys/dx/dy must match the action kind
 *
 * No business logic lives here. The dispatcher is dumb on purpose.
 */

import type { DisplayDescriptor } from "../types.js";
import type { ComputerInterface, DisplayPoint } from "./computer-interface.js";
import type { ActionResult, ProposedAction } from "./types.js";

export interface DispatchDeps {
  interface: ComputerInterface;
  listDisplays: () => DisplayDescriptor[];
}

export async function dispatch(
  action: ProposedAction,
  deps: DispatchDeps,
): Promise<ActionResult> {
  const displays = deps.listDisplays();
  const target = displays.find((d) => d.id === action.displayId);
  if (action.kind !== "wait" && action.kind !== "finish") {
    if (!target) {
      return {
        success: false,
        error: {
          code: "unknown_display",
          message: `Unknown displayId ${action.displayId}. Known: ${displays.map((d) => d.id).join(", ")}`,
        },
      };
    }
  }

  if (action.kind === "wait" || action.kind === "finish") {
    return { success: true, issued: action };
  }

  if (
    action.kind === "click" ||
    action.kind === "double_click" ||
    action.kind === "right_click"
  ) {
    if (!target) {
      return unknownDisplay(action, displays);
    }
    const point = resolvePoint(action);
    if (!point) {
      return invalidArgs(action, "click action requires finite (x, y) coords");
    }
    const oob = checkBounds(target, point.x, point.y);
    if (oob) return oob;
    const displayPoint: DisplayPoint = {
      displayId: action.displayId,
      x: point.x,
      y: point.y,
    };
    try {
      if (action.kind === "click") await deps.interface.leftClick(displayPoint);
      else if (action.kind === "double_click")
        await deps.interface.doubleClick(displayPoint);
      else await deps.interface.rightClick(displayPoint);
    } catch (err) {
      return driverError(err);
    }
    return { success: true, issued: action };
  }

  if (action.kind === "type") {
    if (typeof action.text !== "string" || action.text.length === 0) {
      return invalidArgs(action, "type action requires non-empty text");
    }
    try {
      await deps.interface.typeText({ text: action.text });
    } catch (err) {
      return driverError(err);
    }
    return { success: true, issued: action };
  }

  if (action.kind === "key") {
    if (typeof action.key !== "string" || action.key.length === 0) {
      return invalidArgs(action, "key action requires non-empty key");
    }
    try {
      await deps.interface.pressKey({ key: action.key });
    } catch (err) {
      return driverError(err);
    }
    return { success: true, issued: action };
  }

  if (action.kind === "hotkey") {
    if (!Array.isArray(action.keys) || action.keys.length === 0) {
      return invalidArgs(action, "hotkey action requires non-empty keys[]");
    }
    try {
      await deps.interface.hotkey({ keys: action.keys });
    } catch (err) {
      return driverError(err);
    }
    return { success: true, issued: action };
  }

  if (action.kind === "scroll") {
    if (!target) {
      return unknownDisplay(action, displays);
    }
    const point = resolvePoint(action);
    if (
      !point ||
      typeof action.dx !== "number" ||
      typeof action.dy !== "number"
    ) {
      return invalidArgs(
        action,
        "scroll action requires (x, y) anchor and (dx, dy)",
      );
    }
    const oob = checkBounds(target, point.x, point.y);
    if (oob) return oob;
    try {
      await deps.interface.scroll({
        displayId: action.displayId,
        x: point.x,
        y: point.y,
        dx: action.dx,
        dy: action.dy,
      });
    } catch (err) {
      return driverError(err);
    }
    return { success: true, issued: action };
  }

  if (action.kind === "drag") {
    if (!target) {
      return unknownDisplay(action, displays);
    }
    const start = resolveStartPoint(action);
    const end = resolvePoint(action);
    if (!start || !end) {
      return invalidArgs(action, "drag requires startX/startY and x/y");
    }
    const oobStart = checkBounds(target, start.x, start.y);
    if (oobStart) return oobStart;
    const oobEnd = checkBounds(target, end.x, end.y);
    if (oobEnd) return oobEnd;
    try {
      await deps.interface.drag({
        displayId: action.displayId,
        path: [
          { x: start.x, y: start.y },
          { x: end.x, y: end.y },
        ],
      });
    } catch (err) {
      return driverError(err);
    }
    return { success: true, issued: action };
  }

  return invalidArgs(
    action,
    `unknown action kind "${(action as ProposedAction).kind}"`,
  );
}

function resolvePoint(action: ProposedAction): { x: number; y: number } | null {
  const { x, y } = action;
  return typeof x === "number" &&
    Number.isFinite(x) &&
    typeof y === "number" &&
    Number.isFinite(y)
    ? { x, y }
    : null;
}

function resolveStartPoint(
  action: ProposedAction,
): { x: number; y: number } | null {
  const { startX, startY } = action;
  return typeof startX === "number" &&
    Number.isFinite(startX) &&
    typeof startY === "number" &&
    Number.isFinite(startY)
    ? { x: startX, y: startY }
    : null;
}

function checkBounds(
  display: DisplayDescriptor,
  x: number,
  y: number,
): ActionResult | null {
  const [, , w, h] = display.bounds;
  if (x < 0 || y < 0 || x >= w || y >= h) {
    return {
      success: false,
      error: {
        code: "out_of_bounds",
        message: `Coordinates (${x}, ${y}) are outside display ${display.id} bounds (0,0)-(${w},${h})`,
      },
    };
  }
  return null;
}

function invalidArgs(action: ProposedAction, message: string): ActionResult {
  return {
    success: false,
    error: {
      code: "invalid_args",
      message: `${message} (action.kind=${action.kind})`,
    },
  };
}

function unknownDisplay(
  action: ProposedAction,
  displays: DisplayDescriptor[],
): ActionResult {
  return {
    success: false,
    error: {
      code: "unknown_display",
      message: `Unknown displayId ${action.displayId}. Known: ${displays.map((d) => d.id).join(", ")}`,
    },
  };
}

function driverError(err: unknown): ActionResult {
  return {
    success: false,
    error: {
      code: "driver_error",
      message: err instanceof Error ? err.message : String(err),
    },
  };
}
