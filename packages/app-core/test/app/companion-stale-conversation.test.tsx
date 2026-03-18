// @vitest-environment jsdom

import {
  APP_EMOTE_EVENT,
  type AppEmoteEventDetail,
} from "@elizaos/app-core/events";
import React, { useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const UI_SHELL_MODE_STORAGE_KEY = "eliza:ui-shell-mode";
const THIRTY_ONE_MINUTES_MS = 31 * 60 * 1000;

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
          id: "conv-stale",
          title: "Old Chat",
          roomId: "room-stale",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    })),
    createConversation: vi.fn(async () => ({
      conversation: {
        id: "conv-fresh",
        title: "New Chat",
        roomId: "room-fresh",
        createdAt: "2026-02-02T00:00:00.000Z",
        updatedAt: "2026-02-02T00:00:00.000Z",
      },
      greeting: {
        text: "fresh tagline",
        agentName: "Eliza",
        generated: true,
        persisted: true,
      },
    })),
    getConversationMessages: vi.fn(async () => ({
      messages: [],
    })),
    requestGreeting: vi.fn(async () => ({
      text: "fresh tagline",
      agentName: "Eliza",
      generated: true,
      persisted: true,
    })),
    listCustomActions: vi.fn(async () => []),
    testCustomAction: vi.fn(async () => ({
      ok: true,
      output: "ok",
      durationMs: 5,
    })),
    rememberMemory: vi.fn(async () => ({
      ok: true,
      id: "mem-1",
      text: "saved",
      createdAt: Date.now(),
    })),
    searchMemory: vi.fn(async () => ({
      query: "q",
      results: [],
      count: 0,
      limit: 6,
    })),
    searchKnowledge: vi.fn(async () => ({
      query: "q",
      threshold: 0.2,
      results: [],
      count: 0,
    })),
    quickContext: vi.fn(async () => ({
      query: "q",
      answer: "quick answer",
      memories: [],
      knowledge: [],
    })),
    sendWsMessage: vi.fn(),
    connectWs: vi.fn(),
    disconnectWs: vi.fn(),
    saveStreamSettings: vi.fn(async () => undefined),
    onWsEvent: vi.fn(() => () => {}),
    getAgentEvents: vi.fn(async () => ({
      events: [],
      latestEventId: null,
      totalBuffered: 0,
      replayed: true,
    })),
    getStatus: vi.fn(async () => ({
      state: "running",
      agentName: "Eliza",
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
    hasCustomVrm: vi.fn(async () => false),
    hasCustomBackground: vi.fn(async () => false),
  },
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClient,
  SkillScanReportSummary: {},
}));

import { AppProvider, useApp } from "@elizaos/app-core/state";

type ConversationMessage = ReturnType<
  typeof useApp
>["conversationMessages"][number];
type Snapshot = {
  activeConversationId: string | null;
  conversationMessages: ConversationMessage[];
  onboardingLoading: boolean;
};

type ProbeApi = {
  switchShellView: ReturnType<typeof useApp>["switchShellView"];
};

function Probe(props: {
  onReady: (api: ProbeApi) => void;
  onChange: (snapshot: Snapshot) => void;
}) {
  const app = useApp();

  useEffect(() => {
    props.onReady({
      switchShellView: app.switchShellView,
    });
  }, [app.switchShellView, props]);

  useEffect(() => {
    props.onChange({
      activeConversationId: app.activeConversationId,
      conversationMessages: app.conversationMessages,
      onboardingLoading: app.onboardingLoading,
    });
  }, [
    app.activeConversationId,
    app.conversationMessages,
    app.onboardingLoading,
    props,
  ]);

  return null;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitFor(assertion: () => void): Promise<void> {
  for (let idx = 0; idx < 40; idx += 1) {
    try {
      assertion();
      return;
    } catch (err) {
      if (idx === 39) throw err;
      await flush();
    }
  }
}

describe("companion stale conversation rollover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/chat");
    Object.assign(window, {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });
    Object.assign(document.documentElement, { setAttribute: vi.fn() });

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
          id: "conv-stale",
          title: "Old Chat",
          roomId: "room-stale",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    });
    mockClient.createConversation.mockResolvedValue({
      conversation: {
        id: "conv-fresh",
        title: "New Chat",
        roomId: "room-fresh",
        createdAt: "2026-02-02T00:00:00.000Z",
        updatedAt: "2026-02-02T00:00:00.000Z",
      },
      greeting: {
        text: "fresh tagline",
        agentName: "Eliza",
        generated: true,
        persisted: true,
      },
    });
    mockClient.requestGreeting.mockResolvedValue({
      text: "fresh tagline",
      agentName: "Eliza",
      generated: true,
      persisted: true,
    });
    mockClient.listCustomActions.mockResolvedValue([]);
    mockClient.testCustomAction.mockResolvedValue({
      ok: true,
      output: "ok",
      durationMs: 5,
    });
    mockClient.rememberMemory.mockResolvedValue({
      ok: true,
      id: "mem-1",
      text: "saved",
      createdAt: Date.now(),
    });
    mockClient.searchMemory.mockResolvedValue({
      query: "q",
      results: [],
      count: 0,
      limit: 6,
    });
    mockClient.searchKnowledge.mockResolvedValue({
      query: "q",
      threshold: 0.2,
      results: [],
      count: 0,
    });
    mockClient.quickContext.mockResolvedValue({
      query: "q",
      answer: "quick answer",
      memories: [],
      knowledge: [],
    });
    mockClient.sendWsMessage.mockImplementation(() => {});
    mockClient.connectWs.mockImplementation(() => {});
    mockClient.disconnectWs.mockImplementation(() => {});
    mockClient.saveStreamSettings.mockResolvedValue(undefined);
    mockClient.onWsEvent.mockReturnValue(() => {});
    mockClient.getAgentEvents.mockResolvedValue({
      events: [],
      latestEventId: null,
      totalBuffered: 0,
      replayed: true,
    });
    mockClient.getStatus.mockResolvedValue({
      state: "running",
      agentName: "Eliza",
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
    mockClient.hasCustomVrm.mockResolvedValue(false);
    mockClient.hasCustomBackground.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts a fresh tagged conversation when entering companion with stale history", async () => {
    const staleTimestamp = Date.now() - THIRTY_ONE_MINUTES_MS;
    mockClient.getConversationMessages.mockResolvedValue({
      messages: [
        {
          id: "msg-user",
          role: "user",
          text: "hey",
          timestamp: staleTimestamp - 5_000,
        },
        {
          id: "msg-assistant",
          role: "assistant",
          text: "old reply",
          timestamp: staleTimestamp,
        },
      ],
    });
    localStorage.setItem(UI_SHELL_MODE_STORAGE_KEY, "native");

    let api: ProbeApi | null = null;
    let snapshot: Snapshot | null = null;
    const events: AppEmoteEventDetail[] = [];
    const handler = (event: Event) => {
      events.push((event as CustomEvent<AppEmoteEventDetail>).detail);
    };
    window.addEventListener(APP_EMOTE_EVENT, handler);

    await act(async () => {
      TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onReady: (nextApi) => {
              api = nextApi;
            },
            onChange: (nextSnapshot) => {
              snapshot = nextSnapshot;
            },
          }),
        ),
      );
    });

    await waitFor(() => {
      expect(snapshot).toMatchObject({
        activeConversationId: "conv-stale",
        onboardingLoading: false,
      });
    });
    expect(mockClient.createConversation).not.toHaveBeenCalled();

    await act(async () => {
      api?.switchShellView("companion");
    });

    await waitFor(() => {
      expect(mockClient.createConversation).toHaveBeenCalledTimes(1);
      expect(mockClient.createConversation).toHaveBeenCalledWith(undefined, {
        bootstrapGreeting: true,
        lang: "en",
      });
      expect(mockClient.sendWsMessage.mock.calls).toEqual(
        expect.arrayContaining([
          [
            expect.objectContaining({
              type: "active-conversation",
              conversationId: "conv-fresh",
            }),
          ],
        ]),
      );
      expect(mockClient.requestGreeting).not.toHaveBeenCalled();
      expect(snapshot?.onboardingLoading).toBe(false);
    });

    expect(events).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(1400);
    });

    expect(events).toHaveLength(1);
  });

  it("keeps a lone persisted greeting conversation even when it is old", async () => {
    mockClient.getConversationMessages.mockResolvedValue({
      messages: [
        {
          id: "msg-greeting",
          role: "assistant",
          text: "fresh tagline",
          timestamp: Date.now() - THIRTY_ONE_MINUTES_MS,
          source: "agent_greeting",
        },
      ],
    });
    localStorage.setItem(UI_SHELL_MODE_STORAGE_KEY, "companion");

    let snapshot: Snapshot | null = null;

    await act(async () => {
      TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onReady: () => {},
            onChange: (nextSnapshot) => {
              snapshot = nextSnapshot;
            },
          }),
        ),
      );
    });

    await waitFor(() => {
      expect(snapshot).toMatchObject({
        activeConversationId: "conv-stale",
        onboardingLoading: false,
      });
      expect(snapshot?.conversationMessages).toEqual([
        expect.objectContaining({
          id: "msg-greeting",
          source: "agent_greeting",
          text: "fresh tagline",
        }),
      ]);
    });

    expect(mockClient.createConversation).not.toHaveBeenCalled();
  });
});
