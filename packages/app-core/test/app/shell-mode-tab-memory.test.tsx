// @vitest-environment jsdom

import React, { useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockClient } = vi.hoisted(() => ({
  mockClient: {
    hasToken: vi.fn(() => false),
    getAuthStatus: vi.fn(async () => ({
      required: false,
      pairingEnabled: false,
      expiresAt: null,
    })),
    getOnboardingStatus: vi.fn(async () => ({ complete: true })),
    listConversations: vi.fn(async () => ({
      conversations: [
        {
          id: "conv-1",
          title: "Chat",
          roomId: "room-1",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    })),
    getConversationMessages: vi.fn(async () => ({
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          text: "hello",
          timestamp: Date.now(),
        },
      ],
    })),
    sendWsMessage: vi.fn(),
    connectWs: vi.fn(),
    disconnectWs: vi.fn(),
    onWsEvent: vi.fn(() => () => {}),
    getAgentEvents: vi.fn(async () => ({ events: [], latestEventId: null })),
    getStatus: vi.fn(async () => ({
      state: "running",
      agentName: "Milady",
      model: undefined,
      startedAt: undefined,
      uptime: undefined,
    })),
    getWalletAddresses: vi.fn(async () => null),
    getConfig: vi.fn(async () => ({})),
    getCloudStatus: vi.fn(async () => ({ enabled: false, connected: false })),
    getCodingAgentStatus: vi.fn(async () => null),
    getWorkbenchOverview: vi.fn(async () => ({
      tasks: [],
      triggers: [],
      todos: [],
    })),
  },
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClient,
  SkillScanReportSummary: {},
}));

import type { Tab } from "@elizaos/app-core/navigation";
import type { ShellView, UiShellMode } from "@elizaos/app-core/state";
import { AppProvider, useApp } from "@elizaos/app-core/state";

type ProbeApi = {
  getSnapshot: () => { tab: Tab; uiShellMode: UiShellMode };
  setTab: (tab: Tab) => void;
  switchShellView: (view: ShellView) => void;
};

function Probe({ onReady }: { onReady: (api: ProbeApi) => void }) {
  const app = useApp();

  useEffect(() => {
    onReady({
      getSnapshot: () => ({
        tab: app.tab,
        uiShellMode: app.uiShellMode,
      }),
      setTab: app.setTab,
      switchShellView: app.switchShellView,
    });
  }, [app, onReady]);

  return null;
}

describe("shell view routing", () => {
  beforeEach(() => {
    Object.assign(window.location, {
      protocol: "file:",
      hash: "#/chat",
      pathname: "/chat",
    });
    Object.assign(window, {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });
    Object.assign(document.documentElement, { setAttribute: vi.fn() });
    localStorage.clear();

    for (const fn of Object.values(mockClient)) {
      if (typeof fn === "function" && "mockReset" in fn) {
        (fn as { mockReset: () => void }).mockReset();
      }
    }

    mockClient.hasToken.mockReturnValue(false);
    mockClient.getAuthStatus.mockResolvedValue({
      required: false,
      pairingEnabled: false,
      expiresAt: null,
    });
    mockClient.getOnboardingStatus.mockResolvedValue({ complete: true });
    mockClient.listConversations.mockResolvedValue({
      conversations: [
        {
          id: "conv-1",
          title: "Chat",
          roomId: "room-1",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    });
    mockClient.getConversationMessages.mockResolvedValue({
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          text: "hello",
          timestamp: Date.now(),
        },
      ],
    });
    mockClient.sendWsMessage.mockImplementation(() => {});
    mockClient.connectWs.mockImplementation(() => {});
    mockClient.disconnectWs.mockImplementation(() => {});
    mockClient.onWsEvent.mockReturnValue(() => {});
    mockClient.getAgentEvents.mockResolvedValue({
      events: [],
      latestEventId: null,
    });
    mockClient.getStatus.mockResolvedValue({
      state: "running",
      agentName: "Milady",
      model: undefined,
      startedAt: undefined,
      uptime: undefined,
    });
    mockClient.getWalletAddresses.mockResolvedValue(null);
    mockClient.getConfig.mockResolvedValue({});
    mockClient.getCloudStatus.mockResolvedValue({
      enabled: false,
      connected: false,
    });
    mockClient.getCodingAgentStatus.mockResolvedValue(null);
    mockClient.getWorkbenchOverview.mockResolvedValue({
      tasks: [],
      triggers: [],
      todos: [],
    });
  });

  it("opens character from the middle shell toggle option", async () => {
    let api: ProbeApi | null = null;

    await act(async () => {
      TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    expect(api?.getSnapshot().uiShellMode).toBe("companion");
    expect(api?.getSnapshot().tab).toBe("chat");

    await act(async () => {
      api?.switchShellView("character");
    });

    expect(api?.getSnapshot()).toEqual({
      tab: "character-select",
      uiShellMode: "native",
    });
  });

  it("restores the remembered desktop tab from the desktop toggle option", async () => {
    let api: ProbeApi | null = null;

    await act(async () => {
      TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    await act(async () => {
      api?.switchShellView("desktop");
      api?.setTab("settings");
    });

    expect(api?.getSnapshot()).toEqual({
      tab: "settings",
      uiShellMode: "native",
    });

    await act(async () => {
      api?.switchShellView("companion");
    });

    expect(api?.getSnapshot()).toEqual({
      tab: "companion",
      uiShellMode: "companion",
    });

    await act(async () => {
      api?.switchShellView("desktop");
    });

    expect(api?.getSnapshot()).toEqual({
      tab: "settings",
      uiShellMode: "native",
    });
  });

  it("defaults desktop view to chat when no desktop tab has been remembered", async () => {
    let api: ProbeApi | null = null;

    await act(async () => {
      TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    await act(async () => {
      api?.switchShellView("desktop");
    });

    expect(api?.getSnapshot()).toEqual({
      tab: "chat",
      uiShellMode: "native",
    });

    await act(async () => {
      api?.switchShellView("companion");
    });

    expect(api?.getSnapshot()).toEqual({
      tab: "companion",
      uiShellMode: "companion",
    });
  });
});
