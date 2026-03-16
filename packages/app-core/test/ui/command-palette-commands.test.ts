import { buildCommands as buildCommandPaletteCommands } from "@elizaos/app-core/chat";
import { describe, expect, it, vi } from "vitest";

function buildArgs(
  overrides: Partial<Parameters<typeof buildCommandPaletteCommands>[0]> = {},
) {
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

describe("buildCommandPaletteCommands", () => {
  it("does not include duplicate command ids", () => {
    const commands = buildCommandPaletteCommands(buildArgs());
    const ids = commands.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("includes start-agent only when stopped", () => {
    const stopped = buildCommandPaletteCommands(
      buildArgs({ agentState: "stopped" }),
    );
    const running = buildCommandPaletteCommands(
      buildArgs({ agentState: "running" }),
    );
    expect(stopped.some((command) => command.id === "start-agent")).toBe(true);
    expect(running.some((command) => command.id === "start-agent")).toBe(false);
  });

  it("includes nav-current-game only when a game is active", () => {
    const withGame = buildCommandPaletteCommands(
      buildArgs({ activeGameViewerUrl: "https://games.example/play" }),
    );
    const withoutGame = buildCommandPaletteCommands(
      buildArgs({ activeGameViewerUrl: "" }),
    );
    expect(withGame.some((command) => command.id === "nav-current-game")).toBe(
      true,
    );
    expect(
      withoutGame.some((command) => command.id === "nav-current-game"),
    ).toBe(false);
  });
});
