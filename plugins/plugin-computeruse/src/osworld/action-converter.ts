/**
 * Converts between OSWorld action formats and plugin-computeruse actions.
 *
 * Supports two OSWorld action spaces:
 * 1. "computer_13" — structured action dicts
 * 2. "pyautogui" — Python code strings
 */

import type { DesktopActionParams } from "../types.js";
import type { OSWorldAction } from "./types.js";

// ── computer_13 → DesktopActionParams ───────────────────────────────────

/**
 * Convert an OSWorld computer_13 action to a DesktopActionParams.
 * Returns null for WAIT/DONE/FAIL (control flow, not desktop actions).
 */
export function fromOSWorldAction(
  action: OSWorldAction,
): DesktopActionParams | null {
  switch (action.action_type) {
    case "CLICK":
      return {
        action: "click",
        coordinate: [action.x ?? 0, action.y ?? 0],
      };

    case "MOVE_TO":
      return {
        action: "mouse_move",
        coordinate: [action.x ?? 0, action.y ?? 0],
      };

    case "DOUBLE_CLICK":
      return {
        action: "double_click",
        coordinate: [action.x ?? 0, action.y ?? 0],
      };

    case "RIGHT_CLICK":
      return {
        action: "right_click",
        coordinate: [action.x ?? 0, action.y ?? 0],
      };

    case "SCROLL":
      return {
        action: "scroll",
        coordinate: [action.x ?? 0, action.y ?? 0],
        scrollDirection:
          action.direction ?? (action.dy && action.dy < 0 ? "up" : "down"),
        scrollAmount: Math.abs(action.amount ?? action.dy ?? 3),
      };

    case "DRAG_TO":
      return {
        action: "drag",
        startCoordinate: [action.x ?? 0, action.y ?? 0],
        coordinate: [
          (action.x ?? 0) + (action.dx ?? 0),
          (action.y ?? 0) + (action.dy ?? 0),
        ],
      };

    case "TYPING":
      return {
        action: "type",
        text: action.text ?? "",
      };

    case "PRESS":
      return {
        action: "key",
        key: action.key ?? action.text ?? "",
      };

    case "KEY_DOWN":
      // KEY_DOWN doesn't have a direct equivalent — simulate as key press
      return {
        action: "key",
        key: action.key ?? "",
      };

    case "KEY_UP":
      // KEY_UP is a no-op in our model (keys are press-and-release)
      return null;

    case "HOTKEY":
      return {
        action: "key_combo",
        key: (action.keys ?? []).join("+"),
      };

    case "MOUSE_DOWN":
      // Start of a drag — just move to position for now
      return {
        action: "mouse_move",
        coordinate: [action.x ?? 0, action.y ?? 0],
      };

    case "MOUSE_UP":
      // End of a drag — just click at position
      return {
        action: "click",
        coordinate: [action.x ?? 0, action.y ?? 0],
      };

    case "WAIT":
    case "DONE":
    case "FAIL":
      return null;

    default:
      return null;
  }
}

// ── DesktopActionParams → OSWorldAction ─────────────────────────────────

/**
 * Convert a DesktopActionParams to an OSWorld computer_13 action.
 */
export function toOSWorldAction(params: DesktopActionParams): OSWorldAction {
  switch (params.action) {
    case "click":
      return {
        action_type: "CLICK",
        x: params.coordinate?.[0],
        y: params.coordinate?.[1],
      };

    case "double_click":
      return {
        action_type: "DOUBLE_CLICK",
        x: params.coordinate?.[0],
        y: params.coordinate?.[1],
      };

    case "right_click":
      return {
        action_type: "RIGHT_CLICK",
        x: params.coordinate?.[0],
        y: params.coordinate?.[1],
      };

    case "mouse_move":
      return {
        action_type: "MOVE_TO",
        x: params.coordinate?.[0],
        y: params.coordinate?.[1],
      };

    case "type":
      return {
        action_type: "TYPING",
        text: params.text,
      };

    case "key":
      return {
        action_type: "PRESS",
        key: params.key,
      };

    case "key_combo":
      return {
        action_type: "HOTKEY",
        keys: params.key?.split("+"),
      };

    case "scroll":
      return {
        action_type: "SCROLL",
        x: params.coordinate?.[0],
        y: params.coordinate?.[1],
        direction: params.scrollDirection,
        amount: params.scrollAmount,
      };

    case "drag":
      return {
        action_type: "DRAG_TO",
        x: params.startCoordinate?.[0],
        y: params.startCoordinate?.[1],
        dx: (params.coordinate?.[0] ?? 0) - (params.startCoordinate?.[0] ?? 0),
        dy: (params.coordinate?.[1] ?? 0) - (params.startCoordinate?.[1] ?? 0),
      };

    case "screenshot":
      return { action_type: "WAIT" }; // Screenshots aren't actions in OSWorld

    default:
      return { action_type: "WAIT" };
  }
}

// ── pyautogui string → DesktopActionParams ──────────────────────────────

/**
 * Parse a pyautogui Python code string into a DesktopActionParams.
 * Handles common patterns:
 *   pyautogui.click(100, 200)
 *   pyautogui.typewrite('hello')
 *   pyautogui.press('return')
 *   pyautogui.hotkey('ctrl', 'c')
 *   pyautogui.moveTo(100, 200)
 *   pyautogui.scroll(3)
 *   pyautogui.doubleClick(100, 200)
 *   pyautogui.rightClick(100, 200)
 *   pyautogui.drag(100, 50)
 *
 * Returns null for WAIT/DONE/FAIL strings.
 */
export function fromPyAutoGUI(code: string): DesktopActionParams | null {
  const trimmed = code.trim();

  // Special control flow strings
  if (trimmed === "WAIT" || trimmed === "DONE" || trimmed === "FAIL") {
    return null;
  }

  // pyautogui.click(x, y)
  const clickMatch = trimmed.match(/pyautogui\.click\((\d+),\s*(\d+)\)/);
  if (clickMatch) {
    return {
      action: "click",
      coordinate: [
        Number.parseInt(clickMatch[1]!, 10),
        Number.parseInt(clickMatch[2]!, 10),
      ],
    };
  }

  // pyautogui.doubleClick(x, y)
  const dblClickMatch = trimmed.match(
    /pyautogui\.doubleClick\((\d+),\s*(\d+)\)/,
  );
  if (dblClickMatch) {
    return {
      action: "double_click",
      coordinate: [
        Number.parseInt(dblClickMatch[1]!, 10),
        Number.parseInt(dblClickMatch[2]!, 10),
      ],
    };
  }

  // pyautogui.rightClick(x, y)
  const rightClickMatch = trimmed.match(
    /pyautogui\.rightClick\((\d+),\s*(\d+)\)/,
  );
  if (rightClickMatch) {
    return {
      action: "right_click",
      coordinate: [
        Number.parseInt(rightClickMatch[1]!, 10),
        Number.parseInt(rightClickMatch[2]!, 10),
      ],
    };
  }

  // pyautogui.moveTo(x, y)
  const moveMatch = trimmed.match(/pyautogui\.moveTo\((\d+),\s*(\d+)\)/);
  if (moveMatch) {
    return {
      action: "mouse_move",
      coordinate: [
        Number.parseInt(moveMatch[1]!, 10),
        Number.parseInt(moveMatch[2]!, 10),
      ],
    };
  }

  // pyautogui.typewrite('text') or pyautogui.write('text')
  const typeMatch = trimmed.match(
    /pyautogui\.(?:typewrite|write)\(['"](.+?)['"]\)/,
  );
  if (typeMatch) {
    return { action: "type", text: typeMatch[1] };
  }

  // pyautogui.press('key')
  const pressMatch = trimmed.match(/pyautogui\.press\(['"](.+?)['"]\)/);
  if (pressMatch) {
    return { action: "key", key: pressMatch[1] };
  }

  // pyautogui.hotkey('mod', 'key') — variable number of args
  const hotkeyMatch = trimmed.match(/pyautogui\.hotkey\((.+)\)/);
  if (hotkeyMatch) {
    const keys = hotkeyMatch[1]!
      .split(",")
      .map((k) => k.trim().replace(/['"]/g, ""));
    return { action: "key_combo", key: keys.join("+") };
  }

  // pyautogui.scroll(amount, x=X, y=Y) or pyautogui.scroll(amount)
  const scrollMatch = trimmed.match(
    /pyautogui\.scroll\((-?\d+)(?:,\s*x=(\d+),\s*y=(\d+))?\)/,
  );
  if (scrollMatch) {
    const amount = Number.parseInt(scrollMatch[1]!, 10);
    const x = scrollMatch[2] ? Number.parseInt(scrollMatch[2], 10) : 0;
    const y = scrollMatch[3] ? Number.parseInt(scrollMatch[3], 10) : 0;
    return {
      action: "scroll",
      coordinate: [x, y],
      scrollDirection: amount > 0 ? "up" : "down",
      scrollAmount: Math.abs(amount),
    };
  }

  // pyautogui.drag(dx, dy)
  const dragMatch = trimmed.match(/pyautogui\.drag\((-?\d+),\s*(-?\d+)\)/);
  if (dragMatch) {
    return {
      action: "drag",
      startCoordinate: [0, 0], // relative drag from current position
      coordinate: [
        Number.parseInt(dragMatch[1]!, 10),
        Number.parseInt(dragMatch[2]!, 10),
      ],
    };
  }

  // Fallback: try to evaluate as generic code
  return null;
}
