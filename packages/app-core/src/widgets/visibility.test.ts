import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  APPS_SECTION_VISIBILITY_KEY,
  applyChatSidebarVisibility,
  CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY,
  isWidgetVisible,
  loadChatSidebarVisibility,
  saveChatSidebarVisibility,
  widgetVisibilityKey,
} from "./visibility";

function widget(
  pluginId: string,
  id: string,
  defaultEnabled?: boolean,
): { declaration: { pluginId: string; id: string; defaultEnabled?: boolean } } {
  return { declaration: { pluginId, id, defaultEnabled } };
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("widgetVisibilityKey", () => {
  it("returns pluginId/id", () => {
    expect(widgetVisibilityKey("lifeops", "lifeops.calendar")).toBe(
      "lifeops/lifeops.calendar",
    );
  });

  it("APPS_SECTION_VISIBILITY_KEY uses the canonical app-core/apps.section shape", () => {
    expect(APPS_SECTION_VISIBILITY_KEY).toBe("app-core/apps.section");
  });
});

describe("isWidgetVisible — precedence", () => {
  it("returns true when defaultEnabled is true and no override exists", () => {
    expect(
      isWidgetVisible(
        { pluginId: "lifeops", id: "lifeops.calendar", defaultEnabled: true },
        {},
      ),
    ).toBe(true);
  });

  it("returns true when defaultEnabled is omitted (undefined defaults to enabled)", () => {
    expect(
      isWidgetVisible({ pluginId: "lifeops", id: "lifeops.calendar" }, {}),
    ).toBe(true);
  });

  it("returns false when defaultEnabled is false and no override exists", () => {
    expect(
      isWidgetVisible(
        { pluginId: "lifeops", id: "lifeops.calendar", defaultEnabled: false },
        {},
      ),
    ).toBe(false);
  });

  it("returns false when override is explicitly false (overrides default-on)", () => {
    expect(
      isWidgetVisible(
        { pluginId: "lifeops", id: "lifeops.calendar", defaultEnabled: true },
        { "lifeops/lifeops.calendar": false },
      ),
    ).toBe(false);
  });

  it("returns true when override is explicitly true (overrides default-off)", () => {
    expect(
      isWidgetVisible(
        { pluginId: "lifeops", id: "lifeops.calendar", defaultEnabled: false },
        { "lifeops/lifeops.calendar": true },
      ),
    ).toBe(true);
  });
});

describe("applyChatSidebarVisibility", () => {
  it("preserves input order while filtering hidden entries", () => {
    const widgets = [
      widget("lifeops", "lifeops.calendar", true),
      widget("lifeops", "lifeops.inbox", true),
      widget("agent-orchestrator", "agent-orchestrator.apps", true),
    ];
    const overrides = { "lifeops/lifeops.inbox": false };
    const filtered = applyChatSidebarVisibility(widgets, overrides);
    expect(filtered.map((w) => w.declaration.id)).toEqual([
      "lifeops.calendar",
      "agent-orchestrator.apps",
    ]);
  });

  it("returns the original list when overrides are empty", () => {
    const widgets = [
      widget("lifeops", "lifeops.calendar"),
      widget("lifeops", "lifeops.inbox"),
    ];
    const filtered = applyChatSidebarVisibility(widgets, {});
    expect(filtered).toHaveLength(2);
  });

  it("does not include a widget that is default-off without an override", () => {
    const widgets = [
      widget("lifeops", "lifeops.calendar", false),
      widget("lifeops", "lifeops.inbox", true),
    ];
    const filtered = applyChatSidebarVisibility(widgets, {});
    expect(filtered.map((w) => w.declaration.id)).toEqual(["lifeops.inbox"]);
  });
});

describe("load/save round-trip", () => {
  it("persists overrides verbatim", () => {
    saveChatSidebarVisibility({
      overrides: {
        "lifeops/lifeops.calendar": false,
        "agent-orchestrator/agent-orchestrator.apps": true,
      },
    });
    const loaded = loadChatSidebarVisibility();
    expect(loaded.overrides).toEqual({
      "lifeops/lifeops.calendar": false,
      "agent-orchestrator/agent-orchestrator.apps": true,
    });
  });

  it("clears the storage key when overrides become empty", () => {
    saveChatSidebarVisibility({
      overrides: { "lifeops/lifeops.calendar": false },
    });
    expect(
      localStorage.getItem(CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY),
    ).not.toBeNull();
    saveChatSidebarVisibility({ overrides: {} });
    expect(
      localStorage.getItem(CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY),
    ).toBeNull();
  });

  it("returns empty overrides when storage is empty", () => {
    expect(loadChatSidebarVisibility()).toEqual({ overrides: {} });
  });

  it("tolerates corrupted JSON without throwing", () => {
    localStorage.setItem(CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY, "not-json");
    expect(loadChatSidebarVisibility()).toEqual({ overrides: {} });
  });

  it("drops non-boolean values during sanitization", () => {
    localStorage.setItem(
      CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY,
      JSON.stringify({
        "lifeops/lifeops.calendar": false,
        "lifeops/lifeops.inbox": "true", // invalid (string)
        "lifeops/lifeops.bogus": null,
        "": true, // invalid (empty key)
      }),
    );
    expect(loadChatSidebarVisibility().overrides).toEqual({
      "lifeops/lifeops.calendar": false,
    });
  });
});
