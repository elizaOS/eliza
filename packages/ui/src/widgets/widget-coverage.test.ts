/**
 * Coverage gate asserting every declared widget resolves to something the host
 * can render and that no slot carries a duplicate `pluginId/id`. Frontpage
 * presence is opt-in and curated, not mandated — a plugin without a home widget
 * is fine; a declared widget that resolves to nothing is not. Exercises the real
 * `resolveWidgetsForSlot`, no runtime.
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_WIDGET_DECLARATIONS,
  resolveWidgetsForSlot,
  type WidgetPluginState,
} from "./registry";
import { type PluginWidgetDeclaration, WIDGET_SLOTS } from "./types";

function enabled(id: string): WidgetPluginState {
  return { id, enabled: true, isActive: true };
}

function withTempDeclaration<T>(decl: PluginWidgetDeclaration, fn: () => T): T {
  BUILTIN_WIDGET_DECLARATIONS.push(decl);
  try {
    return fn();
  } finally {
    const i = BUILTIN_WIDGET_DECLARATIONS.indexOf(decl);
    if (i >= 0) BUILTIN_WIDGET_DECLARATIONS.splice(i, 1);
  }
}

describe("widget declaration resolution gate", () => {
  it("resolves every enabled built-in declaration to a renderable component or uiSpec", () => {
    // Every built-in declaration must be renderable when its plugin is enabled;
    // a declaration that resolves to neither a bundled component nor a `uiSpec`
    // is dead weight the resolver silently drops, so fail here instead.
    const enabledPlugins = Array.from(
      new Set(BUILTIN_WIDGET_DECLARATIONS.map((d) => d.pluginId)),
    ).map(enabled);

    const unresolved: string[] = [];
    for (const slot of WIDGET_SLOTS) {
      const declaredIds = new Set(
        BUILTIN_WIDGET_DECLARATIONS.filter((d) => d.slot === slot).map(
          (d) => `${d.pluginId}/${d.id}`,
        ),
      );
      const resolved = new Set(
        resolveWidgetsForSlot(slot, enabledPlugins).map(
          (r) => `${r.declaration.pluginId}/${r.declaration.id}`,
        ),
      );
      for (const id of declaredIds) {
        if (!resolved.has(id)) unresolved.push(`${slot}:${id}`);
      }
    }

    expect(unresolved).toEqual([]);
  });

  it("has no duplicate pluginId/id within a slot", () => {
    const seen = new Map<string, number>();
    for (const decl of BUILTIN_WIDGET_DECLARATIONS) {
      const key = `${decl.slot}:${decl.pluginId}/${decl.id}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()]
      .filter(([, count]) => count > 1)
      .map(([key]) => key);

    expect(duplicates).toEqual([]);
  });

  it("drops a declaration that resolves to neither a component nor a uiSpec (red control)", () => {
    // A declaration for a plugin with no registered component and no `uiSpec`
    // must not appear in the resolved set — this is the gate the first test
    // enforces, proven here with a purpose-built unresolvable declaration.
    const pluginId = "coverage-red-control";
    const decl: PluginWidgetDeclaration = {
      id: `${pluginId}.home`,
      pluginId,
      slot: "home",
      label: "Coverage Red Control",
    };
    withTempDeclaration(decl, () => {
      const resolved = resolveWidgetsForSlot("home", [enabled(pluginId)]);
      expect(resolved.some((r) => r.declaration.pluginId === pluginId)).toBe(
        false,
      );
    });
  });

  it("resolves the same declaration once it carries a uiSpec (green control)", () => {
    const pluginId = "coverage-green-control";
    const decl: PluginWidgetDeclaration = {
      id: `${pluginId}.home`,
      pluginId,
      slot: "home",
      label: "Coverage Green Control",
      uiSpec: {
        root: "root",
        state: {},
        elements: {
          root: { type: "Text", props: { text: "ok" }, children: [] },
        },
      },
    };
    withTempDeclaration(decl, () => {
      const resolved = resolveWidgetsForSlot("home", [enabled(pluginId)]);
      expect(resolved.some((r) => r.declaration.id === `${pluginId}.home`)).toBe(
        true,
      );
    });
  });
});

// #9304 — chat-sidebar slot coverage gate.
//
// The right-rail chat-sidebar widgets are bundled (not auto-discovered from
// manifests), so a refactor that drops one of their declarations would silently
// remove it from the live chat surface with no failing test. This gate pins the
// expected set: every id must resolve with a rendered Component. Dropping one
// fails CI here.
describe("chat-sidebar slot coverage gate (#9304)", () => {
  // The bundled plugins whose widgets target the chat-sidebar rail.
  const SIDEBAR_PLUGINS: WidgetPluginState[] = [
    enabled("agent-orchestrator"),
    enabled("browser-workspace"),
    enabled("music-player"),
  ];
  // Every chat-sidebar widget id that must remain wired.
  const EXPECTED_SIDEBAR_WIDGET_IDS = [
    "agent-orchestrator.apps",
    "agent-orchestrator.activity",
    "browser.status",
    "music-player.stream",
  ] as const;

  it("resolves every expected chat-sidebar widget with a rendered component", () => {
    const resolved = resolveWidgetsForSlot("chat-sidebar", SIDEBAR_PLUGINS);
    const rendered = new Set(
      resolved.filter((r) => r.Component !== null).map((r) => r.declaration.id),
    );
    const missing = EXPECTED_SIDEBAR_WIDGET_IDS.filter(
      (id) => !rendered.has(id),
    );
    expect(missing).toEqual([]);
  });
});

// #9448 — dead slot cleanup gate.
describe("widget slot contract (#9448)", () => {
  it("keeps the active widget slot list limited to supported surfaces", () => {
    expect(WIDGET_SLOTS).toEqual([
      "chat-sidebar",
      "character",
      "nav-page",
      "home",
    ]);
  });

  it("keeps bundled widget declarations off retired slots", () => {
    const active = new Set<string>(WIDGET_SLOTS);
    const retired = BUILTIN_WIDGET_DECLARATIONS.filter(
      (decl) => !active.has(decl.slot),
    ).map((decl) => `${decl.pluginId}/${decl.id}:${decl.slot}`);

    expect(retired).toEqual([]);
  });
});
