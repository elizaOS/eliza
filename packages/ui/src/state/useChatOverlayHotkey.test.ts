/**
 * Unit coverage for chat-overlay accelerator parsing/normalization from keyboard
 * events. Pure functions, no harness.
 */
import { describe, expect, it } from "vitest";
import {
  acceleratorFromKeyboardEvent,
  DEFAULT_CHAT_OVERLAY_ACCELERATOR,
  normalizeAccelerator,
  resolveChatOverlayHotkey,
} from "./useChatOverlayHotkey";

describe("normalizeAccelerator", () => {
  it("collapses whitespace and drops empty tokens", () => {
    expect(normalizeAccelerator(" CommandOrControl + Shift + C ")).toBe(
      "CommandOrControl+Shift+C",
    );
  });

  it("returns null when there are no usable tokens", () => {
    expect(normalizeAccelerator("")).toBeNull();
    expect(normalizeAccelerator("  +  + ")).toBeNull();
  });
});

describe("resolveChatOverlayHotkey", () => {
  it("falls back to the default for missing/malformed input", () => {
    const fallback = {
      accelerator: DEFAULT_CHAT_OVERLAY_ACCELERATOR,
      enabled: true,
    };
    expect(resolveChatOverlayHotkey(null)).toEqual(fallback);
    expect(resolveChatOverlayHotkey(undefined)).toEqual(fallback);
    expect(resolveChatOverlayHotkey("nope")).toEqual(fallback);
    expect(resolveChatOverlayHotkey(42)).toEqual(fallback);
  });

  it("keeps a valid accelerator and explicit enabled flag", () => {
    expect(
      resolveChatOverlayHotkey({
        accelerator: "CommandOrControl+J",
        enabled: false,
      }),
    ).toEqual({ accelerator: "CommandOrControl+J", enabled: false });
  });

  it("normalizes the stored accelerator and defaults enabled to true", () => {
    expect(resolveChatOverlayHotkey({ accelerator: " Alt + Space " })).toEqual({
      accelerator: "Alt+Space",
      enabled: true,
    });
  });

  it("replaces an empty accelerator with the default but keeps enabled", () => {
    expect(
      resolveChatOverlayHotkey({ accelerator: "", enabled: false }),
    ).toEqual({
      accelerator: DEFAULT_CHAT_OVERLAY_ACCELERATOR,
      enabled: false,
    });
  });
});

describe("acceleratorFromKeyboardEvent", () => {
  const base = {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  };

  it("returns null for modifier-only events", () => {
    for (const key of ["Control", "Meta", "Alt", "Shift"]) {
      expect(
        acceleratorFromKeyboardEvent({ ...base, key, ctrlKey: true }),
      ).toBeNull();
    }
  });

  it("maps Ctrl and Cmd to CommandOrControl", () => {
    expect(
      acceleratorFromKeyboardEvent({ ...base, key: "k", ctrlKey: true }),
    ).toBe("CommandOrControl+K");
    expect(
      acceleratorFromKeyboardEvent({ ...base, key: "k", metaKey: true }),
    ).toBe("CommandOrControl+K");
  });

  it("orders modifiers CommandOrControl, Alt, Shift and upper-cases single keys", () => {
    expect(
      acceleratorFromKeyboardEvent({
        ...base,
        key: "c",
        ctrlKey: true,
        altKey: true,
        shiftKey: true,
      }),
    ).toBe("CommandOrControl+Alt+Shift+C");
  });

  it("preserves named keys verbatim", () => {
    expect(
      acceleratorFromKeyboardEvent({ ...base, key: "Space", metaKey: true }),
    ).toBe("CommandOrControl+Space");
    expect(
      acceleratorFromKeyboardEvent({ ...base, key: "F5", shiftKey: true }),
    ).toBe("Shift+F5");
  });

  it("rejects a bare printable key with no modifier (would hijack it globally)", () => {
    expect(acceleratorFromKeyboardEvent({ ...base, key: "c" })).toBeNull();
    expect(acceleratorFromKeyboardEvent({ ...base, key: "1" })).toBeNull();
    // A named key may still bind on its own.
    expect(acceleratorFromKeyboardEvent({ ...base, key: "F5" })).toBe("F5");
    // Any modifier makes a printable key bindable again.
    expect(
      acceleratorFromKeyboardEvent({ ...base, key: "c", ctrlKey: true }),
    ).toBe("CommandOrControl+C");
  });
});
