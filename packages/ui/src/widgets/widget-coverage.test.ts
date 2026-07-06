/**
 * Coverage gate asserting every declared widget slot keeps a bundled component +
 * declaration, so a refactor cannot silently drop one. Reads the source tree, no
 * runtime.
 *
 * The pre-#14349 mandate — every `elizaos.app` plugin had to be "frontpage-aware"
 * via an owned card OR a non-rendering default-sink participation record — was
 * retired: frontpage presence is now opt-in and curated, so the gate no longer
 * enumerates plugin manifests. What survives is the invariant that matters for a
 * refactor: a resolved declaration must actually render, and no slot may carry a
 * duplicate `pluginId/id`.
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

// Every plugin id referenced by a built-in home declaration, enabled — so the
// resolver treats each home widget as present + active.
function allBuiltinHomePlugins(): WidgetPluginState[] {
  return [
    ...new Set(
      BUILTIN_WIDGET_DECLARATIONS.filter((decl) => decl.slot === "home").map(
        (decl) => decl.pluginId,
      ),
    ),
  ].map(enabled);
}

describe("home-widget resolution gate (#14349)", () => {
  it("resolves every built-in home declaration to a renderable component or uiSpec", () => {
    const resolved = resolveWidgetsForSlot("home", allBuiltinHomePlugins());
    const unrenderable = resolved.filter(
      (entry) => entry.Component === null && !entry.declaration.uiSpec,
    );
    // The resolver only returns entries with a component or a uiSpec, so a
    // regression that lets a bare declaration through would surface here.
    expect(unrenderable.map((entry) => entry.declaration.id)).toEqual([]);
    expect(resolved.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps every declared home widget id unique per slot", () => {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const decl of BUILTIN_WIDGET_DECLARATIONS) {
      const key = `${decl.slot}:${decl.pluginId}/${decl.id}`;
      if (seen.has(key)) dupes.push(key);
      seen.add(key);
    }
    expect(dupes).toEqual([]);
  });

  it("red control: a declaration with no registered component and no uiSpec does NOT resolve", () => {
    const decl: PluginWidgetDeclaration = {
      id: "unresolvable.home",
      pluginId: "unresolvable",
      slot: "home",
      label: "Unresolvable",
    };
    withTempDeclaration(decl, () => {
      const resolved = resolveWidgetsForSlot("home", [enabled("unresolvable")]);
      expect(
        resolved.some((r) => r.declaration.id === "unresolvable.home"),
      ).toBe(false);
    });
  });

  it("green control: the same declaration with a uiSpec DOES resolve", () => {
    const decl: PluginWidgetDeclaration = {
      id: "resolvable.home",
      pluginId: "resolvable",
      slot: "home",
      label: "Resolvable",
      uiSpec: {
        root: "root",
        state: {},
        elements: {
          root: { type: "Text", props: { text: "hi" }, children: [] },
        },
      },
    };
    withTempDeclaration(decl, () => {
      const resolved = resolveWidgetsForSlot("home", [enabled("resolvable")]);
      const entry = resolved.find(
        (r) => r.declaration.id === "resolvable.home",
      );
      expect(entry).toBeDefined();
      expect(entry?.declaration.uiSpec).toBeDefined();
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
