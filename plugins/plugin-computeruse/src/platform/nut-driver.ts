/**
 * Cross-platform desktop driver backed by @nut-tree-fork/nut-js.
 *
 * Wraps native libnut bindings into the same input surface exposed by
 * the legacy per-OS shell drivers in `desktop.ts` and `screenshot.ts`.
 * Selected at runtime via `ELIZA_COMPUTERUSE_DRIVER=nutjs` (default) — the
 * legacy shell drivers remain the fallback when the env var is set to
 * `legacy` or when the native module fails to load.
 *
 * Native module loading: nut-js ships prebuilt binaries via `libnut`. We
 * load it eagerly at module init and surface a clean diagnostic if the
 * binary is missing for the current arch (`isAvailable()` reports false).
 */

import { readFileSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {} from "@nut-tree-fork/nut-js";
import type { ScreenRegion } from "../types.js";
import { canonicalKeyName, validateInt, validateText } from "./helpers.js";

const requireFromHere = createRequire(import.meta.url);

interface NutModule {
  mouse: {
    config: { mouseSpeed: number; autoDelayMs: number };
    setPosition: (point: { x: number; y: number }) => Promise<unknown>;
    getPosition: () => Promise<{ x: number; y: number }>;
    move: (path: Promise<unknown> | unknown) => Promise<unknown>;
    click: (button: number) => Promise<unknown>;
    doubleClick: (button: number) => Promise<unknown>;
    pressButton: (button: number) => Promise<unknown>;
    releaseButton: (button: number) => Promise<unknown>;
    scrollUp: (amount: number) => Promise<unknown>;
    scrollDown: (amount: number) => Promise<unknown>;
    scrollLeft: (amount: number) => Promise<unknown>;
    scrollRight: (amount: number) => Promise<unknown>;
  };
  keyboard: {
    config: { autoDelayMs: number };
    type: (input: string) => Promise<unknown>;
    pressKey: (...keys: number[]) => Promise<unknown>;
    releaseKey: (...keys: number[]) => Promise<unknown>;
  };
  screen: {
    width: () => Promise<number>;
    height: () => Promise<number>;
    capture: (
      fileName: string,
      fileFormat: number,
      filePath?: string,
    ) => Promise<string>;
    captureRegion: (
      fileName: string,
      region: { left: number; top: number; width: number; height: number },
      fileFormat: number,
      filePath?: string,
    ) => Promise<string>;
  };
  Button: { LEFT: number; MIDDLE: number; RIGHT: number };
  Key: Record<string, number>;
  Point: new (x: number, y: number) => { x: number; y: number };
  straightTo: (target: { x: number; y: number }) => Promise<unknown> | unknown;
  FileType: { PNG: number; JPG: number };
}

let cachedModule: NutModule | null = null;
let loadError: Error | null = null;

function loadNut(): NutModule | null {
  if (cachedModule !== null) return cachedModule;
  if (loadError !== null) return null;
  try {
    const mod = requireFromHere("@nut-tree-fork/nut-js") as NutModule;
    mod.mouse.config.mouseSpeed = 1000;
    mod.mouse.config.autoDelayMs = 0;
    mod.keyboard.config.autoDelayMs = 0;
    cachedModule = mod;
    return mod;
  } catch (err) {
    // error-policy:J3 native-module availability probe; null signals
    // "nutjs unavailable" and the cause is preserved in loadError, surfaced
    // by loadFailureReason() in the driver-selection warn.
    loadError = err instanceof Error ? err : new Error(String(err));
    return null;
  }
}

export function isAvailable(): boolean {
  return loadNut() !== null;
}

export function loadFailureReason(): string | null {
  if (cachedModule) return null;
  loadNut();
  return loadError ? loadError.message : null;
}

function nut(): NutModule {
  const m = loadNut();
  if (!m) {
    throw new Error(
      `nutjs driver unavailable: ${loadError?.message ?? "module did not load"}`,
    );
  }
  return m;
}

const MODIFIER_KEYS: Record<string, string[]> = {
  cmd: ["LeftSuper"],
  command: ["LeftSuper"],
  meta: ["LeftSuper"],
  super: ["LeftSuper"],
  win: ["LeftSuper"],
  ctrl: ["LeftControl"],
  control: ["LeftControl"],
  alt: ["LeftAlt"],
  option: ["LeftAlt"],
  shift: ["LeftShift"],
};

const NAMED_KEY_TO_NUT: Record<string, string> = {
  enter: "Return",
  return: "Return",
  tab: "Tab",
  space: "Space",
  escape: "Escape",
  esc: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  forwarddelete: "Delete",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
};

function resolveKeyCode(key: string): number {
  const m = nut();
  const canonical = canonicalKeyName(key);
  // Function keys F1..F24
  const fnMatch = canonical.match(/^f(\d{1,2})$/);
  if (fnMatch) {
    const name = `F${fnMatch[1]}`;
    const code = m.Key[name];
    if (code !== undefined) return code;
  }
  const mapped = NAMED_KEY_TO_NUT[canonical];
  if (mapped !== undefined) {
    const code = m.Key[mapped];
    if (code !== undefined) return code;
  }
  // Modifier names (shift / ctrl / alt / cmd / meta / super / win) — needed so
  // key_down/key_up can hold a bare modifier. These live in MODIFIER_KEYS as
  // nutjs Key names (e.g. "LeftShift"); resolve to the left-hand variant.
  const modifierNames =
    MODIFIER_KEYS[canonical] ?? MODIFIER_KEYS[key.trim().toLowerCase()];
  if (modifierNames && modifierNames.length > 0) {
    const code = m.Key[modifierNames[0]];
    if (code !== undefined) return code;
  }
  // Single character — map A-Z / 0-9 directly via Key enum
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (m.Key[upper] !== undefined) return m.Key[upper];
    const digitName = `Num${key}`;
    if (m.Key[digitName] !== undefined) return m.Key[digitName];
  }
  // Last resort: lookup by raw name as-typed
  const raw = m.Key[key];
  if (raw !== undefined) return raw;
  throw new Error(`Unsupported key for nutjs driver: "${key}"`);
}

/** Resolve a POSIX-style button name to the nutjs `Button` enum value. Pure-ish
 * (reads the loaded module). Throws on an unknown button. */
function resolveButton(button: "left" | "middle" | "right"): number {
  const m = nut();
  switch (button) {
    case "left":
      return m.Button.LEFT;
    case "middle":
      return m.Button.MIDDLE;
    case "right":
      return m.Button.RIGHT;
    default:
      throw new Error(`Unsupported mouse button: "${button}"`);
  }
}

function resolveModifierCodes(modifier: string): number[] {
  const m = nut();
  const names = MODIFIER_KEYS[modifier.trim().toLowerCase()];
  if (!names) {
    throw new Error(`Unsupported modifier: "${modifier}"`);
  }
  return names.map((name) => {
    const code = m.Key[name];
    if (code === undefined) {
      throw new Error(`nutjs Key enum missing entry for "${name}"`);
    }
    return code;
  });
}

// ── Mouse ───────────────────────────────────────────────────────────────────

export async function nutClick(x: number, y: number): Promise<void> {
  const m = nut();
  const sx = validateInt(x);
  const sy = validateInt(y);
  await m.mouse.setPosition(new m.Point(sx, sy));
  await m.mouse.click(m.Button.LEFT);
}

export async function nutClickWithModifiers(
  x: number,
  y: number,
  modifiers: string[],
): Promise<void> {
  const m = nut();
  const sx = validateInt(x);
  const sy = validateInt(y);
  const modCodes = modifiers.flatMap((mod) => resolveModifierCodes(mod));
  await m.mouse.setPosition(new m.Point(sx, sy));
  if (modCodes.length === 0) {
    await m.mouse.click(m.Button.LEFT);
    return;
  }
  await m.keyboard.pressKey(...modCodes);
  try {
    await m.mouse.click(m.Button.LEFT);
  } finally {
    await m.keyboard.releaseKey(...modCodes.reverse());
  }
}

export async function nutDoubleClick(x: number, y: number): Promise<void> {
  const m = nut();
  await m.mouse.setPosition(new m.Point(validateInt(x), validateInt(y)));
  await m.mouse.doubleClick(m.Button.LEFT);
}

export async function nutRightClick(x: number, y: number): Promise<void> {
  const m = nut();
  await m.mouse.setPosition(new m.Point(validateInt(x), validateInt(y)));
  await m.mouse.click(m.Button.RIGHT);
}

export async function nutMiddleClick(x: number, y: number): Promise<void> {
  const m = nut();
  await m.mouse.setPosition(new m.Point(validateInt(x), validateInt(y)));
  await m.mouse.click(m.Button.MIDDLE);
}

export async function nutMouseMove(x: number, y: number): Promise<void> {
  const m = nut();
  await m.mouse.setPosition(new m.Point(validateInt(x), validateInt(y)));
}

/**
 * Press (and hold) a mouse button at `(x, y)` without releasing it. Pairs with
 * `nutMouseUp` to express hold-drags, marquee selection, and press-and-hold
 * gestures that a single `click` cannot. The caller is responsible for the
 * matching release.
 */
export async function nutMouseDown(
  x: number,
  y: number,
  button: "left" | "middle" | "right" = "left",
): Promise<void> {
  const m = nut();
  await m.mouse.setPosition(new m.Point(validateInt(x), validateInt(y)));
  await m.mouse.pressButton(resolveButton(button));
}

/** Release a previously-held mouse button at `(x, y)`. See {@link nutMouseDown}. */
export async function nutMouseUp(
  x: number,
  y: number,
  button: "left" | "middle" | "right" = "left",
): Promise<void> {
  const m = nut();
  await m.mouse.setPosition(new m.Point(validateInt(x), validateInt(y)));
  await m.mouse.releaseButton(resolveButton(button));
}

/** Inter-notch / inter-step pacing (ms) — small, just enough to defeat event
 * coalescing in fast consumers (e.g. Chromium's MouseWheelEventQueue) without
 * making input feel sluggish. */
const SCROLL_NOTCH_DELAY_MS = 8;
const DRAG_STEP_DELAY_MS = 8;
const DRAG_STEPS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Clamp a requested scroll amount to a safe per-notch count (1..20). Pure. */
export function clampScrollNotches(amount: number): number {
  return Math.max(1, Math.min(validateInt(amount), 20));
}

/**
 * Interpolated integer waypoints from (x1,y1) to (x2,y2) over `steps` moves
 * (excludes the start, includes the end). Pure — exported for unit tests.
 */
export function interpolateDragSteps(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  steps: number = DRAG_STEPS,
): Array<{ x: number; y: number }> {
  const n = Math.max(1, Math.floor(steps));
  const points: Array<{ x: number; y: number }> = [];
  for (let i = 1; i <= n; i += 1) {
    const t = i / n;
    points.push({
      x: Math.round(x1 + (x2 - x1) * t),
      y: Math.round(y1 + (y2 - y1) * t),
    });
  }
  return points;
}

async function manualDragMove(
  m: NutModule,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Promise<void> {
  // Interpolated move with the button held — fallback for libnut builds whose
  // `mouse.move(straightTo)` does not carry a real button-down on Windows.
  const points = interpolateDragSteps(x1, y1, x2, y2);
  for (let i = 0; i < points.length; i += 1) {
    await m.mouse.setPosition(new m.Point(points[i].x, points[i].y));
    if (i < points.length - 1) await sleep(DRAG_STEP_DELAY_MS);
  }
}

export async function nutDrag(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Promise<void> {
  const m = nut();
  const sx1 = validateInt(x1);
  const sy1 = validateInt(y1);
  const sx2 = validateInt(x2);
  const sy2 = validateInt(y2);
  await m.mouse.setPosition(new m.Point(sx1, sy1));
  await m.mouse.pressButton(m.Button.LEFT);
  try {
    try {
      await m.mouse.move(m.straightTo(new m.Point(sx2, sy2)));
    } catch {
      // error-policy:J4 designed two-tier drag — manualDragMove performs the
      // same motion via interpolated setPosition steps, and its failure
      // throws to the caller.
      await manualDragMove(m, sx1, sy1, sx2, sy2);
    }
  } finally {
    await m.mouse.releaseButton(m.Button.LEFT);
  }
}

/**
 * Densify a polyline by interpolating integer waypoints along every segment so
 * a held-button drag traces curves/corners instead of teleporting corner to
 * corner. Includes the very first point and every segment endpoint. Pure —
 * exported for unit tests.
 *
 * `perSegmentSteps` controls how many intermediate points are inserted between
 * consecutive vertices (≥1; the endpoint is always included).
 */
export function densifyDragPath(
  path: Array<{ x: number; y: number }>,
  perSegmentSteps: number = DRAG_STEPS,
): Array<{ x: number; y: number }> {
  if (path.length === 0) return [];
  const first = { x: validateInt(path[0].x), y: validateInt(path[0].y) };
  const out: Array<{ x: number; y: number }> = [first];
  for (let i = 1; i < path.length; i += 1) {
    const a = out[out.length - 1];
    const b = { x: validateInt(path[i].x), y: validateInt(path[i].y) };
    out.push(...interpolateDragSteps(a.x, a.y, b.x, b.y, perSegmentSteps));
  }
  return out;
}

/**
 * Press the left button at the first point, move through every interpolated
 * waypoint with the button held, then release at the last point. Backs
 * multi-point `drag(path)` and AOSP swipe paths. Requires ≥2 points.
 */
export async function nutDragPath(
  path: Array<{ x: number; y: number }>,
): Promise<void> {
  if (path.length < 2) {
    throw new Error("nutDragPath requires at least two points");
  }
  const m = nut();
  const points = densifyDragPath(path);
  const start = points[0];
  const end = points[points.length - 1];
  await m.mouse.setPosition(new m.Point(start.x, start.y));
  await m.mouse.pressButton(m.Button.LEFT);
  try {
    for (let i = 1; i < points.length; i += 1) {
      await m.mouse.setPosition(new m.Point(points[i].x, points[i].y));
      if (i < points.length - 1) await sleep(DRAG_STEP_DELAY_MS);
    }
  } finally {
    await m.mouse.setPosition(new m.Point(end.x, end.y));
    await m.mouse.releaseButton(m.Button.LEFT);
  }
}

export async function nutGetCursorPosition(): Promise<{
  x: number;
  y: number;
}> {
  const m = nut();
  const p = await m.mouse.getPosition();
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

export async function nutScroll(
  x: number,
  y: number,
  direction: "up" | "down" | "left" | "right",
  amount: number,
): Promise<void> {
  const m = nut();
  const sx = validateInt(x);
  const sy = validateInt(y);
  const clicks = clampScrollNotches(amount);
  await m.mouse.setPosition(new m.Point(sx, sy));
  // Emit one wheel notch at a time so coalescing consumers register each notch.
  for (let i = 0; i < clicks; i += 1) {
    if (direction === "up") await m.mouse.scrollUp(1);
    else if (direction === "down") await m.mouse.scrollDown(1);
    else if (direction === "left") await m.mouse.scrollLeft(1);
    else await m.mouse.scrollRight(1);
    if (i < clicks - 1) await sleep(SCROLL_NOTCH_DELAY_MS);
  }
}

// ── Keyboard ────────────────────────────────────────────────────────────────

export async function nutType(text: string): Promise<void> {
  const m = nut();
  const safe = validateText(text);
  await m.keyboard.type(safe);
}

export async function nutKeyPress(key: string): Promise<void> {
  const m = nut();
  const code = resolveKeyCode(key);
  await m.keyboard.pressKey(code);
  await m.keyboard.releaseKey(code);
}

/** Press (and hold) a single key without releasing it. Pairs with `nutKeyUp`
 * to express press-and-hold (e.g. holding Shift while issuing other input). */
export async function nutKeyDown(key: string): Promise<void> {
  const m = nut();
  await m.keyboard.pressKey(resolveKeyCode(key));
}

/** Release a previously-held key. See {@link nutKeyDown}. */
export async function nutKeyUp(key: string): Promise<void> {
  const m = nut();
  await m.keyboard.releaseKey(resolveKeyCode(key));
}

export async function nutKeyCombo(combo: string): Promise<void> {
  const m = nut();
  const parts = combo.split("+").map((p) => p.trim());
  const modifierCodes: number[] = [];
  let mainKey: string | null = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (MODIFIER_KEYS[lower]) {
      modifierCodes.push(...resolveModifierCodes(lower));
    } else {
      mainKey = part;
    }
  }
  if (!mainKey) {
    throw new Error(
      `Combo "${combo}" must include at least one non-modifier key`,
    );
  }
  const mainCode = resolveKeyCode(mainKey);
  if (modifierCodes.length > 0) {
    await m.keyboard.pressKey(...modifierCodes);
  }
  try {
    await m.keyboard.pressKey(mainCode);
    await m.keyboard.releaseKey(mainCode);
  } finally {
    if (modifierCodes.length > 0) {
      await m.keyboard.releaseKey(...modifierCodes.reverse());
    }
  }
}

// ── Screenshot ──────────────────────────────────────────────────────────────

export async function nutCaptureScreenshot(
  region?: ScreenRegion,
): Promise<Buffer> {
  const m = nut();
  const fileName = `computeruse-nutjs-${Date.now()}.png`;
  const dir = tmpdir();
  let absolutePath = "";
  try {
    if (region) {
      const r = {
        left: validateInt(region.x),
        top: validateInt(region.y),
        width: validateInt(region.width),
        height: validateInt(region.height),
      };
      absolutePath = await m.screen.captureRegion(
        fileName,
        r,
        m.FileType.PNG,
        dir,
      );
    } else {
      absolutePath = await m.screen.capture(fileName, m.FileType.PNG, dir);
    }
    if (!absolutePath) absolutePath = join(dir, fileName);
    return readFileSync(absolutePath);
  } finally {
    if (absolutePath) {
      try {
        unlinkSync(absolutePath);
      } catch {
        // error-policy:J6 best-effort temp-file teardown; the capture result
        // has already been read into memory.
      }
    }
  }
}

export async function nutScreenSize(): Promise<{
  width: number;
  height: number;
}> {
  const m = nut();
  const [width, height] = await Promise.all([
    m.screen.width(),
    m.screen.height(),
  ]);
  return { width, height };
}
