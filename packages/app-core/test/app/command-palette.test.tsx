// @vitest-environment jsdom
import React from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUseApp, mockUseBugReport } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
  mockUseBugReport: vi.fn(() => ({ open: vi.fn() })),
}));

vi.mock("@elizaos/app-core/state", () => ({
  useApp: () => mockUseApp(),
}));

vi.mock("@elizaos/app-core/hooks", () => ({
  useBugReport: () => mockUseBugReport(),
  BugReportProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { CommandPalette } from "@elizaos/app-core/components/CommandPalette";

type PaletteContext = {
  commandPaletteOpen: boolean;
  commandQuery: string;
  commandActiveIndex: number;
  agentStatus: { state: string };
  handleStart: () => void;

  handleRestart: () => void;
  setTab: (tab: string) => void;
  loadPlugins: () => void;
  loadSkills: () => void;
  loadLogs: () => void;
  loadWorkbench: () => void;
  handleChatClear: () => void;
  activeGameViewerUrl: string;
  setState: (key: string, value: unknown) => void;
  closeCommandPalette: () => void;
  currentTheme: string;
  setTheme: (theme: string) => void;
};

function createContext(
  overrides?: Partial<PaletteContext>,
): PaletteContext & Record<string, unknown> {
  return {
    t: (k: string) => k,
    commandPaletteOpen: true,
    commandQuery: "",
    commandActiveIndex: 0,
    agentStatus: { state: "running" },
    handleStart: vi.fn(),

    handleRestart: vi.fn(),
    setTab: vi.fn(),
    loadPlugins: vi.fn(),
    loadSkills: vi.fn(),
    loadLogs: vi.fn(),
    loadWorkbench: vi.fn(),
    handleChatClear: vi.fn(),
    activeGameViewerUrl: "",
    setState: vi.fn(),
    closeCommandPalette: vi.fn(),
    currentTheme: "dark",
    setTheme: vi.fn(),
    ...(overrides ?? {}),
  };
}

function nodeText(node: TestRenderer.ReactTestInstance): string {
  if (typeof node.children[0] === "string") return node.children[0];
  if (node.children) {
    return node.children
      .map((c) =>
        typeof c === "string"
          ? c
          : nodeText(c as TestRenderer.ReactTestInstance),
      )
      .join("");
  }
  return "";
}

let addListenerSpy: ReturnType<typeof vi.spyOn>;

function getWindowKeydownHandler(): (e: KeyboardEvent) => void {
  const keydownCall = addListenerSpy.mock.calls.find(
    (call: unknown[]) => call[0] === "keydown",
  );

  if (!keydownCall || typeof keydownCall[1] !== "function") {
    throw new Error("Expected keydown listener to be registered");
  }

  return keydownCall[1] as (e: KeyboardEvent) => void;
}

describe("CommandPalette keyboard behavior", () => {
  beforeEach(() => {
    mockUseApp.mockReset();
    vi.restoreAllMocks();
    addListenerSpy = vi.spyOn(window, "addEventListener");
  });

  it("handles arrow navigation when no commands match", () => {
    const ctx = createContext({
      commandQuery: "this-will-not-match-any-command",
      commandActiveIndex: 0,
    });
    mockUseApp.mockReturnValue(ctx);

    act(() => {
      TestRenderer.create(React.createElement(CommandPalette));
    });

    vi.mocked(ctx.setState).mockClear();
    const keydown = getWindowKeydownHandler();

    const preventDefaultUp = vi.fn();
    const preventDefaultDown = vi.fn();

    act(() => {
      keydown({
        key: "ArrowUp",
        preventDefault: preventDefaultUp,
      } as KeyboardEvent);
      keydown({
        key: "ArrowDown",
        preventDefault: preventDefaultDown,
      } as KeyboardEvent);
    });

    // When no commands match, arrow keys return early without preventDefault
    expect(preventDefaultUp).not.toHaveBeenCalled();
    expect(preventDefaultDown).not.toHaveBeenCalled();
  });

  it("renders command buttons for available commands", () => {
    const ctx = createContext({
      commandActiveIndex: 0,
    });
    mockUseApp.mockReturnValue(ctx);

    let tree!: TestRenderer.ReactTestRenderer;
    act(() => {
      tree = TestRenderer.create(React.createElement(CommandPalette));
    });

    const _input = tree.root.find((node) => node.type === "input");
    const commandButtons = tree.root.findAll(
      (node: TestRenderer.ReactTestInstance) =>
        node.type === "button" &&
        nodeText(node).length > 0 &&
        !node.props["aria-label"],
    );

    // Component should render at least one command button
    expect(commandButtons.length).toBeGreaterThan(0);
  });

  it("handles Enter when no commands match", () => {
    const ctx = createContext({
      commandQuery: "this-will-not-match-any-command",
      commandActiveIndex: 0,
    });
    mockUseApp.mockReturnValue(ctx);

    act(() => {
      TestRenderer.create(React.createElement(CommandPalette));
    });

    const keydown = getWindowKeydownHandler();
    const preventDefault = vi.fn();

    act(() => {
      keydown({ key: "Enter", preventDefault } as KeyboardEvent);
    });

    // When no commands match, Enter returns early without preventDefault
    expect(preventDefault).not.toHaveBeenCalled();
    // closeCommandPalette should not be called since no command was executed
    expect(ctx.closeCommandPalette).not.toHaveBeenCalled();
  });
});
