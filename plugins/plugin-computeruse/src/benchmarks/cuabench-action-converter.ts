import type { DesktopActionParams } from "../types.js";

export type CuaBenchActionInput = string | CuaBenchActionObject;

export type CuaBenchActionObject = {
  type?: string;
  action_type?: string;
  name?: string;
  x?: number;
  y?: number;
  from_x?: number;
  from_y?: number;
  to_x?: number;
  to_y?: number;
  duration?: number;
  direction?: string;
  amount?: number;
  text?: string;
  key?: string;
  keys?: string[];
  seconds?: number;
};

export type CuaBenchControlAction =
  | { kind: "wait"; seconds: number }
  | { kind: "done" };

export type CuaBenchConvertedAction =
  | { kind: "desktop"; params: DesktopActionParams }
  | { kind: "control"; control: CuaBenchControlAction };

const REPR_PATTERNS: Array<{
  regex: RegExp;
  toAction: (match: RegExpMatchArray) => CuaBenchActionObject;
}> = [
  {
    regex: /^ClickAction\(x=(\d+),\s*y=(\d+)\)$/,
    toAction: (m) => ({ type: "ClickAction", x: Number(m[1]), y: Number(m[2]) }),
  },
  {
    regex: /^RightClickAction\(x=(\d+),\s*y=(\d+)\)$/,
    toAction: (m) => ({
      type: "RightClickAction",
      x: Number(m[1]),
      y: Number(m[2]),
    }),
  },
  {
    regex: /^DoubleClickAction\(x=(\d+),\s*y=(\d+)\)$/,
    toAction: (m) => ({
      type: "DoubleClickAction",
      x: Number(m[1]),
      y: Number(m[2]),
    }),
  },
  {
    regex: /^MiddleClickAction\(x=(\d+),\s*y=(\d+)\)$/,
    toAction: (m) => ({
      type: "MiddleClickAction",
      x: Number(m[1]),
      y: Number(m[2]),
    }),
  },
  {
    regex:
      /^DragAction\(from_x=(\d+),\s*from_y=(\d+),\s*to_x=(\d+),\s*to_y=(\d+)(?:,\s*duration=([0-9.]+))?\)$/,
    toAction: (m) => ({
      type: "DragAction",
      from_x: Number(m[1]),
      from_y: Number(m[2]),
      to_x: Number(m[3]),
      to_y: Number(m[4]),
      duration: m[5] === undefined ? undefined : Number(m[5]),
    }),
  },
  {
    regex: /^MoveToAction\(x=(\d+),\s*y=(\d+)(?:,\s*duration=([0-9.]+))?\)$/,
    toAction: (m) => ({
      type: "MoveToAction",
      x: Number(m[1]),
      y: Number(m[2]),
      duration: m[3] === undefined ? undefined : Number(m[3]),
    }),
  },
  {
    regex: /^ScrollAction\((?:(?:direction=['"](\w+)['"])?(?:,\s*)?(?:amount=(\d+))?)\)$/,
    toAction: (m) => ({
      type: "ScrollAction",
      direction: m[1] ?? "up",
      amount: m[2] === undefined ? undefined : Number(m[2]),
    }),
  },
  {
    regex: /^TypeAction\(text=['"]([^'"]*)['"].*?\)$/,
    toAction: (m) => ({ type: "TypeAction", text: m[1] ?? "" }),
  },
  {
    regex: /^KeyAction\(key=['"]([^'"]+)['"]\)$/,
    toAction: (m) => ({ type: "KeyAction", key: m[1] }),
  },
  {
    regex: /^HotkeyAction\(keys=\[([^\]]+)\].*?\)$/,
    toAction: (m) => ({
      type: "HotkeyAction",
      keys: (m[1] ?? "")
        .split(",")
        .map((key) => key.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean),
    }),
  },
  {
    regex: /^WaitAction\((?:seconds=([0-9.]+))?\)$/,
    toAction: (m) => ({
      type: "WaitAction",
      seconds: m[1] === undefined ? undefined : Number(m[1]),
    }),
  },
  {
    regex: /^DoneAction\(\)$/,
    toAction: () => ({ type: "DoneAction" }),
  },
];

const SNAKE_PATTERNS: Array<{
  regex: RegExp;
  toAction: (match: RegExpMatchArray) => CuaBenchActionObject;
}> = [
  {
    regex: /^click\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/,
    toAction: (m) => ({ type: "ClickAction", x: Number(m[1]), y: Number(m[2]) }),
  },
  {
    regex: /^right_click\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/,
    toAction: (m) => ({
      type: "RightClickAction",
      x: Number(m[1]),
      y: Number(m[2]),
    }),
  },
  {
    regex: /^double_click\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/,
    toAction: (m) => ({
      type: "DoubleClickAction",
      x: Number(m[1]),
      y: Number(m[2]),
    }),
  },
  {
    regex: /^middle_click\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/,
    toAction: (m) => ({
      type: "MiddleClickAction",
      x: Number(m[1]),
      y: Number(m[2]),
    }),
  },
  {
    regex: /^drag\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/,
    toAction: (m) => ({
      type: "DragAction",
      from_x: Number(m[1]),
      from_y: Number(m[2]),
      to_x: Number(m[3]),
      to_y: Number(m[4]),
    }),
  },
  {
    regex: /^move_to\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)$/,
    toAction: (m) => ({
      type: "MoveToAction",
      x: Number(m[1]),
      y: Number(m[2]),
    }),
  },
  {
    regex: /^scroll\s*\(\s*(\w+)(?:\s*,\s*(\d+))?\s*\)$/,
    toAction: (m) => ({
      type: "ScrollAction",
      direction: m[1],
      amount: m[2] === undefined ? undefined : Number(m[2]),
    }),
  },
  {
    regex: /^key\s*\(\s*([^)]+)\s*\)$/,
    toAction: (m) => ({ type: "KeyAction", key: m[1]?.trim() }),
  },
  {
    regex: /^type\s*\(\s*["'](.*)["']\s*\)$/,
    toAction: (m) => ({ type: "TypeAction", text: m[1] ?? "" }),
  },
  {
    regex: /^hotkey\s*\(\s*([\w+]+)\s*\)$/,
    toAction: (m) => ({
      type: "HotkeyAction",
      keys: (m[1] ?? "").split("+").filter(Boolean),
    }),
  },
  {
    regex: /^wait\s*\(\s*([\d.]*)\s*\)$/,
    toAction: (m) => ({
      type: "WaitAction",
      seconds: m[1] ? Number(m[1]) : undefined,
    }),
  },
  {
    regex: /^done\s*\(\s*\)$/,
    toAction: () => ({ type: "DoneAction" }),
  },
];

export function fromCuaBenchAction(
  input: CuaBenchActionInput,
): CuaBenchConvertedAction {
  const action = typeof input === "string" ? parseCuaBenchActionString(input) : input;
  const type = normalizeActionType(action.type ?? action.action_type ?? action.name);

  switch (type) {
    case "click":
      return desktop("click", coord(action.x, action.y));
    case "rightclick":
      return desktop("right_click", coord(action.x, action.y));
    case "doubleclick":
      return desktop("double_click", coord(action.x, action.y));
    case "middleclick":
      return desktop("middle_click", coord(action.x, action.y));
    case "drag":
      return {
        kind: "desktop",
        params: {
          action: "drag",
          startCoordinate: coord(action.from_x, action.from_y),
          coordinate: coord(action.to_x, action.to_y),
        },
      };
    case "moveto":
      return desktop("mouse_move", coord(action.x, action.y));
    case "scroll":
      return {
        kind: "desktop",
        params: {
          action: "scroll",
          coordinate: coord(action.x ?? 0, action.y ?? 0),
          scrollDirection: normalizeScrollDirection(action.direction),
          scrollAmount: Math.max(1, Math.floor(Number(action.amount ?? 3))),
        },
      };
    case "type":
      return {
        kind: "desktop",
        params: { action: "type", text: String(action.text ?? "") },
      };
    case "key":
      return {
        kind: "desktop",
        params: { action: "key", key: String(action.key ?? "") },
      };
    case "hotkey":
      return {
        kind: "desktop",
        params: { action: "key_combo", key: (action.keys ?? []).join("+") },
      };
    case "wait":
      return {
        kind: "control",
        control: { kind: "wait", seconds: Number(action.seconds ?? 1) },
      };
    case "done":
      return { kind: "control", control: { kind: "done" } };
    default:
      throw new Error(`Unsupported CuaBench action type: ${String(type)}`);
  }
}

export function parseCuaBenchActionString(input: string): CuaBenchActionObject {
  const value = input.trim();
  for (const pattern of [...REPR_PATTERNS, ...SNAKE_PATTERNS]) {
    const match = value.match(pattern.regex);
    if (match) return pattern.toAction(match);
  }
  throw new Error(`Could not parse CuaBench action string: ${input}`);
}

function desktop(
  action: DesktopActionParams["action"],
  coordinate: [number, number],
): CuaBenchConvertedAction {
  return { kind: "desktop", params: { action, coordinate } };
}

function coord(x: unknown, y: unknown): [number, number] {
  const nx = Number(x ?? 0);
  const ny = Number(y ?? 0);
  return [Number.isFinite(nx) ? nx : 0, Number.isFinite(ny) ? ny : 0];
}

function normalizeActionType(value: unknown): string {
  return String(value ?? "")
    .replace(/Action$/i, "")
    .replace(/[_\s-]/g, "")
    .toLowerCase();
}

function normalizeScrollDirection(
  value: unknown,
): "up" | "down" | "left" | "right" {
  const normalized = String(value ?? "up").toLowerCase();
  if (
    normalized === "up" ||
    normalized === "down" ||
    normalized === "left" ||
    normalized === "right"
  ) {
    return normalized;
  }
  return "up";
}
