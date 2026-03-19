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
    listConversations: vi.fn(async () => ({ conversations: [] })),
    createConversation: vi.fn(async () => ({
      conversation: {
        id: "conv-created",
        title: "Chat",
        roomId: "room-created",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
    })),
    getConversationMessages: vi.fn(async () => ({
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          text: "persisted",
          timestamp: Date.now(),
        },
      ],
    })),
    requestGreeting: vi.fn(async () => ({
      text: "hi",
      agentName: "Milady",
      generated: true,
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

vi.mock("@miladyai/app-core/api", () => ({
  client: mockClient,
  SkillScanReportSummary: {},
}));

import { AppProvider, useApp } from "@miladyai/app-core/state";

type StartupSnapshot = {
  onboardingLoading: boolean;
  startupPhase: ReturnType<typeof useApp>["startupPhase"];
  activeConversationId: string | null;
  conversationIds: string[];
};

function Probe(props: { onChange: (snapshot: StartupSnapshot) => void }) {
  const app = useApp();

  useEffect(() => {
    props.onChange({
      onboardingLoading: app.onboardingLoading,
      startupPhase: app.startupPhase,
      activeConversationId: app.activeConversationId,
      conversationIds: app.conversations.map((conversation) => conversation.id),
    });
  }, [
    app.onboardingLoading,
    app.startupPhase,
    app.activeConversationId,
    app.conversations,
    props,
  ]);

  return null;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

describe("startup conversation restore", () => {
  beforeEach(() => {
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
    mockClient.listConversations.mockResolvedValue({ conversations: [] });
    mockClient.createConversation.mockResolvedValue({
      conversation: {
        id: "conv-created",
        title: "Chat",
        roomId: "room-created",
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
    });
    mockClient.getConversationMessages.mockResolvedValue({
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          text: "persisted",
          timestamp: Date.now(),
        },
      ],
    });
    mockClient.requestGreeting.mockResolvedValue({
      text: "hi",
      agentName: "Milady",
      generated: true,
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

  it("waits for restored conversations before becoming ready or creating a new one", async () => {
    const restoredConversation = {
      id: "conv-restored",
      title: "Restored Chat",
      roomId: "room-restored",
      createdAt: "2026-02-01T00:00:00.000Z",
      updatedAt: "2026-02-02T00:00:00.000Z",
    };
    const deferred = createDeferred<{
      conversations: (typeof restoredConversation)[];
    }>();
    mockClient.listConversations.mockReturnValue(deferred.promise);

    let latest: StartupSnapshot | null = null;
    let tree!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onChange: (snapshot) => {
              latest = snapshot;
            },
          }),
        ),
      );
    });

    await flush();
    await flush();

    await waitFor(() => {
      expect(mockClient.getStatus).toHaveBeenCalled();
      expect(latest?.startupPhase).toBe("initializing-agent");
      expect(latest?.onboardingLoading).toBe(true);
    });

    expect(latest?.activeConversationId).toBeNull();
    expect(mockClient.createConversation).not.toHaveBeenCalled();
    expect(mockClient.connectWs).not.toHaveBeenCalled();

    deferred.resolve({ conversations: [restoredConversation] });

    await waitFor(() => {
      expect(latest?.startupPhase).toBe("ready");
      expect(latest?.onboardingLoading).toBe(false);
      expect(latest?.activeConversationId).toBe(restoredConversation.id);
      expect(latest?.conversationIds).toEqual([restoredConversation.id]);
    });

    expect(mockClient.createConversation).not.toHaveBeenCalled();
    expect(mockClient.requestGreeting).not.toHaveBeenCalled();
    expect(mockClient.getConversationMessages).toHaveBeenCalledWith(
      restoredConversation.id,
    );
    expect(mockClient.sendWsMessage).toHaveBeenCalledWith({
      type: "active-conversation",
      conversationId: restoredConversation.id,
    });
    expect(mockClient.connectWs).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.unmount();
    });
  });

  it("does not create an empty conversation when there is nothing to restore", async () => {
    let latest: StartupSnapshot | null = null;
    let tree!: TestRenderer.ReactTestRenderer;

    await act(async () => {
      tree = TestRenderer.create(
        React.createElement(
          AppProvider,
          null,
          React.createElement(Probe, {
            onChange: (snapshot) => {
              latest = snapshot;
            },
          }),
        ),
      );
    });

    await waitFor(() => {
      expect(latest?.startupPhase).toBe("ready");
      expect(latest?.onboardingLoading).toBe(false);
    });

    expect(latest?.activeConversationId).toBeNull();
    expect(latest?.conversationIds).toEqual([]);
    expect(mockClient.createConversation).not.toHaveBeenCalled();
    expect(mockClient.requestGreeting).not.toHaveBeenCalled();
    expect(mockClient.sendWsMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "active-conversation" }),
    );
    expect(mockClient.connectWs).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree.unmount();
    });
  });
});
