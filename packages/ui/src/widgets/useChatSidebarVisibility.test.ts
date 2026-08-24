/** Verifies useChatSidebarVisibility through the package's configured test harness. */
// @vitest-environment jsdom

/**
 * Covers the user widget-visibility hook end to end over the real
 * localStorage-backed store: hydration of persisted overrides, immediate
 * application of toggles, default-matching override dropping, reset, and
 * cross-tab `storage`-event sync.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  useChatSidebarVisibility,
  useWidgetVisibility,
} from "./useChatSidebarVisibility";

const SIDEBAR_KEY = "eliza:chat-sidebar:visibility";

afterEach(() => {
  window.localStorage.clear();
});

describe("useWidgetVisibility", () => {
  it("starts with an empty override map and defers to declaration defaults", () => {
    const { result } = renderHook(() => useWidgetVisibility());
    expect(result.current.overrides).toEqual({});
    expect(result.current.isVisible({ pluginId: "p", id: "widget-a" })).toBe(
      true,
    );
    expect(
      result.current.isVisible({
        pluginId: "p",
        id: "widget-b",
        defaultEnabled: false,
      }),
    ).toBe(false);
  });

  it("hydrates previously persisted chat-sidebar overrides on mount", () => {
    window.localStorage.setItem(
      SIDEBAR_KEY,
      JSON.stringify({ "p/widget-a": false }),
    );
    const { result } = renderHook(() => useWidgetVisibility());
    expect(result.current.overrides).toEqual({ "p/widget-a": false });
    expect(result.current.isVisible({ pluginId: "p", id: "widget-a" })).toBe(
      false,
    );
    expect(result.current.isVisible({ pluginId: "p", id: "widget-b" })).toBe(
      true,
    );
  });

  it("ignores non-boolean entries and malformed JSON in persisted state", () => {
    window.localStorage.setItem(
      SIDEBAR_KEY,
      JSON.stringify({ "p/numeric": 42, "p/string": "yes", "p/bool": true }),
    );
    const corrupted = renderHook(() => useWidgetVisibility());
    expect(corrupted.result.current.overrides).toEqual({ "p/bool": true });
    corrupted.unmount();

    window.localStorage.setItem(SIDEBAR_KEY, "{not json");
    const broken = renderHook(() => useWidgetVisibility());
    expect(broken.result.current.overrides).toEqual({});
    broken.unmount();
  });

  it("setVisible(false) hides a default-enabled widget and persists the override", () => {
    const { result } = renderHook(() => useWidgetVisibility());
    act(() => {
      result.current.setVisible({ pluginId: "p", id: "widget-a" }, false);
    });
    expect(result.current.overrides).toEqual({ "p/widget-a": false });
    expect(result.current.isVisible({ pluginId: "p", id: "widget-a" })).toBe(
      false,
    );
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe(
      JSON.stringify({ "p/widget-a": false }),
    );
  });

  it("setVisible(true) on a default-disabled widget persists an explicit opt-in", () => {
    const { result } = renderHook(() => useWidgetVisibility());
    act(() => {
      result.current.setVisible(
        { pluginId: "p", id: "widget-b", defaultEnabled: false },
        true,
      );
    });
    expect(result.current.overrides).toEqual({ "p/widget-b": true });
    expect(
      result.current.isVisible({
        pluginId: "p",
        id: "widget-b",
        defaultEnabled: false,
      }),
    ).toBe(true);
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe(
      JSON.stringify({ "p/widget-b": true }),
    );
  });

  it("setting a widget back to its default drops the override and clears storage", () => {
    const { result } = renderHook(() => useWidgetVisibility());
    act(() => {
      result.current.setVisible({ pluginId: "p", id: "widget-a" }, false);
    });
    expect(window.localStorage.getItem(SIDEBAR_KEY)).not.toBeNull();
    act(() => {
      result.current.setVisible({ pluginId: "p", id: "widget-a" }, true);
    });
    // `true` matches the implicit default, so the explicit override is dropped
    // and the now-empty map removes the persisted entry entirely.
    expect(result.current.overrides).toEqual({});
    expect(result.current.isVisible({ pluginId: "p", id: "widget-a" })).toBe(
      true,
    );
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBeNull();
  });

  it("reset() removes every override and the persisted entry", () => {
    const { result } = renderHook(() => useWidgetVisibility());
    act(() => {
      result.current.setVisible({ pluginId: "p", id: "widget-a" }, false);
      result.current.setVisible(
        { pluginId: "p", id: "widget-b", defaultEnabled: false },
        true,
      );
    });
    expect(Object.keys(result.current.overrides)).toHaveLength(2);
    act(() => {
      result.current.reset();
    });
    expect(result.current.overrides).toEqual({});
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBeNull();
    expect(
      result.current.isVisible({
        pluginId: "p",
        id: "widget-b",
        defaultEnabled: false,
      }),
    ).toBe(false);
  });

  it("syncs when another tab writes the matching storage key", () => {
    const { result } = renderHook(() => useWidgetVisibility());
    expect(result.current.overrides).toEqual({});
    window.localStorage.setItem(
      SIDEBAR_KEY,
      JSON.stringify({ "p/widget-a": false }),
    );
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: SIDEBAR_KEY }));
    });
    expect(result.current.overrides).toEqual({ "p/widget-a": false });
    expect(result.current.isVisible({ pluginId: "p", id: "widget-a" })).toBe(
      false,
    );
  });

  it("ignores storage events for other keys", () => {
    window.localStorage.setItem(SIDEBAR_KEY, "{}");
    const { result } = renderHook(() => useWidgetVisibility());
    window.localStorage.setItem(
      SIDEBAR_KEY,
      JSON.stringify({ "p/widget-a": false }),
    );
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "eliza:some-other-key" }),
      );
    });
    expect(result.current.overrides).toEqual({});
  });
});

describe("useWidgetVisibility slot scoping", () => {
  it("persists non-sidebar slots under the prefixed key", () => {
    const { result } = renderHook(() => useWidgetVisibility("home"));
    act(() => {
      result.current.setVisible({ pluginId: "p", id: "card" }, false);
    });
    expect(window.localStorage.getItem("eliza:widget-visibility:home")).toBe(
      JSON.stringify({ "p/card": false }),
    );
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBeNull();
  });
});

describe("useChatSidebarVisibility", () => {
  it("binds to the chat-sidebar slot and its legacy storage key", () => {
    const { result } = renderHook(() => useChatSidebarVisibility());
    act(() => {
      result.current.setVisible({ pluginId: "p", id: "widget-a" }, false);
    });
    expect(result.current.overrides).toEqual({ "p/widget-a": false });
    expect(window.localStorage.getItem(SIDEBAR_KEY)).toBe(
      JSON.stringify({ "p/widget-a": false }),
    );
  });
});
