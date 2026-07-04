/**
 * Unit coverage for Home/Launcher slot resolution: plugins opting into the `home`
 * slot, and the orchestrator Activity widget reusing its component (#9143).
 */
import { describe, expect, it } from "vitest";
import { resolveWidgetsForSlot } from "./registry";

// #9143 — plugins opt a widget onto the Home/Launcher surface by
// declaring the new `home` slot; the bundled agent-orchestrator Activity widget
// opts in (reusing its registered component) so the frontpage isn't empty.
const enabledOrchestrator = [
  { id: "agent-orchestrator", enabled: true, isActive: true },
] as const;

describe("home frontpage widget slot (#9143)", () => {
  it("resolves the agent-orchestrator Activity widget on the home slot, with its component", () => {
    const resolved = resolveWidgetsForSlot("home", enabledOrchestrator);
    const home = resolved.find(
      (r) => r.declaration.id === "agent-orchestrator.activity",
    );
    expect(home).toBeTruthy();
    expect(home?.declaration.slot).toBe("home");
    // Reused component resolves (same pluginId+id as the sidebar declaration).
    expect(home?.Component).toBeTruthy();
  });

  it("keeps the chat-sidebar Activity declaration on its own slot (home doesn't steal it)", () => {
    const sidebar = resolveWidgetsForSlot("chat-sidebar", enabledOrchestrator);
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

  it("resolves the agent-orchestrator Apps widget on home (reused component)", () => {
    const resolved = resolveWidgetsForSlot("home", enabledOrchestrator);
    const apps = resolved.find(
      (r) => r.declaration.id === "agent-orchestrator.apps",
    );
    expect(apps?.declaration.slot).toBe("home");
    expect(apps?.Component).toBeTruthy();
  });

  it("resolves the Todos widget on home (per-plugin breadth opt-in)", () => {
    const resolved = resolveWidgetsForSlot("home", []);
    const todos = resolved.find((r) => r.declaration.id === "todo.items");
    expect(todos?.declaration.slot).toBe("home");
    expect(todos?.Component).toBeTruthy();
  });
});
