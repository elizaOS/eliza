// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyUiAccent, loadUiAccentId, saveUiAccentId } from "./persistence";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT_ID,
  normalizeAccentId,
  resolveAccentColor,
} from "./ui-preferences";
import { useDisplayPreferences } from "./useDisplayPreferences";

const ACCENT_STORAGE_KEY = "eliza:ui-accent";

function rootAccent(): string {
  return document.documentElement.style.getPropertyValue("--accent");
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("style");
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute("style");
});

describe("accent presets — pure helpers", () => {
  it("exposes a curated, non-blue palette led by the brand default", () => {
    expect(ACCENT_PRESETS[0]).toMatchObject({ id: "default", color: null });
    // Every non-default preset is a concrete 6-digit hex.
    for (const preset of ACCENT_PRESETS.slice(1)) {
      expect(preset.color).toMatch(/^#[0-9a-f]{6}$/i);
    }
    // Brand rule #8796: no accent may read as blue (blue channel dominant).
    for (const preset of ACCENT_PRESETS) {
      if (!preset.color) continue;
      const n = Number.parseInt(preset.color.slice(1), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      expect(b).toBeLessThanOrEqual(Math.max(r, g));
    }
  });

  it("normalizes unknown/garbage ids to the default", () => {
    expect(normalizeAccentId("green")).toBe("green");
    expect(normalizeAccentId("not-a-real-id")).toBe(DEFAULT_ACCENT_ID);
    expect(normalizeAccentId(42)).toBe(DEFAULT_ACCENT_ID);
    expect(normalizeAccentId(null)).toBe(DEFAULT_ACCENT_ID);
  });

  it("resolves ids to colors; default resolves to null (brand accent)", () => {
    expect(resolveAccentColor("green")).toBe("#059669");
    expect(resolveAccentColor(DEFAULT_ACCENT_ID)).toBeNull();
    expect(resolveAccentColor("garbage")).toBeNull();
  });
});

describe("applyUiAccent — document root override", () => {
  it("sets the --accent family from a hex and derives rgb/hover/muted", () => {
    applyUiAccent("#059669");
    const style = document.documentElement.style;
    expect(style.getPropertyValue("--accent")).toBe("#059669");
    expect(style.getPropertyValue("--accent-rgb")).toBe("5, 150, 105");
    expect(style.getPropertyValue("--ring")).toBe("#059669");
    expect(style.getPropertyValue("--primary")).toBe("#059669");
    expect(style.getPropertyValue("--border-hover")).toBe("#059669");
    // Hover mixes toward white, muted toward black — both valid hex, distinct.
    expect(style.getPropertyValue("--accent-hover")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(style.getPropertyValue("--accent-muted")).toMatch(/^#[0-9a-f]{6}$/i);
    expect(style.getPropertyValue("--accent-subtle")).toBe(
      "rgba(5, 150, 105, 0.14)",
    );
  });

  it("clears every override when given null (restores the brand accent)", () => {
    applyUiAccent("#059669");
    expect(rootAccent()).toBe("#059669");
    applyUiAccent(null);
    expect(rootAccent()).toBe("");
    expect(document.documentElement.style.getPropertyValue("--ring")).toBe("");
    expect(
      document.documentElement.style.getPropertyValue("--accent-subtle"),
    ).toBe("");
  });

  it("clears (never sets a garbage value) for a malformed color", () => {
    applyUiAccent("#059669");
    applyUiAccent("not-a-hex");
    expect(rootAccent()).toBe("");
  });
});

describe("useDisplayPreferences — accent persistence", () => {
  it("defaults to the brand accent with no override applied", () => {
    const { result } = renderHook(() => useDisplayPreferences());
    expect(result.current.state.uiAccentId).toBe(DEFAULT_ACCENT_ID);
    // default => no inline --accent override (base.css / brand theme wins).
    expect(rootAccent()).toBe("");
  });

  it("applies + persists a chosen accent live", () => {
    const { result } = renderHook(() => useDisplayPreferences());
    act(() => {
      result.current.setUiAccent("green");
    });
    expect(result.current.state.uiAccentId).toBe("green");
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("green");
    expect(rootAccent()).toBe("#059669");
  });

  it("switching back to default clears the override + persists default", () => {
    const { result } = renderHook(() => useDisplayPreferences());
    act(() => {
      result.current.setUiAccent("rose");
    });
    expect(rootAccent()).toBe("#e11d48");
    act(() => {
      result.current.setUiAccent("default");
    });
    expect(result.current.state.uiAccentId).toBe("default");
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("default");
    expect(rootAccent()).toBe("");
  });

  it("coerces a garbage pick to the default (never persists junk)", () => {
    const { result } = renderHook(() => useDisplayPreferences());
    act(() => {
      result.current.setUiAccent("chartreuse-9000");
    });
    expect(result.current.state.uiAccentId).toBe(DEFAULT_ACCENT_ID);
    expect(localStorage.getItem(ACCENT_STORAGE_KEY)).toBe(DEFAULT_ACCENT_ID);
  });

  it("restores a persisted accent on the next mount", () => {
    saveUiAccentId("amber");
    expect(loadUiAccentId()).toBe("amber");
    const { result } = renderHook(() => useDisplayPreferences());
    expect(result.current.state.uiAccentId).toBe("amber");
    expect(rootAccent()).toBe("#f59e0b");
  });
});
