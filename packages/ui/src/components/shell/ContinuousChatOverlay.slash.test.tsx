// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// usePromptSuggestions fetches via the shared client; stub it (as the sibling
// overlay test does) so the resting strip stays on its static fallback.
vi.mock("../../api/client", () => ({
  client: { fetch: vi.fn().mockRejectedValue(new Error("no api in test")) },
}));

import type { SlashCommandCatalogItem } from "../../chat/slash-menu";
import type { SlashCommandController } from "../../chat/useSlashCommandController";
import { ContinuousChatOverlay } from "./ContinuousChatOverlay";
import type { ShellController } from "./useShellController";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

function makeController(
  overrides: Partial<ShellController> = {},
): ShellController {
  return {
    phase: "summoned",
    messages: [{ id: "a", role: "assistant", content: "hi", createdAt: 1 }],
    canSend: true,
    recording: false,
    transcript: "",
    send: vi.fn(),
    toggleRecording: vi.fn(),
    handsFree: false,
    toggleHandsFree: vi.fn(),
    setDictationSink: vi.fn(),
    setComposerHasDraft: vi.fn(),
    clearConversation: vi.fn(),
    ...overrides,
  } as unknown as ShellController;
}

const COMMANDS: SlashCommandCatalogItem[] = [
  {
    key: "settings",
    nativeName: "settings",
    description: "Open settings",
    textAliases: ["/settings", "/preferences"],
    scope: "both",
    acceptsArgs: true,
    args: [
      {
        name: "section",
        description: "Section to open",
        choices: ["model", "voice", "connectors"],
      },
    ],
    requiresAuth: false,
    requiresElevated: false,
    target: { kind: "navigate", tab: "settings", path: "/settings" },
  },
  {
    key: "orchestrator",
    nativeName: "orchestrator",
    description: "Open orchestrator",
    textAliases: ["/orchestrator"],
    scope: "both",
    acceptsArgs: false,
    args: [],
    requiresAuth: false,
    requiresElevated: false,
    target: { kind: "navigate", viewId: "orchestrator", path: "/orchestrator" },
  },
  {
    key: "clear",
    nativeName: "clear",
    description: "Clear chat",
    textAliases: ["/clear"],
    scope: "text",
    acceptsArgs: false,
    args: [],
    requiresAuth: false,
    requiresElevated: false,
    surfaces: ["gui", "tui"],
    target: { kind: "client", clientAction: "clear-chat" },
  },
  {
    key: "help",
    nativeName: "help",
    description: "Show help",
    textAliases: ["/help"],
    scope: "both",
    acceptsArgs: false,
    args: [],
    requiresAuth: false,
    requiresElevated: false,
    target: { kind: "agent" },
  },
];

function makeSlash(
  overrides: Partial<SlashCommandController> = {},
): SlashCommandController {
  return {
    commands: COMMANDS,
    loading: false,
    resolveChoices: () => [],
    resolveSection: (t: string) =>
      ({ model: "ai-model", voice: "voice", connectors: "connectors" })[t],
    navigateTab: vi.fn(),
    navigateSettings: vi.fn(),
    navigateView: vi.fn(),
    clearChat: vi.fn(),
    openCommandPalette: vi.fn(),
    ...overrides,
  };
}

function renderOverlay(
  slash: SlashCommandController,
  controller = makeController(),
) {
  render(<ContinuousChatOverlay controller={controller} slash={slash} />);
  return {
    controller,
    input: screen.getByLabelText("message") as HTMLInputElement,
  };
}

describe("ContinuousChatOverlay slash commands", () => {
  it("opens the menu listing commands when the draft starts with /", () => {
    const { input } = renderOverlay(makeSlash());
    fireEvent.change(input, { target: { value: "/" } });
    expect(screen.getByTestId("slash-command-menu")).toBeTruthy();
    expect(screen.getByText("/settings")).toBeTruthy();
    expect(screen.getByText("/help")).toBeTruthy();
  });

  it("filters commands by the typed token", () => {
    const { input } = renderOverlay(makeSlash());
    fireEvent.change(input, { target: { value: "/set" } });
    expect(screen.getByText("/settings")).toBeTruthy();
    expect(screen.queryByText("/help")).toBeNull();
  });

  it("does NOT open for a multiline draft", () => {
    const { input } = renderOverlay(makeSlash());
    fireEvent.change(input, { target: { value: "/settings\nmore" } });
    expect(screen.queryByTestId("slash-command-menu")).toBeNull();
  });

  it("Enter on a navigate command runs navigation, not send", () => {
    const slash = makeSlash();
    const { input, controller } = renderOverlay(slash);
    fireEvent.change(input, { target: { value: "/settings" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(slash.navigateSettings).toHaveBeenCalledWith(undefined);
    expect(controller.send).not.toHaveBeenCalled();
    expect(input.value).toBe("");
  });

  it("Tab completes a command to drill into its arguments", () => {
    const { input } = renderOverlay(makeSlash());
    fireEvent.change(input, { target: { value: "/set" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input.value).toBe("/settings ");
    // Arg choices now show.
    expect(screen.getByText("model")).toBeTruthy();
    expect(screen.getByText("connectors")).toBeTruthy();
  });

  it("resolves a settings section from the argument on Enter", () => {
    const slash = makeSlash();
    const { input } = renderOverlay(slash);
    fireEvent.change(input, { target: { value: "/settings model" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(slash.navigateSettings).toHaveBeenCalledWith("ai-model");
  });

  it("Enter on a client command runs the client action", () => {
    const slash = makeSlash();
    const { input, controller } = renderOverlay(slash);
    fireEvent.change(input, { target: { value: "/clear" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(slash.clearChat).toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("Enter on an agent command sends the slash text", () => {
    const slash = makeSlash();
    const { input, controller } = renderOverlay(slash);
    fireEvent.change(input, { target: { value: "/help" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(vi.mocked(controller.send).mock.calls[0]?.[0]).toBe("/help");
    expect(input.value).toBe("");
  });

  it("ArrowDown moves the active option", () => {
    const { input } = renderOverlay(makeSlash());
    fireEvent.change(input, { target: { value: "/" } });
    const first = screen.getByTestId("slash-option-0");
    expect(first.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(
      screen.getByTestId("slash-option-1").getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("Escape dismisses the menu but keeps the draft", () => {
    const { input } = renderOverlay(makeSlash());
    fireEvent.change(input, { target: { value: "/set" } });
    expect(screen.getByTestId("slash-command-menu")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByTestId("slash-command-menu")).toBeNull();
    expect(input.value).toBe("/set");
  });

  it("clicking an option executes it", () => {
    const slash = makeSlash();
    const { input } = renderOverlay(slash);
    fireEvent.change(input, { target: { value: "/orchestrator" } });
    fireEvent.pointerDown(screen.getByTestId("slash-option-0"));
    expect(slash.navigateView).toHaveBeenCalledWith({
      viewId: "orchestrator",
      viewPath: "/orchestrator",
    });
  });

  it("renders no menu when no slash controller is provided", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "/settings" },
    });
    expect(screen.queryByTestId("slash-command-menu")).toBeNull();
  });
});
