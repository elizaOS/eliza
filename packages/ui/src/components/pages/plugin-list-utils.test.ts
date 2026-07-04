/**
 * Unit tests for plugin-list-utils: icon resolution precedence (image icons
 * before lucide names, raw labels rejected; only URL/path-like image sources
 * accepted) and buildPluginListState (hides db/always-on plugins, applies mode
 * + search + status + subgroup filters and custom order, and sorts ready
 * plugins before those needing config before disabled). Pure functions.
 */

import { Puzzle } from "lucide-react";
import { describe, expect, it } from "vitest";
import type { PluginInfo } from "../../api";
import {
  buildPluginListState,
  iconImageSource,
  resolveIcon,
} from "./plugin-list-utils";

function plugin(overrides: Partial<PluginInfo> & { id: string }): PluginInfo {
  return {
    name: overrides.name ?? overrides.id,
    description: overrides.description ?? "",
    enabled: overrides.enabled ?? false,
    configured: overrides.configured ?? true,
    envKey: overrides.envKey ?? null,
    category: overrides.category ?? "feature",
    source: overrides.source ?? "bundled",
    parameters: overrides.parameters ?? [],
    validationErrors: overrides.validationErrors ?? [],
    validationWarnings: overrides.validationWarnings ?? [],
    ...overrides,
  };
}

describe("plugin-list-utils icon resolution", () => {
  it("resolves image icons before lucide icon names and rejects raw labels", () => {
    expect(
      resolveIcon(plugin({ id: "image", icon: "/icons/plugin.svg" })),
    ).toBe("/icons/plugin.svg");
    expect(
      resolveIcon(
        plugin({
          id: "image-precedence",
          icon: "https://cdn.test/plugin.svg",
          iconName: "Puzzle",
        }),
      ),
    ).toBe("https://cdn.test/plugin.svg");
    expect(resolveIcon(plugin({ id: "lucide", iconName: "Puzzle" }))).toBe(
      Puzzle,
    );
    expect(resolveIcon(plugin({ id: "raw", icon: "\u{1F50C}" }))).toBeNull();
    expect(resolveIcon(plugin({ id: "unknown", iconName: "NoSuchIcon" }))).toBe(
      null,
    );
  });

  it("recognizes only URL-like or path-like icon image sources", () => {
    expect(iconImageSource("https://cdn.test/icon.png")).toBe(
      "https://cdn.test/icon.png",
    );
    expect(iconImageSource("data:image/png;base64,abc")).toBe(
      "data:image/png;base64,abc",
    );
    expect(iconImageSource("/icons/plugin.svg")).toBe("/icons/plugin.svg");
    expect(iconImageSource("Puzzle")).toBeNull();
    expect(iconImageSource("")).toBeNull();
  });
});

describe("buildPluginListState", () => {
  it("hides database and always-on plugins, applies mode filters, and counts subgroups", () => {
    const state = buildPluginListState({
      allowCustomOrder: false,
      effectiveSearch: "",
      effectiveStatusFilter: "all",
      isConnectorLikeMode: true,
      mode: "connectors",
      pluginOrder: [],
      plugins: [
        plugin({ id: "discord", category: "connector", group: "connector" }),
        plugin({
          id: "hidden-connector",
          category: "connector",
          visible: false,
        }),
        plugin({ id: "sql", category: "database" }),
        plugin({ id: "video-out", category: "streaming", group: "streaming" }),
        plugin({ id: "feature", category: "feature", group: "devtools" }),
      ],
      showSubgroupFilters: true,
      subgroupFilter: "all",
    });

    expect(state.nonDbPlugins.map((item) => item.id)).toEqual([
      "__ui-showcase__",
      "discord",
    ]);
    expect(state.sorted.map((item) => item.id)).toEqual(["discord"]);
    expect(state.visiblePlugins.map((item) => item.id)).toEqual(["discord"]);
    expect(state.subgroupTags).toEqual([
      { id: "all", label: "All", count: 1 },
      { id: "connector", label: "Connectors", count: 1 },
    ]);
  });

  it("combines search/status filtering with subgroup filtering and custom order", () => {
    const state = buildPluginListState({
      allowCustomOrder: true,
      effectiveSearch: "voice",
      effectiveStatusFilter: "enabled",
      isConnectorLikeMode: false,
      mode: "all",
      pluginOrder: ["voice-later", "voice-first"],
      plugins: [
        plugin({
          id: "voice-first",
          name: "Voice First",
          enabled: true,
          group: "voice",
        }),
        plugin({
          id: "voice-later",
          name: "Voice Later",
          enabled: true,
          group: "voice",
        }),
        plugin({
          id: "voice-disabled",
          name: "Voice Disabled",
          enabled: false,
          group: "voice",
        }),
        plugin({
          id: "voice-media",
          name: "Voice Media",
          enabled: true,
          group: "media",
        }),
      ],
      showSubgroupFilters: true,
      subgroupFilter: "voice",
    });

    expect(state.sorted.map((item) => item.id)).toEqual([
      "voice-later",
      "voice-first",
      "voice-media",
    ]);
    expect(state.visiblePlugins.map((item) => item.id)).toEqual([
      "voice-later",
      "voice-first",
    ]);
    expect(state.subgroupTags).toEqual([
      { id: "all", label: "All", count: 3 },
      { id: "voice", label: "Voice & Audio", count: 2 },
      { id: "media", label: "Media & Content", count: 1 },
    ]);
  });

  it("sorts ready plugins before enabled plugins needing config and disabled plugins", () => {
    const state = buildPluginListState({
      allowCustomOrder: false,
      effectiveSearch: "",
      effectiveStatusFilter: "all",
      isConnectorLikeMode: false,
      mode: "all",
      pluginOrder: [],
      plugins: [
        plugin({ id: "disabled", name: "A Disabled", enabled: false }),
        plugin({
          id: "needs-config",
          name: "B Needs Config",
          enabled: true,
          parameters: [
            {
              key: "TOKEN",
              type: "string",
              description: "",
              required: true,
              sensitive: false,
              currentValue: null,
              isSet: false,
            },
          ],
        }),
        plugin({ id: "ready", name: "C Ready", enabled: true }),
      ],
      showSubgroupFilters: false,
      subgroupFilter: "all",
    });

    expect(state.sorted.map((item) => item.id)).toEqual([
      "ready",
      "needs-config",
      "disabled",
    ]);
  });
});
