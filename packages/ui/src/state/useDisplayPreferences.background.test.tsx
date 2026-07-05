// @vitest-environment jsdom
/**
 * Background config + undo/redo history in `useDisplayPreferences`: the
 * versioned push/undo/redo semantics, the history/data-URL caps, and
 * home-time-widget visibility persistence. Real hook under jsdom + real
 * `localStorage`.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadBackgroundConfig,
  loadBackgroundHistory,
  loadBackgroundRedo,
  loadHomeTimeWidgetHidden,
  MAX_BACKGROUND_HISTORY,
  MAX_BACKGROUND_HISTORY_DATA_URLS,
  normalizeBackgroundHistory,
  saveHomeTimeWidgetHidden,
} from "./persistence";
import {
  DEFAULT_BACKGROUND_COLOR,
  DEFAULT_BACKGROUND_CONFIG,
  makeGlslConfig,
} from "./ui-preferences";
import { useDisplayPreferences } from "./useDisplayPreferences";

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("useDisplayPreferences — background history + undo", () => {
  it("starts on the boot default (curated image) with nothing to undo", () => {
    const { result } = renderHook(() => useDisplayPreferences());
    // #13538: the boot default is now the curated "Ember Night" image, not a
    // flat shader color.
    expect(result.current.state.backgroundConfig).toEqual(
      DEFAULT_BACKGROUND_CONFIG,
    );
    expect(result.current.state.canUndoBackground).toBe(false);
  });

  it("set pushes the previous config onto the undo stack", () => {
    const { result } = renderHook(() => useDisplayPreferences());
    act(() => {
      result.current.setBackgroundConfig({ mode: "shader", color: "#059669" });
    });
    expect(result.current.state.backgroundConfig.color).toBe("#059669");
    expect(result.current.state.canUndoBackground).toBe(true);
  });

  it("undo restores the previous config and pops the stack", () => {
    const { result } = renderHook(() => useDisplayPreferences());
    act(() => {
      result.current.setBackgroundConfig({ mode: "shader", color: "#059669" });
    });
    act(() => {
      result.current.setBackgroundConfig({ mode: "shader", color: "#e11d48" });
    });
    act(() => {
      result.current.undoBackgroundConfig();
    });
    expect(result.current.state.backgroundConfig.color).toBe("#059669");
    act(() => {
      result.current.undoBackgroundConfig();
    });
    expect(result.current.state.backgroundConfig.color).toBe(
      DEFAULT_BACKGROUND_COLOR,
    );
    expect(result.current.state.canUndoBackground).toBe(false);
  });

  it("redo re-applies an undone config, then a new edit clears the redo future (#10694)", () => {
    const { result } = renderHook(() => useDisplayPreferences());
    expect(result.current.state.canRedoBackground).toBe(false);
    act(() => {
      result.current.setBackgroundConfig({ mode: "shader", color: "#059669" });
    });
    act(() => {
      result.current.setBackgroundConfig({ mode: "shader", color: "#e11d48" });
    });
    // undo #e11d48 → back to #059669; the undone config is now redoable.
    act(() => {
      result.current.undoBackgroundConfig();
    });
    expect(result.current.state.backgroundConfig.color).toBe("#059669");
    expect(result.current.state.canRedoBackground).toBe(true);
    // redo → forward to #e11d48 again.
    act(() => {
      result.current.redoBackgroundConfig();
    });
    expect(result.current.state.backgroundConfig.color).toBe("#e11d48");
    expect(result.current.state.canRedoBackground).toBe(false);
    // a fresh edit after an undo invalidates the redo future.
    act(() => {
      result.current.undoBackgroundConfig();
    });
    expect(result.current.state.canRedoBackground).toBe(true);
    act(() => {
      result.current.setBackgroundConfig({ mode: "shader", color: "#2563eb" });
    });
    expect(result.current.state.canRedoBackground).toBe(false);
  });

  it("redo is a no-op with nothing undone (#10694)", () => {
    const { result } = renderHook(() => useDisplayPreferences());
    act(() => {
      result.current.redoBackgroundConfig();
    });
    expect(result.current.state.backgroundConfig.color).toBe(
      DEFAULT_BACKGROUND_COLOR,
    );
    expect(result.current.state.canRedoBackground).toBe(false);
  });

  it("setting the same config is a no-op (no history churn)", () => {
    const { result } = renderHook(() => useDisplayPreferences());
    // Re-set the ACTUAL current default (the boot image) — an identical config
    // must not churn history.
    act(() => {
      result.current.setBackgroundConfig({ ...DEFAULT_BACKGROUND_CONFIG });
    });
    expect(result.current.state.canUndoBackground).toBe(false);
  });

  it("persists config + history to localStorage", () => {
    const { result } = renderHook(() => useDisplayPreferences());
    act(() => {
      result.current.setBackgroundConfig({ mode: "shader", color: "#059669" });
    });
    expect(loadBackgroundConfig().color).toBe("#059669");
    expect(loadBackgroundHistory().length).toBe(1);
  });

  it("persists the redo stack so 'step forward' survives a reload (#10694)", () => {
    // Edit twice, then undo → the undone config is now redoable AND persisted.
    const first = renderHook(() => useDisplayPreferences());
    act(() => {
      first.result.current.setBackgroundConfig({
        mode: "shader",
        color: "#059669",
      });
    });
    act(() => {
      first.result.current.setBackgroundConfig({
        mode: "shader",
        color: "#e11d48",
      });
    });
    act(() => {
      first.result.current.undoBackgroundConfig();
    });
    expect(loadBackgroundRedo().map((c) => c.color)).toEqual(["#e11d48"]);
    first.unmount();

    // A fresh mount (reload) re-hydrates the redo stack and can step forward.
    const reloaded = renderHook(() => useDisplayPreferences());
    expect(reloaded.result.current.state.canRedoBackground).toBe(true);
    act(() => {
      reloaded.result.current.redoBackgroundConfig();
    });
    expect(reloaded.result.current.state.backgroundConfig.color).toBe(
      "#e11d48",
    );
    expect(reloaded.result.current.state.canRedoBackground).toBe(false);
  });

  it("caps the undo history at the maximum", () => {
    const { result } = renderHook(() => useDisplayPreferences());
    const colors = [
      "#111111",
      "#222222",
      "#333333",
      "#444444",
      "#555555",
      "#666666",
      "#777777",
      "#888888",
      "#999999",
      "#aaaaaa",
      "#bbbbbb",
      "#cccccc",
      "#dddddd",
    ];
    for (const color of colors) {
      act(() => {
        result.current.setBackgroundConfig({ mode: "shader", color });
      });
    }
    expect(loadBackgroundHistory().length).toBe(MAX_BACKGROUND_HISTORY);
  });

  it("caps inline data-URL image entries to the single most recent (quota hazard)", () => {
    expect(MAX_BACKGROUND_HISTORY_DATA_URLS).toBe(1);
    const dataEntry = (n: number) => ({
      mode: "image",
      color: "#111111",
      imageUrl: `data:image/jpeg;base64,${"A".repeat(8)}${n}`,
    });
    const mediaEntry = (n: number) => ({
      mode: "image",
      color: "#222222",
      imageUrl: `/api/media/hash${n}.jpg`,
    });
    const normalized = normalizeBackgroundHistory([
      dataEntry(1),
      mediaEntry(1),
      dataEntry(2),
      { mode: "shader", color: "#333333" },
      mediaEntry(2),
      dataEntry(3),
    ]);
    const dataUrls = normalized.filter((e) => e.imageUrl?.startsWith("data:"));
    // Only the most recent data-URL entry survives; media-store + shader
    // entries are all kept in order.
    expect(dataUrls.length).toBe(1);
    expect(dataUrls[0]?.imageUrl).toContain("3");
    expect(normalized.map((e) => e.imageUrl ?? e.color)).toEqual([
      "/api/media/hash1.jpg",
      "#333333",
      "/api/media/hash2.jpg",
      dataEntry(3).imageUrl,
    ]);
  });

  it("keeps a full history of media-store image entries (tiny URLs, no cap pressure)", () => {
    const entries = Array.from({ length: MAX_BACKGROUND_HISTORY }, (_, i) => ({
      mode: "image",
      color: "#000000",
      imageUrl: `/api/media/h${i}.jpg`,
    }));
    expect(normalizeBackgroundHistory(entries).length).toBe(
      MAX_BACKGROUND_HISTORY,
    );
  });

  it("survives an adversarial set/undo/redo storm across shader/image/glsl (#10694)", () => {
    // A GLSL shader source that passes the static gate.
    const SRC =
      "precision highp float; void main(){ gl_FragColor = vec4(1.0); }";
    // Deterministic PRNG (mulberry32) — no Math.random in a render path.
    let a = 0x1234abcd >>> 0;
    const rng = () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const palette = ["#059669", "#e11d48", "#2563eb", "#f59e0b", "#0a0a0a"];
    const configs = [
      () => ({ mode: "shader" as const, color: palette[(rng() * 5) | 0] }),
      () => ({
        mode: "image" as const,
        color: palette[(rng() * 5) | 0],
        imageUrl: `/api/media/h${(rng() * 1000) | 0}.jpg`,
      }),
      () =>
        makeGlslConfig({
          source: SRC,
          presetId: ["aurora", "lava", "plasma"][(rng() * 3) | 0],
          color: palette[(rng() * 5) | 0],
          uniforms: { u_speed: rng() * 4, u_intensity: rng() * 3 },
        }),
    ];

    const { result } = renderHook(() => useDisplayPreferences());
    for (let step = 0; step < 400; step += 1) {
      const roll = rng();
      act(() => {
        if (roll < 0.6) {
          result.current.setBackgroundConfig(configs[(rng() * 3) | 0]());
        } else if (roll < 0.8) {
          result.current.undoBackgroundConfig();
        } else {
          result.current.redoBackgroundConfig();
        }
      });

      const s = result.current.state;
      // Invariant: the live config is always structurally valid.
      expect(["shader", "image", "glsl"]).toContain(s.backgroundConfig.mode);
      expect(typeof s.backgroundConfig.color).toBe("string");
      // Invariant: a glsl config always carries clamped, finite uniforms.
      if (s.backgroundConfig.mode === "glsl") {
        const u = s.backgroundConfig.shader?.uniforms;
        expect(u).toBeDefined();
        for (const v of Object.values(u ?? {})) {
          expect(Number.isFinite(v)).toBe(true);
        }
        expect(u?.u_speed).toBeLessThanOrEqual(3);
        expect(u?.u_speed).toBeGreaterThanOrEqual(0);
      }
      // Invariant: the undo history never exceeds its cap.
      expect(loadBackgroundHistory().length).toBeLessThanOrEqual(
        MAX_BACKGROUND_HISTORY,
      );
      // Invariant: canUndo/canRedo are booleans (flags never desync into null).
      expect(typeof s.canUndoBackground).toBe("boolean");
      expect(typeof s.canRedoBackground).toBe("boolean");
    }
  });
});

describe("useDisplayPreferences — home time widget visibility (#10706)", () => {
  it("defaults to shown and persists a hide toggle across the setter", () => {
    const { result } = renderHook(() => useDisplayPreferences());
    expect(result.current.state.homeTimeWidgetHidden).toBe(false);
    act(() => {
      result.current.setHomeTimeWidgetHidden(true);
    });
    expect(result.current.state.homeTimeWidgetHidden).toBe(true);
    expect(loadHomeTimeWidgetHidden()).toBe(true);
    act(() => {
      result.current.setHomeTimeWidgetHidden(false);
    });
    expect(result.current.state.homeTimeWidgetHidden).toBe(false);
    expect(loadHomeTimeWidgetHidden()).toBe(false);
  });

  it("re-hydrates the hidden pref from storage on mount", () => {
    saveHomeTimeWidgetHidden(true);
    const { result } = renderHook(() => useDisplayPreferences());
    expect(result.current.state.homeTimeWidgetHidden).toBe(true);
  });
});
