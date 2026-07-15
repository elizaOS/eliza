// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
    responding: false,
    turnStatus: null,
    recording: false,
    transcript: "",
    // Required ShellController surface the overlay reads unconditionally.
    modelStatus: { kind: "ready" },
    send: vi.fn(),
    stop: vi.fn(),
    toggleRecording: vi.fn(),
    handsFree: false,
    toggleHandsFree: vi.fn(),
    setDictationSink: vi.fn(),
    setTranscriptSessionSink: vi.fn(),
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
    source: "builtin",
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
    source: "builtin",
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
    surfaces: ["gui"],
    // Single infinite thread (#13531): the overlay treats clear-chat as inert.
    target: { kind: "client", clientAction: "clear-chat" },
    source: "builtin",
  },
  {
    key: "commands",
    nativeName: "commands",
    description: "Show commands",
    textAliases: ["/commands"],
    scope: "text",
    acceptsArgs: false,
    args: [],
    requiresAuth: false,
    requiresElevated: false,
    surfaces: ["gui"],
    // A client command the overlay STILL forwards — exercises the generic
    // client-action dispatch path now that clear-chat is inert (#13531).
    target: { kind: "client", clientAction: "open-command-palette" },
    source: "builtin",
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
    source: "builtin",
  },
];

function makeSlash(
  overrides: Partial<SlashCommandController> = {},
): SlashCommandController {
  return {
    commands: COMMANDS,
    loading: false,
    error: false,
    naturalShortcutsEnabled: false,
    isAuthorized: true,
    isElevated: true,
    resolveChoices: () => [],
    describeChoice: () => "",
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
  expect(
    (screen.getByLabelText("message") as HTMLTextAreaElement).placeholder,
  ).toBe("Ask Eliza");
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
    // `/commands` → open-command-palette, a client action the overlay still
    // forwards (clear-chat is intentionally inert under one-infinite-thread,
    // #13531).
    fireEvent.change(input, { target: { value: "/commands" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(slash.openCommandPalette).toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
  });

  it("Enter on /clear is inert — no clear, no send (single infinite thread, #13531)", () => {
    const slash = makeSlash();
    const { input, controller } = renderOverlay(slash);
    fireEvent.change(input, { target: { value: "/clear" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(slash.clearChat).not.toHaveBeenCalled();
    expect(controller.send).not.toHaveBeenCalled();
    // The draft is still consumed (the command resolved), not left in the box.
    expect(input.value).toBe("");
  });

  it("natural navigation stays inert when the feature flag is off", () => {
    const slash = makeSlash();
    const { input, controller } = renderOverlay(slash);
    fireEvent.change(input, { target: { value: "open settings" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(controller.send).toHaveBeenCalledWith("open settings");
    expect(slash.navigateSettings).not.toHaveBeenCalled();
  });

  it("feature-flagged natural navigation runs through the client command path", () => {
    const slash = makeSlash({ naturalShortcutsEnabled: true });
    const { input, controller } = renderOverlay(slash);
    fireEvent.change(input, { target: { value: "open settings" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(slash.navigateSettings).toHaveBeenCalledWith(undefined);
    expect(controller.send).not.toHaveBeenCalled();
    expect(input.value).toBe("");
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
    // The pick fires on click (pointer-down only guards composer focus) so a
    // touch drag-to-scroll can never execute a command — see SlashCommandMenu.
    fireEvent.click(screen.getByTestId("slash-option-0"));
    expect(slash.navigateView).toHaveBeenCalledWith({
      viewId: "orchestrator",
      viewPath: "/orchestrator",
    });
  });

  it("renders a sent slash command bold in the transcript", () => {
    const controller = makeController({
      messages: [
        { id: "u1", role: "user", content: "/help me out", createdAt: 1 },
      ],
    });
    const { input } = renderOverlay(makeSlash(), controller);
    fireEvent.focus(input);
    const tokens = screen.getAllByTestId("slash-command-token");
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens[0].textContent).toBe("/help");
    expect(tokens[0].className).toContain("font-bold");
  });

  it("does not bold a leading slash in an assistant turn", () => {
    const controller = makeController({
      messages: [
        { id: "a1", role: "assistant", content: "/help me out", createdAt: 1 },
      ],
    });
    renderOverlay(makeSlash(), controller);
    expect(screen.queryByTestId("slash-command-token")).toBeNull();
  });

  it("renders no menu when no slash controller is provided", () => {
    render(<ContinuousChatOverlay controller={makeController()} />);
    fireEvent.change(screen.getByLabelText("message"), {
      target: { value: "/settings" },
    });
    expect(screen.queryByTestId("slash-command-menu")).toBeNull();
  });
});
