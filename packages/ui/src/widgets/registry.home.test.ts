import { describe, expect, it } from "vitest";
import { resolveWidgetsForSlot } from "./registry";

// #9143 — plugins opt a widget onto the Home/Springboard surface by
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

  it("resolves the Notifications widget on home even with NO plugins (always-visible core feature)", () => {
    const resolved = resolveWidgetsForSlot("home", []);
    const notif = resolved.find(
      (r) => r.declaration.id === "notifications.recent",
    );
    expect(notif).toBeTruthy();
    expect(notif?.declaration.slot).toBe("home");
    expect(notif?.Component).toBeTruthy();
  });

  it("resolves the Recent conversations widget on home (curated home-grid tile)", () => {
    // The home grid surfaces recent conversations as a naked 2x1 tile backed by
    // the core conversations API (always-visible). It is distinct from the chat
    // overlay: the overlay is the live thread, this is the at-a-glance list.
    const resolved = resolveWidgetsForSlot("home", []);
    const msgs = resolved.find((r) => r.declaration.id === "messages.recent");
    expect(msgs?.declaration.slot).toBe("home");
    expect(msgs?.Component).toBeTruthy();
  });

  it("keeps Notifications always-visible on home with NO plugins", () => {
    const resolved = resolveWidgetsForSlot("home", []);
    const notif = resolved.find(
      (r) => r.declaration.id === "notifications.recent",
    );
    expect(notif?.declaration.slot).toBe("home");
    expect(notif?.Component).toBeTruthy();
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
