/**
 * Shared platform utilities for computer-use plugin.
 *
 * Ported from coasty-ai/open-computer-use desktop-automation.ts
 * and eliza sandbox-routes.ts (Apache 2.0 / MIT).
 */

import { execFileSync, execSync } from "node:child_process";
import { platform } from "node:os";

// ── Command Execution ───────────────────────────────────────────────────────

/**
 * Check if a CLI tool is available on the system.
 */
export function commandExists(cmd: string): boolean {
  try {
    const which = platform() === "win32" ? "where" : "which";
    execSync(`${which} ${cmd}`, { stdio: "ignore", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run a command via execFileSync (no shell) with timeout.
 * Throws on non-zero exit or timeout.
 */
export function runCommand(
  command: string,
  args: string[],
  timeout: number,
): string {
  const result = execFileSync(command, args, {
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  return result;
}

/**
 * Run a command via execFileSync, returning the raw Buffer stdout.
 */
export function runCommandBuffer(
  command: string,
  args: string[],
  timeout: number,
): void {
  execFileSync(command, args, {
    timeout,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Run a shell command string (uses shell). Use sparingly — prefer runCommand.
 */
export function runShellCommand(
  cmd: string,
  timeout: number,
): string {
  return execSync(cmd, {
    encoding: "utf-8",
    timeout,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

// ── Input Validation ────────────────────────────────────────────────────────

/**
 * Coerce a value to a safe integer to prevent shell injection via coordinates.
 * Ported from open-computer-use desktop-automation.ts validateInt().
 */
export function validateInt(val: unknown): number {
  if (val == null) {
    throw new Error(`Invalid numeric value: ${String(val)}`);
  }
  if (typeof val === "string" && val.trim() === "") {
    throw new Error("Invalid numeric value: ");
  }
  const n = Number(val);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid numeric value: ${String(val)}`);
  }
  return Math.round(n);
}

/**
 * Validate and clamp coordinates within screen bounds.
 */
export function validateCoordinate(
  x: number,
  y: number,
  maxX: number,
  maxY: number,
): [number, number] {
  const safeX = Math.max(0, Math.min(validateInt(x), maxX));
  const safeY = Math.max(0, Math.min(validateInt(y), maxY));
  return [safeX, safeY];
}

/**
 * Validate text input length to prevent abuse.
 */
export function validateText(text: string, maxLength = 4096): string {
  if (typeof text !== "string") {
    throw new Error("Text must be a string");
  }
  if (text.length > maxLength) {
    throw new Error(
      `Text too long: ${text.length} chars (max ${maxLength})`,
    );
  }
  return text;
}

// ── AppleScript Escaping ────────────────────────────────────────────────────

/**
 * Safely escape a string for use inside an AppleScript double-quoted literal.
 * Ported from open-computer-use desktop-automation.ts.
 */
export function escapeAppleScript(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// ── xdotool Key Validation ──────────────────────────────────────────────────

/**
 * Known-safe xdotool key names. Whitelist approach from open-computer-use.
 */
const SAFE_XDOTOOL_KEYS = new Set([
  "Return", "Tab", "Escape", "BackSpace", "Delete",
  "space", "Home", "End", "Page_Up", "Page_Down",
  "Left", "Right", "Up", "Down",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "shift", "Shift_L", "Shift_R",
  "ctrl", "Control_L", "Control_R",
  "alt", "Alt_L", "Alt_R",
  "super", "Super_L", "Super_R",
  "Meta_L", "Meta_R",
  "plus", "minus", "period", "comma", "slash", "backslash",
  "bracketleft", "bracketright", "semicolon", "apostrophe",
  "grave", "equal",
]);

/**
 * Validate a key name for xdotool. Must be a known key name or a single
 * printable ASCII character.
 */
export function safeXdotoolKey(key: string): string {
  const trimmed = key.trim();
  if (SAFE_XDOTOOL_KEYS.has(trimmed)) {
    return trimmed;
  }
  // Single printable ASCII character
  if (trimmed.length === 1 && trimmed.charCodeAt(0) >= 32 && trimmed.charCodeAt(0) <= 126) {
    return trimmed;
  }
  throw new Error(
    `Invalid key for xdotool: "${trimmed}". Use a known key name or single ASCII character.`,
  );
}

/**
 * Safe keypress pattern for general validation (matches sandbox-routes).
 */
const SAFE_KEYPRESS_PATTERN = /^[A-Za-z0-9+_ .,:\-]+$/;

export function validateKeypress(keys: string, maxLength = 128): string {
  if (typeof keys !== "string" || keys.length === 0) {
    throw new Error("Key input must be a non-empty string");
  }
  if (keys.length > maxLength) {
    throw new Error(`Key input too long: ${keys.length} chars (max ${maxLength})`);
  }
  if (!SAFE_KEYPRESS_PATTERN.test(keys)) {
    throw new Error(
      `Key input contains invalid characters: "${keys}". Only alphanumerics, +, _, ., ,, :, - and space allowed.`,
    );
  }
  return keys;
}

// ── Platform Detection ──────────────────────────────────────────────────────

export type PlatformOS = "darwin" | "linux" | "win32";

export function currentPlatform(): PlatformOS {
  const os = platform();
  if (os === "darwin" || os === "linux" || os === "win32") {
    return os;
  }
  throw new Error(`Unsupported platform: ${os}`);
}

// ── Key alias normalization (used by platform-specific keyboard bridges) ───

const ALIAS_TO_CANONICAL: Record<string, string> = {
  escape: "escape",
  esc: "escape",
  return: "enter",
  enter: "enter",
  arrowup: "up",
  arrow_up: "up",
  arrowdown: "down",
  arrow_down: "down",
  arrowleft: "left",
  arrow_left: "left",
  arrowright: "right",
  arrow_right: "right",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  page_up: "pageup",
  pageup: "pageup",
  pagedown: "pagedown",
  page_down: "pagedown",
  next: "pagedown",
  prior: "pageup",
  tab: "tab",
  space: "space",
  backspace: "backspace",
  delete: "delete",
  insert: "insert",
  home: "home",
  end: "end",
};

/**
 * Map UI / OS / driver-specific key names to a single canonical name.
 */
export function canonicalKeyName(raw: string): string {
  const key = raw.trim();
  if (!key) {
    return key;
  }
  const bySeparators = key.replaceAll(/[-_\s]+/g, " ").toLowerCase();
  const asUnderscore = bySeparators.replaceAll(" ", "_");
  if (ALIAS_TO_CANONICAL[asUnderscore] !== undefined) {
    return ALIAS_TO_CANONICAL[asUnderscore];
  }
  const noUnderscore = asUnderscore.replaceAll("_", "");
  if (ALIAS_TO_CANONICAL[noUnderscore] !== undefined) {
    return ALIAS_TO_CANONICAL[noUnderscore];
  }
  return asUnderscore;
}

/** macOS `cliclick` key name for a canonical or alias key. */
export function toCliclickKeyName(raw: string): string {
  const c = canonicalKeyName(raw);
  if (c === "escape") {
    return "esc";
  }
  if (c === "pagedown") {
    return "pagedn";
  }
  if (c === "enter") {
    return "return";
  }
  return c;
}

/** Linux xdotool / Windows `xdotool key` name. */
export function toXdotoolKeyName(raw: string): string {
  const c = canonicalKeyName(raw);
  if (c === "escape") {
    return "Escape";
  }
  if (c === "enter") {
    return "Return";
  }
  if (c === "up" || c === "down" || c === "left" || c === "right") {
    return c.charAt(0).toUpperCase() + c.slice(1);
  }
  if (c === "pagedown" || c === "pageup") {
    return c === "pagedown" ? "Page_Down" : "Page_Up";
  }
  if (c === "tab") {
    return "Tab";
  }
  return c;
}

/** Windows `SendKeys`-style for automation helpers. */
export function toWindowsSendKey(raw: string): string {
  const t = raw.trim();
  if (/^F\d+$/i.test(t)) {
    return `{${t.toUpperCase()}}`;
  }
  const c = canonicalKeyName(raw);
  if (c === "escape") {
    return "{ESC}";
  }
  return `{${c.toUpperCase()}}`;
}
