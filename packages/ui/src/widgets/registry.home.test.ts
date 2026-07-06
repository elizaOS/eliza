/**
 * Unit coverage for Home/Launcher slot resolution: plugins opting into the `home`
 * slot, while non-MVP widgets stay reachable only through their routed/sidebar
 * surfaces (#9143 / #14343).
 */
import { describe, expect, it } from "vitest";
import { resolveWidgetsForSlot } from "./registry";

const enabledRemovedWidgetPlugins = [
  { id: "agent-orchestrator", enabled: true, isActive: true },
  { id: "feed", enabled: true, isActive: true },
  { id: "workflow", enabled: true, isActive: true },
  { id: "finances", enabled: true, isActive: true },
  { id: "relationships", enabled: true, isActive: true },
  { id: "inbox", enabled: true, isActive: true },
] as const;

describe("home frontpage widget slot (#9143)", () => {
  it("keeps non-MVP activity/domain widgets off the home slot (#14343)", () => {
    const resolved = resolveWidgetsForSlot("home", enabledRemovedWidgetPlugins);
    const ids = new Set(resolved.map((r) => r.declaration.id));
    expect(ids).not.toContain("agent-orchestrator.activity");
    expect(ids).not.toContain("agent-orchestrator.apps");
    expect(ids).not.toContain("feed.agent-activity");
    expect(ids).not.toContain("workflow.running");
    expect(ids).not.toContain("finances.alerts");
    expect(ids).not.toContain("relationships.attention");
    expect(ids).not.toContain("inbox.unread");
  });

  it("keeps the chat-sidebar Activity declaration on its own slot (home doesn't steal it)", () => {
    const sidebar = resolveWidgetsForSlot("chat-sidebar", [
      { id: "agent-orchestrator", enabled: true, isActive: true },
    ]);
    const decl = sidebar.find(
      (r) => r.declaration.id === "agent-orchestrator.activity",
    )?.declaration;
    expect(decl?.slot).toBe("chat-sidebar");
  });

  it("declares NO notifications widget for the home slot (the center is pinned by HomeScreen)", () => {
    // The dashboard notification center (NotificationsHomeCenter) is mounted by
    // HomeScreen directly, not ranked through the registry — a `notifications.*`
    // home declaration would double-render the inbox.
    const resolved = resolveWidgetsForSlot("home", []);
    expect(
      resolved.filter((r) => r.declaration.id.startsWith("notifications.")),
    ).toEqual([]);
  });

  it("no longer resolves a standalone Recent conversations tile (#10697)", () => {
    // The redundant Messages widget was removed — messages fold into the
    // notification rail, so the home grid must not resurface a messages tile.
    const resolved = resolveWidgetsForSlot("home", []);
    expect(
      resolved.find((r) => r.declaration.id === "messages.recent"),
    ).toBeUndefined();
  });

  it("keeps the chat-sidebar Apps declaration on its own slot", () => {
    const sidebar = resolveWidgetsForSlot("chat-sidebar", [
      { id: "agent-orchestrator", enabled: true, isActive: true },
    ]);
    const apps = sidebar.find(
      (r) => r.declaration.id === "agent-orchestrator.apps",
    );
    expect(apps?.declaration.slot).toBe("chat-sidebar");
    expect(apps?.Component).toBeTruthy();
  });

  it("does not render default-sink participation rows as resident home cards", () => {
    const resolved = resolveWidgetsForSlot("home", enabledRemovedWidgetPlugins);
    const apps = resolved.find(
      (r) => r.declaration.id === "agent-orchestrator.default-home",
    );
    expect(apps).toBeUndefined();
  });

  it("resolves the curated Todos widget on home", () => {
    const resolved = resolveWidgetsForSlot("home", []);
    const todos = resolved.find((r) => r.declaration.id === "todo.items");
    expect(todos?.declaration.slot).toBe("home");
    expect(todos?.Component).toBeTruthy();
  });
});
