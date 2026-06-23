import { describe, expect, it } from "vitest";
import { resolveWidgetsForSlot } from "./registry";

// #9143 — plugins opt a widget onto the Springboard/ViewCatalog home by
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
});
