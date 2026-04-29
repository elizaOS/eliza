// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getShortcutLabel,
  matchesShortcut,
} from "./useSecretsManagerShortcut";

/**
 * Tests for `matchesShortcut` and `getShortcutLabel`.
 *
 * The shortcut helpers branch on `navigator.platform`. We override it
 * per-test via `Object.defineProperty` and reset between tests so each
 * case starts from a known platform.
 */

const ORIGINAL_PLATFORM = navigator.platform;

function setPlatform(value: string): void {
  Object.defineProperty(navigator, "platform", {
    value,
    configurable: true,
  });
}

function macEvent(overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "v",
    code: "KeyV",
    metaKey: true,
    altKey: true,
    ctrlKey: true,
    shiftKey: false,
    ...overrides,
  });
}

function winEvent(overrides: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent("keydown", {
    key: "v",
    code: "KeyV",
    ctrlKey: true,
    altKey: true,
    shiftKey: true,
    metaKey: false,
    ...overrides,
  });
}

afterEach(() => {
  setPlatform(ORIGINAL_PLATFORM);
});

describe("matchesShortcut on macOS", () => {
  beforeEach(() => {
    setPlatform("MacIntel");
  });

  it("matches the Mac chord (⌘⌥⌃V)", () => {
    expect(matchesShortcut(macEvent())).toBe(true);
  });

  it("rejects the Mac chord when shiftKey is also held (extra modifier)", () => {
    expect(matchesShortcut(macEvent({ shiftKey: true }))).toBe(false);
  });

  it("rejects the Mac chord when metaKey is missing", () => {
    expect(matchesShortcut(macEvent({ metaKey: false }))).toBe(false);
  });

  it("rejects the Win/Linux chord on Mac (no metaKey + shiftKey is the wrong shape)", () => {
    expect(matchesShortcut(winEvent())).toBe(false);
  });

  it("rejects when the key is not V", () => {
    expect(matchesShortcut(macEvent({ key: "x", code: "KeyX" }))).toBe(false);
  });
});

describe("matchesShortcut on Windows / Linux", () => {
  beforeEach(() => {
    setPlatform("Win32");
  });

  it("matches the Win/Linux chord (Ctrl+Alt+Shift+V)", () => {
    expect(matchesShortcut(winEvent())).toBe(true);
  });

  it("rejects the Mac chord on non-Mac platforms", () => {
    expect(matchesShortcut(macEvent())).toBe(false);
  });

  it("rejects the Win/Linux chord without shiftKey", () => {
    expect(matchesShortcut(winEvent({ shiftKey: false }))).toBe(false);
  });

  it("rejects when the key is not V (all modifiers held)", () => {
    expect(matchesShortcut(winEvent({ key: "x", code: "KeyX" }))).toBe(false);
  });
});

describe("getShortcutLabel", () => {
  it("returns ⌘⌥⌃V on Mac", () => {
    setPlatform("MacIntel");
    expect(getShortcutLabel()).toBe("⌘⌥⌃V");
  });

  it("returns Ctrl+Alt+Shift+V on non-Mac", () => {
    setPlatform("Win32");
    expect(getShortcutLabel()).toBe("Ctrl+Alt+Shift+V");
  });
});
