import { describe, expect, it } from "vitest";
// Side-effect import registers lifeops widgets into the app-core registry.
import "@elizaos/app-lifeops/widgets";
import { resolveWidgetsForSlot } from "../../src/widgets/registry";
import type { PluginWidgetDeclaration } from "../../src/widgets/types";

describe("resolveWidgetsForSlot", () => {
  it("keeps compat-backed bundled widgets available when unrelated plugins are loaded", () => {
    const resolved = resolveWidgetsForSlot("chat-sidebar", [
      { id: "openai", enabled: true, isActive: true },
    ]);

    const widgetIds = resolved.map(
      (widget) => `${widget.declaration.pluginId}/${widget.declaration.id}`,
    );

    expect(widgetIds).toEqual(
      expect.arrayContaining([
        "lifeops/lifeops.overview",
        "lifeops/lifeops.google",
        "agent-orchestrator/agent-orchestrator.apps",
        "agent-orchestrator/agent-orchestrator.tasks",
        "agent-orchestrator/agent-orchestrator.activity",
      ]),
    );
    expect(widgetIds).not.toContain("todo/todo.items");
  });

  it("renders the generic todo widget only when a plugin explicitly declares it", () => {
    const serverWidget: PluginWidgetDeclaration = {
      id: "todo.items",
      pluginId: "todo",
      slot: "chat-sidebar",
      label: "Tasks",
      defaultEnabled: true,
      uiSpec: {
        type: "section",
        title: "Tasks",
        body: [],
      },
    };

    const resolved = resolveWidgetsForSlot(
      "chat-sidebar",
      [{ id: "todo", enabled: true, isActive: true }],
      [serverWidget],
    );

    expect(
      resolved.some(
        (widget) =>
          widget.declaration.pluginId === "todo" &&
          widget.declaration.id === "todo.items",
      ),
    ).toBe(true);
  });

  it("does not enable server-only widgets when the owning plugin is missing", () => {
    const serverWidget: PluginWidgetDeclaration = {
      id: "custom.sidebar",
      pluginId: "custom",
      slot: "chat-sidebar",
      label: "Custom sidebar",
      defaultEnabled: true,
      uiSpec: {
        type: "section",
        title: "Custom",
        body: [],
      },
    };

    const resolved = resolveWidgetsForSlot(
      "chat-sidebar",
      [{ id: "openai", enabled: true, isActive: true }],
      [serverWidget],
    );

    expect(
      resolved.some(
        (widget) =>
          widget.declaration.pluginId === "custom" &&
          widget.declaration.id === "custom.sidebar",
      ),
    ).toBe(false);
  });
});
