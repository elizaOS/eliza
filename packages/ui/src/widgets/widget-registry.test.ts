/**
 * Verifies widget registry resolution, renderability, unique declarations, and
 * rejection of unsupported slots without pinning a widget inventory size.
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

describe("home-widget resolution", () => {
  it("resolves every built-in home declaration to a renderable component or uiSpec", () => {
    const resolved = resolveWidgetsForSlot("home", allBuiltinHomePlugins());
    const unrenderable = resolved.filter(
      (entry) => entry.Component === null && !entry.declaration.uiSpec,
    );
    // The resolver only returns entries with a component or a uiSpec, so a
    // regression that lets a bare declaration through would surface here.
    expect(unrenderable.map((entry) => entry.declaration.id)).toEqual([]);
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

describe("widget slot contract (#9448)", () => {
  it("keeps bundled widget declarations off retired slots", () => {
    const active = new Set<string>(WIDGET_SLOTS);
    const retired = BUILTIN_WIDGET_DECLARATIONS.filter(
      (decl) => !active.has(decl.slot),
    ).map((decl) => `${decl.pluginId}/${decl.id}:${decl.slot}`);

    expect(retired).toEqual([]);
  });
});
