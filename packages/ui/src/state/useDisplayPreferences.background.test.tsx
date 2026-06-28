// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadBackgroundConfig,
  loadBackgroundHistory,
  MAX_BACKGROUND_HISTORY,
} from "./persistence";
import { DEFAULT_BACKGROUND_COLOR } from "./ui-preferences";
import { useDisplayPreferences } from "./useDisplayPreferences";

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("useDisplayPreferences — background history + undo", () => {
  it("starts on the default with nothing to undo", () => {
    const { result } = renderHook(() => useDisplayPreferences());
    expect(result.current.state.backgroundConfig).toEqual({
      mode: "shader",
      color: DEFAULT_BACKGROUND_COLOR,
    });
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

  it("setting the same config is a no-op (no history churn)", () => {
    const { result } = renderHook(() => useDisplayPreferences());
    act(() => {
      result.current.setBackgroundConfig({
        mode: "shader",
        color: DEFAULT_BACKGROUND_COLOR,
      });
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
});
