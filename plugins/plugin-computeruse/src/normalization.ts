/**
 * Parameter normalization for upstream open-computer-use compatibility.
 *
 * This file intentionally does not wire into any actions or services. It only
 * translates upstream-style parameter names into the canonical shapes used by
 * this plugin.
 */

export type NormalizedComputerUseParams = Record<string, unknown>;

type ParamRecord = Record<string, unknown>;
type Point = [number, number];

const WINDOW_IDENTIFIER_COMMANDS = new Set([
  "switch_to_window",
  "focus_window",
  "close_window",
  "minimize_window",
  "maximize_window",
  "restore_window",
]);

const TAB_COMMANDS = new Set([
  "browser_close_tab",
  "browser_switch_tab",
  "browser_open_tab",
  "close_tab",
  "switch_tab",
  "open_tab",
]);

const START_POINT_ALIASES: Array<[string, string]> = [
  ["startX", "startY"],
  ["start_x", "start_y"],
  ["x1", "y1"],
  ["fromX", "fromY"],
  ["from_x", "from_y"],
  ["beginX", "beginY"],
  ["begin_x", "begin_y"],
];

const END_POINT_ALIASES: Array<[string, string]> = [
  ["endX", "endY"],
  ["end_x", "end_y"],
  ["x2", "y2"],
  ["toX", "toY"],
  ["to_x", "to_y"],
  ["targetX", "targetY"],
  ["target_x", "target_y"],
];

const COORDINATE_ALIASES: Array<[string, string]> = [["x", "y"]];

function cloneParams(params: ParamRecord | null | undefined): ParamRecord {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {};
  }
  return { ...params };
}

function hasOwnValue(params: ParamRecord, key: string): boolean {
  return params[key] !== undefined && params[key] !== null;
}

function toPoint(value: unknown): Point | undefined {
  if (Array.isArray(value) && value.length >= 2) {
    return [Number(value[0]), Number(value[1])];
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const x =
      record.x ??
      record.left ??
      record.startX ??
      record.start_x ??
      record.fromX ??
      record.from_x;
    const y =
      record.y ??
      record.top ??
      record.startY ??
      record.start_y ??
      record.fromY ??
      record.from_y;

    if (x !== undefined && y !== undefined) {
      return [Number(x), Number(y)];
    }
  }

  return undefined;
}

function setPointAlias(
  params: ParamRecord,
  targetKey: string,
  aliases: Array<[string, string]>,
): void {
  if (hasOwnValue(params, targetKey)) {
    const existing = toPoint(params[targetKey]);
    if (existing) {
      params[targetKey] = existing;
    }
    return;
  }

  for (const [xKey, yKey] of aliases) {
    if (xKey === targetKey || yKey === targetKey) {
      continue;
    }

    const xValue = params[xKey];
    const yValue = params[yKey];
    if (xValue === undefined || yValue === undefined) {
      continue;
    }

    params[targetKey] = [Number(xValue), Number(yValue)];
    return;
  }
}

function setPointFromKeys(
  params: ParamRecord,
  targetKey: string,
  aliases: string[],
): void {
  if (hasOwnValue(params, targetKey)) {
    const existing = toPoint(params[targetKey]);
    if (existing) {
      params[targetKey] = existing;
    }
    return;
  }

  for (const alias of aliases) {
    if (!hasOwnValue(params, alias)) {
      continue;
    }

    const point = toPoint(params[alias]);
    if (point) {
      params[targetKey] = point;
      return;
    }
  }
}

function setDirectAlias(
  params: ParamRecord,
  targetKey: string,
  aliases: string[],
  transform: (value: unknown) => unknown = (value) => value,
): void {
  if (hasOwnValue(params, targetKey)) {
    return;
  }

  for (const alias of aliases) {
    if (!hasOwnValue(params, alias)) {
      continue;
    }

    params[targetKey] = transform(params[alias]);
    return;
  }
}

function normalizePathAliases(params: ParamRecord): void {
  setDirectAlias(params, "path", ["filepath", "dirpath"]);
}

function normalizeEditAliases(params: ParamRecord): void {
  setDirectAlias(params, "old_text", ["find"]);
  setDirectAlias(params, "new_text", ["replace"]);
}

function normalizeTabAliases(command: string, params: ParamRecord): void {
  if (hasOwnValue(params, "tab_index")) {
    if (!hasOwnValue(params, "index")) {
      params.index = Number(params.tab_index);
    }

    if (!hasOwnValue(params, "tabId")) {
      params.tabId = String(params.tab_index);
    }
  }

  if (
    TAB_COMMANDS.has(command) &&
    hasOwnValue(params, "index") &&
    !hasOwnValue(params, "tabId")
  ) {
    params.tabId = String(params.index);
  }
}

function normalizeWindowAliases(command: string, params: ParamRecord): void {
  if (!WINDOW_IDENTIFIER_COMMANDS.has(command)) {
    return;
  }

  setDirectAlias(params, "windowId", [
    "windowId",
    "window",
    "title",
    "window_title",
  ]);
}

function normalizeCoordinateAliases(
  command: string,
  params: ParamRecord,
): void {
  const wantsStartEnd =
    command === "drag" || command === "browser_drag" || command === "file_drag";

  if (hasOwnValue(params, "coordinate")) {
    const point = toPoint(params.coordinate);
    if (point) {
      params.coordinate = point;
    }
  }

  if (hasOwnValue(params, "startCoordinate")) {
    const point = toPoint(params.startCoordinate);
    if (point) {
      params.startCoordinate = point;
    }
  }

  setPointFromKeys(params, "startCoordinate", [
    "start_coordinate",
    "startPoint",
    "start_point",
    "fromCoordinate",
    "from_coordinate",
    "fromPoint",
    "from_point",
    "originCoordinate",
    "origin_coordinate",
  ]);

  setPointFromKeys(params, "coordinate", [
    "endCoordinate",
    "end_coordinate",
    "endPoint",
    "end_point",
    "targetCoordinate",
    "target_coordinate",
    "targetPoint",
    "target_point",
  ]);

  if (wantsStartEnd) {
    setPointAlias(params, "startCoordinate", START_POINT_ALIASES);
    setPointAlias(params, "coordinate", END_POINT_ALIASES);
  }

  const pointCommands = new Set([
    "click",
    "click_with_modifiers",
    "double_click",
    "right_click",
    "mouse_move",
    "scroll",
    "drag",
    "browser_click",
  ]);

  if (!pointCommands.has(command)) {
    return;
  }

  if (!hasOwnValue(params, "coordinate")) {
    setPointAlias(params, "coordinate", COORDINATE_ALIASES);
  }

  if (!hasOwnValue(params, "coordinate")) {
    setPointAlias(params, "coordinate", END_POINT_ALIASES);
  }
}

/**
 * Translate upstream-style parameters into the canonical shapes used by this
 * plugin. The input object is cloned and never mutated in place.
 */
export function normalizeComputerUseParams(
  command: string,
  params: ParamRecord | null | undefined = {},
): NormalizedComputerUseParams {
  const normalized = cloneParams(params);

  normalizePathAliases(normalized);
  normalizeEditAliases(normalized);
  normalizeTabAliases(command, normalized);
  normalizeWindowAliases(command, normalized);
  normalizeCoordinateAliases(command, normalized);

  return normalized;
}
