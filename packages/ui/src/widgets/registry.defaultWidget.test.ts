/**
 * Unit coverage for the shared default-widget path (#9143): an activity opt-in
 * resolves to the shared frontpage widget, while the notifications/messages
 * sink kinds yield no tile (the pinned dashboard notification center owns the
 * inbox). Pure, no harness.
 */
import { describe, expect, it } from "vitest";
import { BUILTIN_WIDGET_DECLARATIONS, resolveWidgetsForSlot } from "./registry";
import type { PluginWidgetDeclaration } from "./types";

// #9143 — a plugin with live state but no bundled component opts into a shared
// "default" frontpage widget via `defaultWidget`, and resolves to the shared
// sink's registered component on the home slot. The notifications/messages sink
// kinds resolve to NO tile: the dashboard notification center is pinned by
// HomeScreen and already renders every store notification, so a per-plugin
// notifications card would double-render the inbox.
describe("home defaultWidget opt-in sink (#9143)", () => {
  function withTempDeclaration<T>(
    decl: PluginWidgetDeclaration,
    fn: () => T,
  ): T {
    BUILTIN_WIDGET_DECLARATIONS.push(decl);
    try {
      return fn();
    } finally {
      const i = BUILTIN_WIDGET_DECLARATIONS.indexOf(decl);
      if (i >= 0) BUILTIN_WIDGET_DECLARATIONS.splice(i, 1);
    }
  }

  it("resolves a notifications-sink declaration to NO home tile (pinned center owns the inbox)", () => {
    const decl: PluginWidgetDeclaration = {
      id: "sink-test.notify",
      pluginId: "sink-test",
      slot: "home",
      label: "Sink Test",
      defaultWidget: "notifications",
    };
    withTempDeclaration(decl, () => {
      const resolved = resolveWidgetsForSlot("home", [
        { id: "sink-test", enabled: true, isActive: true },
      ]);
      expect(
        resolved.find((r) => r.declaration.id === "sink-test.notify"),
      ).toBeUndefined();
    });
  });

  it("resolves a messages-sink declaration to NO home tile (folded into the notification rail, #10697)", () => {
    const decl: PluginWidgetDeclaration = {
      id: "sink-test.msgs",
      pluginId: "sink-test",
      slot: "home",
      label: "Sink Msgs",
      defaultWidget: "messages",
    };
    withTempDeclaration(decl, () => {
      const resolved = resolveWidgetsForSlot("home", [
        { id: "sink-test", enabled: true, isActive: true },
      ]);
      expect(
        resolved.find((r) => r.declaration.id === "sink-test.msgs"),
      ).toBeUndefined();
    });
  });

  it("resolves an activity-sink declaration to a component", () => {
    const decl: PluginWidgetDeclaration = {
      id: "sink-test.act",
      pluginId: "sink-test",
      slot: "home",
      label: "Sink Activity",
      defaultWidget: "activity",
    };
    withTempDeclaration(decl, () => {
      const resolved = resolveWidgetsForSlot("home", [
        { id: "sink-test", enabled: true, isActive: true },
      ]);
      const entry = resolved.find((r) => r.declaration.id === "sink-test.act");
      expect(entry?.Component).toBeTruthy();
      expect(entry?.defaultWidgetSink).toBe("activity");
    });
  });

  it("does NOT apply the sink on non-home slots", () => {
    const decl: PluginWidgetDeclaration = {
      id: "sink-test.sidebar",
      pluginId: "sink-test",
      slot: "chat-sidebar",
      label: "Sink Sidebar",
      defaultWidget: "notifications",
    };
    withTempDeclaration(decl, () => {
      const resolved = resolveWidgetsForSlot("chat-sidebar", [
        { id: "sink-test", enabled: true, isActive: true },
      ]);
      // No own component + non-home slot => sink not applied => not resolved.
      expect(
        resolved.find((r) => r.declaration.id === "sink-test.sidebar"),
      ).toBeUndefined();
    });
  });

  it("prefers an own registered component over the sink (sink is a fallback only)", () => {
    // agent-orchestrator.activity HAS an own registered component already; a
    // defaultWidget on it must not override that component.
    const decl: PluginWidgetDeclaration = {
      id: "agent-orchestrator.activity",
      pluginId: "agent-orchestrator",
      slot: "home",
      label: "Activity",
      defaultWidget: "notifications",
    };
    withTempDeclaration(decl, () => {
      const resolved = resolveWidgetsForSlot("home", [
        { id: "agent-orchestrator", enabled: true, isActive: true },
      ]);
      const entry = resolved.find(
        (r) => r.declaration.id === "agent-orchestrator.activity",
      );
      // Still resolves to the orchestrator's OWN component, not the notifications sink.
      expect(entry?.Component).toBeTruthy();
      expect(entry?.defaultWidgetSink).toBeUndefined();
    });
  });
});
