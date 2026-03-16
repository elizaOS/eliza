import {
  type BuildCommandsArgs,
  buildCommands,
  NAV_COMMANDS,
} from "@elizaos/app-core/chat";
import { describe, expect, it, vi } from "vitest";

function makeArgs(overrides?: Partial<BuildCommandsArgs>): BuildCommandsArgs {
  return {
    agentState: "running",
    activeGameViewerUrl: "",
    handleStart: vi.fn(),

    handleRestart: vi.fn(),
    setTab: vi.fn(),
    setAppsSubTab: vi.fn(),
    loadPlugins: vi.fn(),
    loadSkills: vi.fn(),
    loadLogs: vi.fn(),
    loadWorkbench: vi.fn(),
    handleChatClear: vi.fn(),
    openBugReport: vi.fn(),
    ...overrides,
  };
}

describe("command-registry", () => {
  it("includes all NAV_COMMANDS as navigation commands", () => {
    const cmds = buildCommands(makeArgs());
    for (const nav of NAV_COMMANDS) {
      const found = cmds.find((c) => c.id === nav.id);
      expect(found, `missing nav command ${nav.id}`).toBeDefined();
      expect(found?.category).toBe("navigation");
    }
  });

  it("has no duplicate IDs", () => {
    const cmds = buildCommands(makeArgs());
    const ids = cmds.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("shows Start Agent when stopped", () => {
    const cmds = buildCommands(makeArgs({ agentState: "stopped" }));
    expect(cmds.find((c) => c.id === "start-agent")).toBeDefined();
  });

  it("includes Open Current Game when URL is present", () => {
    const cmds = buildCommands(
      makeArgs({ activeGameViewerUrl: "https://game.example.com" }),
    );
    expect(cmds.find((c) => c.id === "nav-current-game")).toBeDefined();
  });

  it("excludes Open Current Game when URL is empty", () => {
    const cmds = buildCommands(makeArgs({ activeGameViewerUrl: "" }));
    expect(cmds.find((c) => c.id === "nav-current-game")).toBeUndefined();
  });

  it("every command has an action function", () => {
    const cmds = buildCommands(makeArgs());
    for (const c of cmds) {
      expect(typeof c.action).toBe("function");
    }
  });

  it("every command has a category", () => {
    const cmds = buildCommands(makeArgs());
    for (const c of cmds) {
      expect(["agent", "navigation", "refresh", "utility"]).toContain(
        c.category,
      );
    }
  });
});
