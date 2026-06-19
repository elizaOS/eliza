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
export function runShellCommand(cmd: string, timeout: number): string {
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
  if (val === null || val === undefined) {
    throw new Error(`Invalid numeric value: ${String(val)}`);
  }
  if (typeof val === "string" && val.trim().length === 0) {
    throw new Error(`Invalid numeric value: ${String(val)}`);
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
 * Validate a window/process identifier before interpolating it into a
 * platform shell command (AppleScript / PowerShell). Rejects anything that
 * is not a decimal integer or `0x`-prefixed hex, preventing escape out of
 * the surrounding script literal.
 */
export function validateWindowId(windowId: string): string {
  if (typeof windowId !== "string") {
    throw new Error(`Invalid windowId: must be string, got ${typeof windowId}`);
  }
  const trimmed = windowId.trim();
  if (!/^[0-9]+$/.test(trimmed) && !/^0x[0-9a-f]+$/i.test(trimmed)) {
    throw new Error(
      `Invalid windowId: must be numeric or 0x-prefixed hex, got "${windowId}"`,
    );
  }
  return trimmed;
}

/**
 * Validate text input length to prevent abuse.
 */
export function validateText(text: string, maxLength = 4096): string {
  if (typeof text !== "string") {
    throw new Error("Text must be a string");
  }
  if (text.length > maxLength) {
    throw new Error(`Text too long: ${text.length} chars (max ${maxLength})`);
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
  "Return",
  "Tab",
  "Escape",
  "BackSpace",
  "Delete",
  "space",
  "Home",
  "End",
  "Page_Up",
  "Page_Down",
  "Left",
  "Right",
  "Up",
  "Down",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
  "shift",
  "Shift_L",
  "Shift_R",
  "ctrl",
  "Control_L",
  "Control_R",
  "alt",
  "Alt_L",
  "Alt_R",
  "super",
  "Super_L",
  "Super_R",
  "Meta_L",
  "Meta_R",
  "plus",
  "minus",
  "period",
  "comma",
  "slash",
  "backslash",
  "bracketleft",
  "bracketright",
  "semicolon",
  "apostrophe",
  "grave",
  "equal",
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
  if (
    trimmed.length === 1 &&
    trimmed.charCodeAt(0) >= 32 &&
    trimmed.charCodeAt(0) <= 126
  ) {
    return trimmed;
  }
  throw new Error(
    `Invalid key for xdotool: "${trimmed}". Use a known key name or single ASCII character.`,
  );
}

/**
 * Safe keypress pattern for general validation (matches sandbox-routes).
 */
const SAFE_KEYPRESS_PATTERN = /^[A-Za-z0-9+_ .,:-]+$/;

export function validateKeypress(keys: string, maxLength = 128): string {
  if (typeof keys !== "string" || keys.length === 0) {
    throw new Error("Key input must be a non-empty string");
  }
  if (keys.length > maxLength) {
    throw new Error(
      `Key input too long: ${keys.length} chars (max ${maxLength})`,
    );
  }
  if (!SAFE_KEYPRESS_PATTERN.test(keys)) {
    throw new Error(
      `Key input contains invalid characters: "${keys}". Only alphanumerics, +, _, ., ,, :, - and space allowed.`,
    );
  }
  return keys;
}

// ── Key Normalization ───────────────────────────────────────────────────────

const CANONICAL_KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  escape: "escape",
  return: "enter",
  enter: "enter",
  spacebar: "space",
  space: "space",
  tab: "tab",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
  pageup: "pageup",
  pagedown: "pagedown",
  home: "home",
  end: "end",
  del: "delete",
  delete: "delete",
  backspace: "backspace",
};

function normalizeKeyAlias(key: string): string {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new Error("Key input must be a non-empty string");
  }
  return key
    .trim()
    .toLowerCase()
    .replace(/^arrow/, "")
    .replace(/[\s_-]+/g, "");
}

export function canonicalKeyName(key: string): string {
  const normalized = normalizeKeyAlias(key);
  if (/^f\d{1,2}$/.test(normalized)) {
    return normalized;
  }
  return CANONICAL_KEY_ALIASES[normalized] ?? normalized;
}

const CLICLICK_KEY_NAMES: Record<string, string> = {
  escape: "esc",
  enter: "return",
  up: "arrow-up",
  down: "arrow-down",
  left: "arrow-left",
  right: "arrow-right",
  pageup: "page-up",
  pagedown: "page-down",
  backspace: "delete",
  delete: "fwd-delete",
  home: "home",
  end: "end",
  space: "space",
  tab: "tab",
};

export function toCliclickKeyName(key: string): string {
  const canonical = canonicalKeyName(key);
  return CLICLICK_KEY_NAMES[canonical] ?? canonical;
}

const XDOTOOL_KEY_NAMES: Record<string, string> = {
  escape: "Escape",
  enter: "Return",
  tab: "Tab",
  backspace: "BackSpace",
  delete: "Delete",
  space: "space",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  left: "Left",
  right: "Right",
  up: "Up",
  down: "Down",
};

export function toXdotoolKeyName(key: string): string {
  const canonical = canonicalKeyName(key);
  if (/^f\d{1,2}$/.test(canonical)) {
    return canonical.toUpperCase();
  }
  return XDOTOOL_KEY_NAMES[canonical] ?? key.trim();
}

const WINDOWS_SEND_KEYS: Record<string, string> = {
  escape: "{ESC}",
  enter: "{ENTER}",
  tab: "{TAB}",
  backspace: "{BACKSPACE}",
  delete: "{DELETE}",
  home: "{HOME}",
  end: "{END}",
  pageup: "{PGUP}",
  pagedown: "{PGDN}",
  left: "{LEFT}",
  right: "{RIGHT}",
  up: "{UP}",
  down: "{DOWN}",
  space: " ",
};

export function toWindowsSendKey(key: string): string {
  const canonical = canonicalKeyName(key);
  if (/^f\d{1,2}$/.test(canonical)) {
    return `{${canonical.toUpperCase()}}`;
  }
  return WINDOWS_SEND_KEYS[canonical] ?? key.trim();
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
