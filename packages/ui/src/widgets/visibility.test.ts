// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  applyChatSidebarVisibility,
  isWidgetVisible,
  loadChatSidebarVisibility,
  loadWidgetVisibility,
  saveChatSidebarVisibility,
  saveWidgetVisibility,
  widgetVisibilityKey,
  widgetVisibilityStorageKey,
} from "./visibility.js";

// #9143 — the per-user chat-sidebar widget visibility override layer. Pin the
// key shape, the override precedence (explicit > defaultEnabled), order-
// preserving filter, and the localStorage round-trip (incl. empty -> clear).

describe("widgetVisibilityKey + isWidgetVisible", () => {
  it("composes pluginId/id", () => {
    expect(widgetVisibilityKey("p", "w.id")).toBe("p/w.id");
  });

  it("lets an explicit override win over defaultEnabled", () => {
    const c = { pluginId: "p", id: "w", defaultEnabled: true };
    expect(isWidgetVisible(c, { "p/w": false })).toBe(false);
    expect(
      isWidgetVisible({ ...c, defaultEnabled: false }, { "p/w": true }),
    ).toBe(true);
  });

  it("falls back to defaultEnabled (true when omitted) with no override", () => {
    expect(isWidgetVisible({ pluginId: "p", id: "w" }, {})).toBe(true);
    expect(
      isWidgetVisible({ pluginId: "p", id: "w", defaultEnabled: false }, {}),
    ).toBe(false);
  });
});

describe("applyChatSidebarVisibility", () => {
  it("drops hidden widgets and preserves input order", () => {
    const resolved = [
      { declaration: { pluginId: "p", id: "a", defaultEnabled: true } },
      { declaration: { pluginId: "p", id: "b", defaultEnabled: true } },
      { declaration: { pluginId: "p", id: "c", defaultEnabled: true } },
    ];
    const out = applyChatSidebarVisibility(resolved, { "p/b": false });
    expect(out.map((e) => e.declaration.id)).toEqual(["a", "c"]);
  });
});

describe("loadChatSidebarVisibility + saveChatSidebarVisibility", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips override state through localStorage", () => {
    saveChatSidebarVisibility({ overrides: { "p/w": false } });
    expect(loadChatSidebarVisibility()).toEqual({
      overrides: { "p/w": false },
    });
  });

  it("clears storage when no overrides remain (so default flips still apply)", () => {
    saveChatSidebarVisibility({ overrides: { "p/w": false } });
    saveChatSidebarVisibility({ overrides: {} });
    expect(loadChatSidebarVisibility()).toEqual({ overrides: {} });
  });

  it("ignores non-boolean / malformed persisted values", () => {
    localStorage.setItem(
      "eliza:chat-sidebar:visibility",
      '{"p/w": "yes", "x": true}',
    );
    expect(loadChatSidebarVisibility()).toEqual({ overrides: { x: true } });
  });
});

describe("loadWidgetVisibility + saveWidgetVisibility", () => {
  beforeEach(() => localStorage.clear());

  it("keeps home widget visibility isolated from the legacy chat-sidebar key", () => {
    saveChatSidebarVisibility({ overrides: { "chat/a": false } });
    saveWidgetVisibility({ overrides: { "home/b": false } }, "home");

    expect(widgetVisibilityStorageKey("chat-sidebar")).toBe(
      "eliza:chat-sidebar:visibility",
    );
    expect(widgetVisibilityStorageKey("home")).toBe(
      "eliza:widget-visibility:home",
    );
    expect(loadChatSidebarVisibility()).toEqual({
      overrides: { "chat/a": false },
    });
    expect(loadWidgetVisibility("home")).toEqual({
      overrides: { "home/b": false },
    });
  });
});
