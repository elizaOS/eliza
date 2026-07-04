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
  getWidgetRegistryVersion,
  markWidgetRegistryChanged,
  registerBuiltinWidgets,
  registerWidgetComponent,
  subscribeWidgetRegistry,
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

// Reactivity seam (arch-audit #12092 item 27): plugin widget modules load on the
// renderer idle path, so a widget can register after a home/sidebar host has
// already resolved its slot. The host subscribes to this store and re-resolves
// when the version changes, instead of dropping the late widget until an
// unrelated plugin-snapshot change. Without this, an idle-registered widget
// (e.g. plugin-wallet-ui's chat-sidebar widget) is silently missing.
describe("registry change subscription", () => {
  it("notifies subscribers and bumps the version on component registration", () => {
    const before = getWidgetRegistryVersion();
    let notified = 0;
    const unsubscribe = subscribeWidgetRegistry(() => {
      notified += 1;
    });

    registerWidgetComponent("rs-test-reactive", "late", Fake);

    expect(notified).toBe(1);
    expect(getWidgetRegistryVersion()).toBe(before + 1);
    unsubscribe();
  });

  it("notifies on declaration registration via markWidgetRegistryChanged", () => {
    let notified = 0;
    const unsubscribe = subscribeWidgetRegistry(() => {
      notified += 1;
    });

    markWidgetRegistryChanged();

    expect(notified).toBe(1);
    unsubscribe();
  });

  it("stops notifying after unsubscribe", () => {
    let notified = 0;
    const unsubscribe = subscribeWidgetRegistry(() => {
      notified += 1;
    });
    unsubscribe();

    registerWidgetComponent("rs-test-reactive-2", "late", Fake);

    expect(notified).toBe(0);
  });

  it("keeps the version stable when nothing registers", () => {
    const a = getWidgetRegistryVersion();
    const b = getWidgetRegistryVersion();
    expect(a).toBe(b);
  });
});
