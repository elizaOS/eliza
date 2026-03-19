// @vitest-environment jsdom

import {
  APP_EMOTE_EVENT,
  type AppEmoteEventDetail,
} from "@elizaos/app-core/events";
import type { Tab } from "@elizaos/app-core/navigation";
import React, { useEffect } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
          id: "conv-existing",
          title: "Existing Chat",
          roomId: "room-existing",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-02T00:00:00.000Z",
        },
      ],
    })),
    createConversation: vi.fn(async () => ({
      conversation: {
        id: "conv-created",
        title: "New Chat",
        roomId: "room-created",
        createdAt: "2026-02-03T00:00:00.000Z",
        updatedAt: "2026-02-03T00:00:00.000Z",
      },
      greeting: {
        text: "hello there",
        agentName: "Milady",
        generated: true,
        persisted: true,
      },
    })),
    getConversationMessages: vi.fn(async () => ({
      messages: [
        {
          id: "msg-existing",
          role: "assistant",
          text: "existing history",
          timestamp: Date.now(),
        },
      ],
    })),
    requestGreeting: vi.fn(async () => ({
      text: "hello there",
      agentName: "Milady",
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
    onWsEvent: vi.fn(() => () => { }),
    getAgentEvents: vi.fn(async () => ({
      events: [],
      latestEventId: null,
      totalBuffered: 0,
      replayed: true,
    })),
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
    hasCustomVrm: vi.fn(async () => false),
    hasCustomBackground: vi.fn(async () => false),
  },
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClient,
  SkillScanReportSummary: {},
}));

import { AppProvider, useApp } from "@elizaos/app-core/state";

type ProbeApi = {
  handleNewConversation: () => Promise<void>;
};

type Snapshot = {
  tab: Tab;
  uiShellMode: "native" | "companion";
};

function Probe(props: {
  onReady: (api: ProbeApi) => void;
  onChange: (snapshot: Snapshot) => void;
}) {
  const app = useApp();

  useEffect(() => {
    props.onReady({
      handleNewConversation: () => app.handleNewConversation(),
    });
  }, [app.handleNewConversation, props]);

  useEffect(() => {
    props.onChange({
      tab: app.tab,
      uiShellMode: app.uiShellMode,
    });
  }, [app.tab, app.uiShellMode, props]);

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

describe("companion greeting wave", () => {
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
          id: "conv-existing",
          title: "Existing Chat",
          roomId: "room-existing",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-02T00:00:00.000Z",
        },
      ],
    });
    mockClient.createConversation.mockResolvedValue({
      conversation: {
        id: "conv-created",
        title: "New Chat",
        roomId: "room-created",
        createdAt: "2026-02-03T00:00:00.000Z",
        updatedAt: "2026-02-03T00:00:00.000Z",
      },
      greeting: {
        text: "hello there",
        agentName: "Milady",
        generated: true,
        persisted: true,
      },
    });
    mockClient.getConversationMessages.mockResolvedValue({
      messages: [
        {
          id: "msg-existing",
          role: "assistant",
          text: "existing history",
          timestamp: Date.now(),
        },
      ],
    });
    mockClient.requestGreeting.mockResolvedValue({
      text: "hello there",
      agentName: "Milady",
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
    mockClient.sendWsMessage.mockImplementation(() => { });
    mockClient.connectWs.mockImplementation(() => { });
    mockClient.disconnectWs.mockImplementation(() => { });
    mockClient.saveStreamSettings.mockResolvedValue(undefined);
    mockClient.onWsEvent.mockReturnValue(() => { });
    mockClient.getAgentEvents.mockResolvedValue({
      events: [],
      latestEventId: null,
      totalBuffered: 0,
      replayed: true,
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
    mockClient.hasCustomVrm.mockResolvedValue(false);
    mockClient.hasCustomBackground.mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function renderApp(options?: {
    bootstrapConversation?: boolean;
  }): Promise<{
    api: ProbeApi;
    tree: TestRenderer.ReactTestRenderer;
    events: AppEmoteEventDetail[];
    snapshot: () => Snapshot | null;
  }> {
    const events: AppEmoteEventDetail[] = [];
    const handler = (event: Event) => {
      events.push((event as CustomEvent<AppEmoteEventDetail>).detail);
    };
    window.addEventListener(APP_EMOTE_EVENT, handler);

    let api: ProbeApi | null = null;
    let snapshot: Snapshot | null = null;
    let tree!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      tree = TestRenderer.create(
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
      expect(api).not.toBeNull();
      if (options?.bootstrapConversation) {
        expect(mockClient.createConversation).not.toHaveBeenCalled();
        expect(snapshot).toMatchObject({
          tab: "character-select",
          uiShellMode: "native",
        });
        return;
      }
      expect(mockClient.getConversationMessages).toHaveBeenCalledWith(
        "conv-existing",
      );
      expect(snapshot).toMatchObject({
        tab: "character-select",
        uiShellMode: "native",
      });
    });

    const resolvedApi = api;
    if (!resolvedApi) {
      throw new Error("App probe did not initialize");
    }

    const originalUnmount = tree.unmount.bind(tree);
    tree.unmount = () => {
      window.removeEventListener(APP_EMOTE_EVENT, handler);
      originalUnmount();
    };

    return {
      api: resolvedApi,
      tree,
      events,
      snapshot: () => snapshot,
    };
  }

  it("does not wave when launch resumes on character select without conversations", async () => {
    mockClient.listConversations.mockResolvedValue({
      conversations: [],
    });

    const { tree, events } = await renderApp({
      bootstrapConversation: true,
    });

    expect(events).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(1400);
    });

    expect(events).toHaveLength(0);

    await act(async () => {
      tree.unmount();
    });
  });

  it("does not wave after creating a new chat outside companion mode", async () => {
    const { api, tree, events } = await renderApp();

    await act(async () => {
      await api.handleNewConversation();
    });

    await act(async () => {
      vi.advanceTimersByTime(1400);
    });

    expect(events).toHaveLength(0);

    await act(async () => {
      tree.unmount();
    });
  });
});
