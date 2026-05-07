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
import { createRequire } from "node:module";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScreenRegion } from "../types.js";
import { canonicalKeyName, validateInt, validateText } from "./helpers.js";

const requireFromHere = createRequire(import.meta.url);

interface NutModule {
  mouse: {
    config: { mouseSpeed: number; autoDelayMs: number };
    setPosition: (point: { x: number; y: number }) => Promise<unknown>;
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
  straightTo: (
    target: { x: number; y: number },
  ) => Promise<unknown> | unknown;
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

export async function nutMouseMove(x: number, y: number): Promise<void> {
  const m = nut();
  await m.mouse.setPosition(new m.Point(validateInt(x), validateInt(y)));
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
    await m.mouse.move(m.straightTo(new m.Point(sx2, sy2)));
  } finally {
    await m.mouse.releaseButton(m.Button.LEFT);
  }
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
  const clicks = Math.max(1, Math.min(validateInt(amount), 20));
  await m.mouse.setPosition(new m.Point(sx, sy));
  if (direction === "up") await m.mouse.scrollUp(clicks);
  else if (direction === "down") await m.mouse.scrollDown(clicks);
  else if (direction === "left") await m.mouse.scrollLeft(clicks);
  else await m.mouse.scrollRight(clicks);
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
    throw new Error(`Combo "${combo}" must include at least one non-modifier key`);
  }
  const mainCode = resolveKeyCode(mainKey);
  await m.keyboard.pressKey(...modifierCodes, mainCode);
  await m.keyboard.releaseKey(mainCode, ...modifierCodes.reverse());
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
        /* best effort */
      }
    }
  }
}

export async function nutScreenSize(): Promise<{ width: number; height: number }> {
  const m = nut();
  const [width, height] = await Promise.all([m.screen.width(), m.screen.height()]);
  return { width, height };
}
