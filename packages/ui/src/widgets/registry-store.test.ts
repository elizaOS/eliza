/**
 * Unit coverage for the widget component registry (#9143).
 *
 * `registry-store.ts` is the seam a plugin uses to register the bundled React
 * component for a frontpage/sidebar widget declaration (keyed
 * `${pluginId}/${declarationId}`); `resolveWidgetsForSlot` later looks it up.
 * The registry itself (register / get / namespacing / registerBuiltinWidgets)
 * was untested. Tests use unique plugin ids so they don't collide through the
 * module-singleton registry.
 */

import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import type { ChatSidebarWidgetDefinition } from "../components/chat/widgets/types";
import {
  getWidgetComponent,
  registerBuiltinWidgets,
  registerWidgetComponent,
} from "./registry-store";
import type { WidgetProps } from "./types";

const Fake: ComponentType<WidgetProps> = () => null;
const Other: ComponentType<WidgetProps> = () => null;

describe("registerWidgetComponent / getWidgetComponent", () => {
  it("round-trips a component by pluginId + declarationId", () => {
    registerWidgetComponent("rs-test-a", "todos", Fake);
    expect(getWidgetComponent("rs-test-a", "todos")).toBe(Fake);
  });

  it("returns undefined for an unregistered key", () => {
    expect(getWidgetComponent("rs-test-unknown", "nope")).toBeUndefined();
  });

  it("namespaces by both pluginId and declarationId", () => {
    registerWidgetComponent("rs-test-b", "x", Fake);
    expect(getWidgetComponent("rs-test-b", "y")).toBeUndefined();
    expect(getWidgetComponent("rs-test-c", "x")).toBeUndefined();
  });

  it("last registration wins for the same key", () => {
    registerWidgetComponent("rs-test-d", "w", Fake);
    registerWidgetComponent("rs-test-d", "w", Other);
    expect(getWidgetComponent("rs-test-d", "w")).toBe(Other);
  });
});

describe("registerBuiltinWidgets", () => {
  it("registers each definition under its pluginId/id", () => {
    const defs = [
      { pluginId: "rs-test-e", id: "one", Component: Fake },
      { pluginId: "rs-test-e", id: "two", Component: Other },
    ] as unknown as ChatSidebarWidgetDefinition[];
    registerBuiltinWidgets(defs);
    expect(getWidgetComponent("rs-test-e", "one")).toBe(Fake);
    expect(getWidgetComponent("rs-test-e", "two")).toBe(Other);
  });
});
