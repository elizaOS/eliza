/** @vitest-environment jsdom */
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
          id: "conv-1",
          title: "Chat",
          roomId: "room-1",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
    })),
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
          text: "hello",
          timestamp: Date.now(),
        },
      ],
    })),
    sendConversationMessage: vi.fn(async () => ({
      text: "ok",
      agentName: "Milady",
    })),
    truncateConversationMessages: vi.fn(async () => ({
      ok: true,
      deletedCount: 0,
    })),
    sendConversationMessageStream: vi.fn(async () => ({
      text: "ok",
      agentName: "Milady",
    })),
    requestGreeting: vi.fn(async () => ({
      text: "hello",
      agentName: "Milady",
      generated: true,
      persisted: false,
    })),
    listCustomActions: vi.fn(async () => []),
    testCustomAction: vi.fn(async () => ({
      ok: true,
      output: "ok",
      durationMs: 10,
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
    deleteConversation: vi.fn(async () => ({ ok: true })),
  },
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClient,
  SkillScanReportSummary: {},
}));

import { AppProvider, useApp } from "@elizaos/app-core/state";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type ProbeApi = {
  setChatInput: (text: string) => void;
  setChatPendingImages: (
    images: Array<{ data: string; mimeType: string; name: string }>,
  ) => void;
  handleSelectConversation: (id: string) => Promise<void>;
  handleChatSend: () => Promise<void>;
  handleChatEdit: (messageId: string, text: string) => Promise<boolean>;
  handleNewConversation: () => Promise<void>;
  snapshot: () => {
    activeConversationId: string | null;
    chatSending: boolean;
    chatFirstTokenReceived: boolean;
    conversationMessages: Array<{
      id: string;
      role: "user" | "assistant";
      text: string;
      timestamp: number;
      source?: string;
    }>;
  };
};

function Probe(props: { onReady: (api: ProbeApi) => void }) {
  const { onReady } = props;
  const app = useApp();

  useEffect(() => {
    onReady({
      setChatInput: (text: string) => app.setState("chatInput", text),
      setChatPendingImages: (images) => app.setChatPendingImages(images),
      handleSelectConversation: app.handleSelectConversation,
      handleChatSend: () => app.handleChatSend("simple"),
      handleChatEdit: app.handleChatEdit,
      handleNewConversation: app.handleNewConversation,
      snapshot: () => ({
        activeConversationId: app.activeConversationId,
        chatSending: app.chatSending,
        chatFirstTokenReceived: app.chatFirstTokenReceived,
        conversationMessages: app.conversationMessages.map((message) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          timestamp: message.timestamp,
          source: message.source,
        })),
      }),
    });
  }, [app, onReady]);

  return null;
}

function resetMockClient(): void {
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
      {
        id: "conv-2",
        title: "Second Chat",
        roomId: "room-2",
        createdAt: "2026-02-02T00:00:00.000Z",
        updatedAt: "2026-02-02T00:00:00.000Z",
      },
    ],
  });
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
        text: "hello",
        timestamp: Date.now(),
      },
    ],
  });
  mockClient.sendConversationMessage.mockResolvedValue({
    text: "ok",
    agentName: "Milady",
  });
  mockClient.truncateConversationMessages.mockResolvedValue({
    ok: true,
    deletedCount: 0,
  });
  mockClient.sendConversationMessageStream.mockResolvedValue({
    text: "ok",
    agentName: "Milady",
  });
  mockClient.requestGreeting.mockResolvedValue({
    text: "hello",
    agentName: "Milady",
    generated: true,
    persisted: false,
  });
  mockClient.listCustomActions.mockResolvedValue([]);
  mockClient.testCustomAction.mockResolvedValue({
    ok: true,
    output: "ok",
    durationMs: 10,
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
  mockClient.getWorkbenchOverview.mockResolvedValue({
    tasks: [],
    triggers: [],
    todos: [],
  });
  mockClient.getCodingAgentStatus.mockResolvedValue(null);
  mockClient.deleteConversation.mockResolvedValue({ ok: true });
}

// ---------------------------------------------------------------------------
// Part 1: Chat Journey Tests
// ---------------------------------------------------------------------------

describe("chat journey", () => {
  beforeEach(() => {
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
    resetMockClient();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Chat initialization
  // -------------------------------------------------------------------------
  describe("chat initialization", () => {
    it("loads conversation list from API after onboarding completes", async () => {
      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();
      expect(mockClient.listConversations).toHaveBeenCalled();

      await act(async () => {
        tree!.unmount();
      });
    });

    it("auto-selects first conversation and loads its messages", async () => {
      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();

      await act(async () => {
        await api!.handleSelectConversation("conv-1");
      });

      const snapshot = api!.snapshot();
      expect(snapshot.activeConversationId).toBe("conv-1");
      expect(mockClient.getConversationMessages).toHaveBeenCalledWith("conv-1");
      expect(snapshot.conversationMessages).toEqual([
        expect.objectContaining({
          id: "msg-1",
          role: "assistant",
          text: "hello",
        }),
      ]);

      await act(async () => {
        tree!.unmount();
      });
    });

    it("renders greeting message from API via new conversation bootstrap", async () => {
      mockClient.createConversation.mockResolvedValue({
        conversation: {
          id: "conv-new",
          title: "New Chat",
          roomId: "room-new",
          createdAt: "2026-02-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
        greeting: {
          text: "Welcome! How can I help you today?",
          persisted: false,
        },
      });

      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();

      // Select a conversation first so that handleNewConversation has a
      // previous active conversation to transition from.
      await act(async () => {
        await api!.handleSelectConversation("conv-1");
      });

      await act(async () => {
        await api!.handleNewConversation();
      });

      const snapshot = api!.snapshot();
      expect(snapshot.activeConversationId).toBe("conv-new");
      expect(snapshot.conversationMessages).toEqual([
        expect.objectContaining({
          role: "assistant",
          text: "Welcome! How can I help you today?",
          source: "agent_greeting",
        }),
      ]);

      await act(async () => {
        tree!.unmount();
      });
    });
  });

  // -------------------------------------------------------------------------
  // 2. Sending messages
  // -------------------------------------------------------------------------
  describe("sending messages", () => {
    it("sends message with correct payload via stream API", async () => {
      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();

      await act(async () => {
        await api!.handleSelectConversation("conv-1");
        api!.setChatInput("hello world");
      });

      await act(async () => {
        await api!.handleChatSend();
      });

      expect(mockClient.sendConversationMessageStream).toHaveBeenCalledWith(
        "conv-1",
        "hello world",
        expect.any(Function),
        "simple",
        expect.any(AbortSignal),
        undefined,
        "simple",
      );

      await act(async () => {
        tree!.unmount();
      });
    });

    it("shows optimistic user message immediately on send", async () => {
      const deferred = createDeferred<{ text: string; agentName: string }>();
      mockClient.sendConversationMessageStream.mockReturnValue(deferred.promise);

      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();

      await act(async () => {
        await api!.handleSelectConversation("conv-1");
        api!.setChatInput("my message");
      });

      await act(async () => {
        void api!.handleChatSend();
        await Promise.resolve();
      });

      await vi.waitFor(() => {
        const snapshot = api!.snapshot();
        const userMessage = snapshot.conversationMessages.find(
          (m) => m.role === "user" && m.text === "my message",
        );
        expect(userMessage).toBeDefined();
        expect(snapshot.chatSending).toBe(true);
      });

      await act(async () => {
        deferred.resolve({ text: "response", agentName: "Milady" });
        await deferred.promise;
      });

      await act(async () => {
        tree!.unmount();
      });
    });

    it("disables sending while message is in flight (send lock)", async () => {
      const deferred = createDeferred<{ text: string; agentName: string }>();
      mockClient.sendConversationMessageStream.mockReturnValue(deferred.promise);

      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();

      await act(async () => {
        await api!.handleSelectConversation("conv-1");
        api!.setChatInput("first");
      });

      await act(async () => {
        void api!.handleChatSend();
        void api!.handleChatSend(); // double-fire
      });

      // Only one call should go through (send lock)
      expect(mockClient.sendConversationMessageStream).toHaveBeenCalledTimes(1);

      await act(async () => {
        deferred.resolve({ text: "ok", agentName: "Milady" });
        await deferred.promise;
      });

      await act(async () => {
        tree!.unmount();
      });
    });

    it("does not send empty or whitespace-only messages", async () => {
      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();

      await act(async () => {
        await api!.handleSelectConversation("conv-1");
        api!.setChatInput("   ");
      });

      await act(async () => {
        await api!.handleChatSend();
      });

      expect(mockClient.sendConversationMessageStream).not.toHaveBeenCalled();

      await act(async () => {
        tree!.unmount();
      });
    });
  });

  // -------------------------------------------------------------------------
  // 3. Receiving responses
  // -------------------------------------------------------------------------
  describe("receiving responses", () => {
    it("appends streamed text progressively as tokens arrive", async () => {
      const deferred = createDeferred<{ text: string; agentName: string }>();
      mockClient.sendConversationMessageStream.mockImplementation(
        async (
          _conversationId: string,
          _text: string,
          onToken: (token: string) => void,
        ) => {
          onToken("Hello");
          onToken(" ");
          onToken("world");
          return deferred.promise;
        },
      );

      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();

      await act(async () => {
        await api!.handleSelectConversation("conv-1");
        api!.setChatInput("stream test");
      });

      let sendPromise: Promise<void> | null = null;
      await act(async () => {
        sendPromise = api!.handleChatSend();
        await Promise.resolve();
      });

      await vi.waitFor(() => {
        const snapshot = api!.snapshot();
        const streamedAssistant = snapshot.conversationMessages.find(
          (m) => m.role === "assistant" && m.id.startsWith("temp-resp-"),
        );
        expect(streamedAssistant).toBeDefined();
        expect(snapshot.chatFirstTokenReceived).toBe(true);
      });

      await act(async () => {
        deferred.resolve({ text: "Hello world", agentName: "Milady" });
        await sendPromise;
      });

      const finalSnapshot = api!.snapshot();
      const finalAssistant = [...finalSnapshot.conversationMessages]
        .reverse()
        .find((m) => m.role === "assistant");
      expect(finalAssistant?.text).toBe("Hello world");

      await act(async () => {
        tree!.unmount();
      });
    });

    it("shows final agent response after stream completes", async () => {
      mockClient.sendConversationMessageStream.mockResolvedValue({
        text: "Final answer",
        agentName: "Milady",
      });

      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();

      await act(async () => {
        await api!.handleSelectConversation("conv-1");
        api!.setChatInput("question");
      });

      await act(async () => {
        await api!.handleChatSend();
      });

      const snapshot = api!.snapshot();
      expect(snapshot.chatSending).toBe(false);
      const assistant = [...snapshot.conversationMessages]
        .reverse()
        .find((m) => m.role === "assistant");
      expect(assistant?.text).toBe("Final answer");

      await act(async () => {
        tree!.unmount();
      });
    });

    it("handles stream error gracefully without crashing", async () => {
      mockClient.sendConversationMessageStream.mockRejectedValue(
        new Error("Network error"),
      );

      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();

      await act(async () => {
        await api!.handleSelectConversation("conv-1");
        api!.setChatInput("will fail");
      });

      // Should not throw out of the act boundary
      await act(async () => {
        try {
          await api!.handleChatSend();
        } catch {
          // expected
        }
      });

      // chatSending should be released after error
      const snapshot = api!.snapshot();
      expect(snapshot.chatSending).toBe(false);

      await act(async () => {
        tree!.unmount();
      });
    });
  });

  // -------------------------------------------------------------------------
  // 4. Conversation management
  // -------------------------------------------------------------------------
  describe("conversation management", () => {
    it("creates a new conversation via API", async () => {
      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();

      await act(async () => {
        await api!.handleNewConversation();
      });

      expect(mockClient.createConversation).toHaveBeenCalledWith(undefined, {
        bootstrapGreeting: true,
        lang: "en",
      });

      await act(async () => {
        tree!.unmount();
      });
    });

    it("switches conversations and loads messages for selected conversation", async () => {
      // First call returns conv-1 messages with a user message (prevents deletion)
      mockClient.getConversationMessages
        .mockResolvedValueOnce({
          messages: [
            { id: "msg-u1", role: "user", text: "user said something", timestamp: 1 },
            { id: "msg-1", role: "assistant", text: "hello from conv-1", timestamp: 2 },
          ],
        })
        .mockResolvedValueOnce({
          messages: [
            { id: "msg-2", role: "assistant", text: "hello from conv-2", timestamp: 3 },
          ],
        });

      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();

      await act(async () => {
        await api!.handleSelectConversation("conv-1");
      });

      expect(api!.snapshot().activeConversationId).toBe("conv-1");
      expect(api!.snapshot().conversationMessages[0].text).toBe("user said something");

      await act(async () => {
        await api!.handleSelectConversation("conv-2");
      });

      expect(api!.snapshot().activeConversationId).toBe("conv-2");
      expect(mockClient.getConversationMessages).toHaveBeenCalledWith("conv-2");
      expect(api!.snapshot().conversationMessages[0].text).toBe("hello from conv-2");

      await act(async () => {
        tree!.unmount();
      });
    });

    it("syncs active conversation via WebSocket on selection", async () => {
      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();

      await act(async () => {
        await api!.handleSelectConversation("conv-1");
      });

      expect(mockClient.sendWsMessage).toHaveBeenCalledWith({
        type: "active-conversation",
        conversationId: "conv-1",
      });

      await act(async () => {
        tree!.unmount();
      });
    });
  });

  // -------------------------------------------------------------------------
  // 5. Error handling
  // -------------------------------------------------------------------------
  describe("error handling", () => {
    it("releases send lock after stream network error so retry is possible", async () => {
      mockClient.sendConversationMessageStream
        .mockRejectedValueOnce(new Error("Network error"))
        .mockResolvedValueOnce({
          text: "retry success",
          agentName: "Milady",
        });

      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();

      await act(async () => {
        await api!.handleSelectConversation("conv-1");
        api!.setChatInput("will fail first");
      });

      await act(async () => {
        try {
          await api!.handleChatSend();
        } catch {
          // expected first failure
        }
      });

      expect(api!.snapshot().chatSending).toBe(false);

      // Retry should succeed
      await act(async () => {
        api!.setChatInput("retry message");
      });

      await act(async () => {
        await api!.handleChatSend();
      });

      expect(mockClient.sendConversationMessageStream).toHaveBeenCalledTimes(2);

      await act(async () => {
        tree!.unmount();
      });
    });

    it("handles empty assistant response without leaving ghost messages", async () => {
      mockClient.sendConversationMessageStream.mockResolvedValue({
        text: "",
        agentName: "Milady",
        completed: true,
      });

      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();

      await act(async () => {
        await api!.handleSelectConversation("conv-1");
        api!.setChatInput("action only");
      });

      await act(async () => {
        await api!.handleChatSend();
      });

      const snapshot = api!.snapshot();
      // No empty assistant messages should remain
      expect(
        snapshot.conversationMessages.some(
          (m) => m.role === "assistant" && !m.text.trim(),
        ),
      ).toBe(false);
      // Temp response IDs should be cleaned up
      expect(
        snapshot.conversationMessages.some((m) => m.id.startsWith("temp-resp-")),
      ).toBe(false);

      await act(async () => {
        tree!.unmount();
      });
    });

    it("clears chatSending flag even when stream promise rejects", async () => {
      mockClient.sendConversationMessageStream.mockRejectedValue(
        new Error("server error"),
      );

      let api: ProbeApi | null = null;
      let tree: TestRenderer.ReactTestRenderer;

      await act(async () => {
        tree = TestRenderer.create(
          React.createElement(
            AppProvider,
            null,
            React.createElement(Probe, {
              onReady: (nextApi) => { api = nextApi; },
            }),
          ),
        );
      });

      expect(api).not.toBeNull();

      await act(async () => {
        await api!.handleSelectConversation("conv-1");
        api!.setChatInput("trigger error");
      });

      await act(async () => {
        try {
          await api!.handleChatSend();
        } catch {
          // expected
        }
      });

      expect(api!.snapshot().chatSending).toBe(false);
      expect(api!.snapshot().chatFirstTokenReceived).toBe(false);

      await act(async () => {
        tree!.unmount();
      });
    });
  });
});
