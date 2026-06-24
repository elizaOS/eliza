import { describe, expect, it } from "vitest";
import { resolveWidgetsForSlot, type WidgetPluginState } from "./registry";

// #9143 — per-plugin home-widget coverage gate.
//
// The contract: every manifest plugin opted onto the frontpage resolves at
// least one `home`-slot widget (its own bundled component OR a shared
// `defaultWidget` sink) via `resolveWidgetsForSlot`. This enumerates the
// opted-in batch and asserts each resolves a rendered component, so a future
// edit that drops a declaration (or its sink mapping) fails CI here.
//
// IDs are the runtime plugin IDs (package name with `@elizaos/plugin-`
// stripped — see plugin-discovery-helpers `workspacePluginIdFromPackageName`),
// which is exactly what `PluginInfo.id` carries in the live plugin snapshot.
// Every per-plugin home card ships its own bundled component (the generic
// default-widget sinks were replaced). `todos` surfaces via the workbench
// `todo.items` widget (pluginId "todo", the fallback set) rather than a
// "todos"-keyed declaration, so it isn't enumerated here.
const HOME_WIDGET_PLUGIN_IDS = [
  "inbox",
  "calendar",
  "goals",
  "finances",
  "health",
  "relationships",
] as const;

function enabled(id: string): WidgetPluginState {
  return { id, enabled: true, isActive: true };
}

describe("home-widget per-plugin coverage gate (#9143)", () => {
  for (const pluginId of HOME_WIDGET_PLUGIN_IDS) {
    it(`resolves >=1 home widget with a rendered component for "${pluginId}"`, () => {
      const resolved = resolveWidgetsForSlot("home", [enabled(pluginId)]);
      const own = resolved.filter((r) => r.declaration.pluginId === pluginId);
      expect(own.length).toBeGreaterThanOrEqual(1);
      // Every opted-in declaration must render something (own component or the
      // shared sink it opted into) — a declaration that resolves no component
      // is a broken pipeline, not coverage.
      for (const entry of own) {
        expect(entry.Component).toBeTruthy();
      }
    });
  }

  it("enumerates every opted-in plugin (count check, fails if the batch shrinks)", () => {
    const covered = HOME_WIDGET_PLUGIN_IDS.filter((pluginId) => {
      const resolved = resolveWidgetsForSlot("home", [enabled(pluginId)]);
      return resolved.some(
        (r) => r.declaration.pluginId === pluginId && r.Component !== null,
      );
    });
    expect(covered).toEqual([...HOME_WIDGET_PLUGIN_IDS]);
  });

  // Negative control (red-then-green proof): a manifest plugin that has NOT
  // opted into a home widget resolves none. This is the failure the gate
  // catches — opting it in (a `home` declaration) is what turns it green.
  // `scheduling` is deliberately left un-opted here (it surfaces attention via
  // the notification rail, not a home card).
  it("does NOT resolve a home widget for a plugin with no opt-in", () => {
    const resolved = resolveWidgetsForSlot("home", [enabled("scheduling")]);
    expect(resolved.some((r) => r.declaration.pluginId === "scheduling")).toBe(
      false,
    );
  });
});
