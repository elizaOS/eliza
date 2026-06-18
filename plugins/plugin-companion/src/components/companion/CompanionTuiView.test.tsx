// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const appState = vi.hoisted(() => ({
  uiLanguage: "en",
  setUiLanguage: vi.fn(),
  uiTheme: "dark",
  setUiTheme: vi.fn(),
  chatAgentVoiceMuted: false,
  chatLastUsage: { model: "gpt-test" },
  conversationMessages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi", interrupted: true },
  ],
  elizaCloudAuthRejected: false,
  elizaCloudConnected: true,
  elizaCloudCreditsError: null,
  elizaCloudEnabled: true,
  emotePickerOpen: false,
  openEmotePicker: vi.fn(),
  closeEmotePicker: vi.fn(),
  handleNewConversation: vi.fn(),
  navigation: { scheduleAfterTabCommit: vi.fn((fn: () => void) => fn()) },
  setState: vi.fn(),
  setTab: vi.fn(),
  t: (_key: string, options?: { defaultValue?: string }) =>
    options?.defaultValue ?? _key,
}));

const eventDispatchers = vi.hoisted(() => ({
  dispatchAppEvent: vi.fn(),
  dispatchAppEmoteEvent: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
  CharacterEditor: () => React.createElement("div"),
  ChatModalView: () => React.createElement("div"),
  dispatchAppEvent: eventDispatchers.dispatchAppEvent,
  dispatchAppEmoteEvent: eventDispatchers.dispatchAppEmoteEvent,
  STOP_EMOTE_EVENT: "eliza:stop-emote",
  useApp: () => appState,
  usePtySessions: () => ({ ptySessions: [] }),
  useRenderGuard: vi.fn(),
}));

vi.mock("./CompanionHeader", () => ({
  CompanionHeader: () => React.createElement("div"),
}));

vi.mock("./CompanionSceneHost", () => ({
  CompanionSceneHost: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
}));

vi.mock("./CompanionSettingsPanel", () => ({
  CompanionSettingsPanel: () => React.createElement("div"),
}));

vi.mock("./EmotePicker", () => ({
  EmotePicker: () => React.createElement("div"),
}));

vi.mock("./InferenceCloudAlertButton", () => ({
  InferenceCloudAlertButton: () =>
    React.createElement("button", { type: "button" }),
}));

import { AGENT_EMOTE_CATALOG, EMOTE_CATALOG } from "../../emotes/catalog";
import { CompanionTuiView } from "./CompanionView";
import { interact } from "./CompanionView.interact";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  appState.chatAgentVoiceMuted = false;
  appState.emotePickerOpen = false;
});

describe("CompanionTuiView", () => {
  it("mounts companion app state, emote metadata, and controls", () => {
    const { container } = render(React.createElement(CompanionTuiView));

    expect(screen.getByText("assistant messages 1")).toBeTruthy();
    expect(screen.getByText("last model gpt-test")).toBeTruthy();
    expect(screen.getByText("cloud connected yes")).toBeTruthy();

    const stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({
      viewType: "tui",
      viewId: "companion",
      voiceMuted: false,
      messageCount: 2,
      assistantCount: 1,
      userCount: 1,
      interruptedAssistantCount: 1,
      lastUsageModel: "gpt-test",
      elizaCloudConnected: true,
      elizaCloudEnabled: true,
      emotePickerOpen: false,
    });
  });

  it("wires terminal buttons to companion UI actions", () => {
    render(React.createElement(CompanionTuiView));

    fireEvent.click(screen.getByText("toggle voice"));
    expect(appState.setState).toHaveBeenCalledWith("chatAgentVoiceMuted", true);

    fireEvent.click(screen.getByText("new chat"));
    expect(appState.handleNewConversation).toHaveBeenCalled();

    fireEvent.click(screen.getByText("open emotes"));
    expect(appState.openEmotePicker).toHaveBeenCalled();

    fireEvent.click(screen.getByText("settings"));
    expect(appState.setState).toHaveBeenCalledWith("activeOverlayApp", null);
    expect(appState.setTab).toHaveBeenCalledWith("settings");
  });

  it("supports terminal capabilities for state, emotes, play, and stop", async () => {
    await expect(interact("terminal-companion-state")).resolves.toMatchObject({
      viewType: "tui",
      emoteCount: expect.any(Number),
      agentEmoteCount: expect.any(Number),
      capabilities: expect.arrayContaining(["terminal-companion-play-emote"]),
    });

    await expect(
      interact("terminal-companion-emotes", {
        category: "greeting",
        source: "agent",
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      emotes: expect.arrayContaining([
        expect.objectContaining({ id: "wave", category: "greeting" }),
      ]),
    });

    await expect(
      interact("terminal-companion-play-emote", { emote: "wave" }),
    ).resolves.toEqual({ viewType: "tui", played: "wave" });
    expect(eventDispatchers.dispatchAppEmoteEvent).toHaveBeenCalledWith(
      expect.objectContaining({ emoteId: "wave", showOverlay: true }),
    );

    await expect(interact("terminal-companion-stop-emote")).resolves.toEqual({
      viewType: "tui",
      stopped: true,
    });
    expect(eventDispatchers.dispatchAppEvent).toHaveBeenCalledWith(
      "eliza:stop-emote",
    );
  });

  it("rejects terminal-companion-play-emote for missing and unknown emotes", async () => {
    await expect(interact("terminal-companion-play-emote")).rejects.toThrow(
      "emote is required",
    );
    await expect(
      interact("terminal-companion-play-emote", { emote: "   " }),
    ).rejects.toThrow("emote is required");
    await expect(
      interact("terminal-companion-play-emote", { emote: "not-a-real-emote" }),
    ).rejects.toThrow("Unknown emote: not-a-real-emote");
    // No emote event is dispatched on the error paths.
    expect(eventDispatchers.dispatchAppEmoteEvent).not.toHaveBeenCalled();
  });

  it("returns the full catalog for terminal-companion-emotes with default source and no category", async () => {
    const all = (await interact("terminal-companion-emotes")) as {
      viewType: string;
      emotes: Array<{ id: string }>;
    };
    // Default source = "all" -> full EMOTE_CATALOG, no category filter.
    expect(all.viewType).toBe("tui");
    expect(all.emotes).toHaveLength(EMOTE_CATALOG.length);

    // source = "agent" returns the agent-allowed subset (excludes idle loop).
    const agent = (await interact("terminal-companion-emotes", {
      source: "agent",
    })) as { emotes: Array<{ id: string }> };
    expect(agent.emotes).toHaveLength(AGENT_EMOTE_CATALOG.length);
    expect(agent.emotes.length).toBeLessThan(all.emotes.length);
    expect(agent.emotes.some((e) => e.id === "idle")).toBe(false);

    // Each returned emote carries the contract fields the WS payload needs.
    const wave = all.emotes.find((e) => e.id === "wave") as
      | { id: string; path: string; duration: number; loop: boolean }
      | undefined;
    expect(wave).toBeDefined();
    expect(wave?.path.endsWith(".gz")).toBe(true);
    expect(typeof wave?.duration).toBe("number");
    expect(typeof wave?.loop).toBe("boolean");
  });

  it("rejects an unsupported capability", async () => {
    await expect(interact("terminal-companion-bogus")).rejects.toThrow(
      "Unsupported companion TUI capability: terminal-companion-bogus",
    );
  });

  it("shows the close-emotes branch and wires it to closeEmotePicker when the picker is open", () => {
    appState.emotePickerOpen = true;
    const { container } = render(React.createElement(CompanionTuiView));

    // Label reflects the open picker (open->"close emotes").
    const closeButton = screen.getByText("close emotes");
    expect(closeButton).toBeTruthy();
    expect(screen.queryByText("open emotes")).toBeNull();

    const stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({ emotePickerOpen: true });

    // Clicking it closes the picker (not open).
    fireEvent.click(closeButton);
    expect(appState.closeEmotePicker).toHaveBeenCalledTimes(1);
    expect(appState.openEmotePicker).not.toHaveBeenCalled();
  });
});
