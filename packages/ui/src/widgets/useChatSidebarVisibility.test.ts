// @vitest-environment jsdom
/**
 * Coverage for the useWidgetVisibility / useChatSidebarVisibility hook over
 * the real visibility store and jsdom localStorage: default fallback, mount
 * hydration of persisted overrides, hide/show/reset persistence (including
 * dropping an override that matches the default), cross-tab `storage`-event
 * sync, and per-slot key namespacing. No module is mocked.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  useChatSidebarVisibility,
  useWidgetVisibility,
} from "./useChatSidebarVisibility";

const CHAT_SIDEBAR_KEY = "eliza:chat-sidebar:visibility";
const slotKey = (slot: string) =>
  slot === "chat-sidebar"
    ? CHAT_SIDEBAR_KEY
    : `eliza:widget-visibility:${slot}`;

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("useChatSidebarVisibility", () => {
  it("starts with no overrides and falls back to defaultEnabled", () => {
    const { result } = renderHook(() => useChatSidebarVisibility());

    expect(result.current.overrides).toEqual({});
    expect(result.current.isVisible({ pluginId: "todo", id: "items" })).toBe(
      true,
    );
    expect(
      result.current.isVisible({
        pluginId: "todo",
        id: "items",
        defaultEnabled: true,
      }),
    ).toBe(true);
    expect(
      result.current.isVisible({
        pluginId: "todo",
        id: "items",
        defaultEnabled: false,
      }),
    ).toBe(false);
  });

  it("hydrates persisted overrides from localStorage on mount", () => {
    window.localStorage.setItem(
      CHAT_SIDEBAR_KEY,
      JSON.stringify({ "todo/items": false }),
    );

    const { result } = renderHook(() => useChatSidebarVisibility());

    expect(result.current.overrides).toEqual({ "todo/items": false });
    expect(
      result.current.isVisible({
        pluginId: "todo",
        id: "items",
        defaultEnabled: true,
      }),
    ).toBe(false);
    expect(
      result.current.isVisible({ pluginId: "calendar", id: "upcoming" }),
    ).toBe(true);
  });

  it("persists a hide override for a default-enabled widget", () => {
    const { result } = renderHook(() => useChatSidebarVisibility());

    act(() => {
      result.current.setVisible(
        { pluginId: "todo", id: "items", defaultEnabled: true },
        false,
      );
    });

    expect(result.current.overrides).toEqual({ "todo/items": false });
    expect(
      result.current.isVisible({
        pluginId: "todo",
        id: "items",
        defaultEnabled: true,
      }),
    ).toBe(false);
    expect(window.localStorage.getItem(CHAT_SIDEBAR_KEY)).toBe(
      JSON.stringify({ "todo/items": false }),
    );
  });

  it("drops an override that matches the current default so later default changes propagate", () => {
    window.localStorage.setItem(
      CHAT_SIDEBAR_KEY,
      JSON.stringify({ "calendar/upcoming": true }),
    );

    const { result } = renderHook(() => useChatSidebarVisibility());
    expect(result.current.overrides).toEqual({ "calendar/upcoming": true });

    act(() => {
      result.current.setVisible(
        {
          pluginId: "calendar",
          id: "upcoming",
          defaultEnabled: true,
        },
        true,
      );
    });

    expect(result.current.overrides).toEqual({});
    expect(window.localStorage.getItem(CHAT_SIDEBAR_KEY)).toBeNull();
  });

  it("reset clears state and removes the storage key", () => {
    const { result } = renderHook(() => useChatSidebarVisibility());

    act(() => {
      result.current.setVisible({ pluginId: "a", id: "b" }, false);
    });
    expect(window.localStorage.getItem(CHAT_SIDEBAR_KEY)).toBe(
      JSON.stringify({ "a/b": false }),
    );

    act(() => {
      result.current.reset();
    });

    expect(result.current.overrides).toEqual({});
    expect(window.localStorage.getItem(CHAT_SIDEBAR_KEY)).toBeNull();
  });

  it("reloads when another context writes the matching slot key and ignores other keys", () => {
    const { result } = renderHook(() => useChatSidebarVisibility());

    // A different key must not disturb state even though a new value exists.
    window.localStorage.setItem(
      CHAT_SIDEBAR_KEY,
      JSON.stringify({ "c/d": false }),
    );
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "eliza:some-other-key" }),
      );
    });
    expect(result.current.overrides).toEqual({});
    expect(
      result.current.isVisible({
        pluginId: "c",
        id: "d",
        defaultEnabled: true,
      }),
    ).toBe(true);

    // Matching key reloads the persisted snapshot.
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: CHAT_SIDEBAR_KEY }),
      );
    });
    expect(result.current.overrides).toEqual({ "c/d": false });
    expect(
      result.current.isVisible({
        pluginId: "c",
        id: "d",
        defaultEnabled: true,
      }),
    ).toBe(false);
  });
});

describe("useWidgetVisibility custom slots", () => {
  it("namespaces persistence under eliza:widget-visibility:<slot>", () => {
    const { result } = renderHook(() => useWidgetVisibility("home"));

    act(() => {
      result.current.setVisible(
        { pluginId: "music-library", id: "playlists" },
        false,
      );
    });

    expect(slotKey("home")).toBe("eliza:widget-visibility:home");
    expect(result.current.overrides).toEqual({
      "music-library/playlists": false,
    });
    expect(window.localStorage.getItem("eliza:widget-visibility:home")).toBe(
      JSON.stringify({ "music-library/playlists": false }),
    );
    expect(window.localStorage.getItem(CHAT_SIDEBAR_KEY)).toBeNull();
  });

  it("keeps two slots independent", () => {
    const sidebar = renderHook(() => useWidgetVisibility("chat-sidebar"));
    const home = renderHook(() => useWidgetVisibility("home"));

    act(() => {
      home.result.current.setVisible({ pluginId: "p", id: "q" }, false);
    });

    expect(sidebar.result.current.overrides).toEqual({});
    expect(home.result.current.overrides).toEqual({ "p/q": false });
    expect(home.result.current.isVisible({ pluginId: "p", id: "q" })).toBe(
      false,
    );
    expect(sidebar.result.current.isVisible({ pluginId: "p", id: "q" })).toBe(
      true,
    );
  });
});
