/** Exercises widget declaration resolution with renderable and invalid inputs. */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_WIDGET_DECLARATIONS,
  resolveWidgetsForSlot,
  type WidgetPluginState,
} from "./registry";
import type { PluginWidgetDeclaration } from "./types";

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

describe("home-widget resolution gate (#14349)", () => {
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
