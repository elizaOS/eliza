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

import { CompanionTuiView, interact } from "./CompanionView";

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
});
