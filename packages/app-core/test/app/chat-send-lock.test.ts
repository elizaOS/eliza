/** @vitest-environment jsdom */
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
      agentName: "Eliza",
    })),
    truncateConversationMessages: vi.fn(async () => ({
      ok: true,
      deletedCount: 0,
    })),
    sendConversationMessageStream: vi.fn(async () => ({
      text: "ok",
      agentName: "Eliza",
    })),
    requestGreeting: vi.fn(async () => ({
      text: "hello",
      agentName: "Eliza",
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
  },
}));

vi.mock("@elizaos/app-core/api", () => ({
  client: mockClient,
  SkillScanReportSummary: {},
}));

import { AppProvider, useApp } from "@elizaos/app-core/state";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
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

describe("chat send locking", () => {
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
      agentName: "Eliza",
    });
    mockClient.truncateConversationMessages.mockResolvedValue({
      ok: true,
      deletedCount: 0,
    });
    mockClient.sendConversationMessageStream.mockResolvedValue({
      text: "ok",
      agentName: "Eliza",
    });
    mockClient.requestGreeting.mockResolvedValue({
      text: "hello",
      agentName: "Eliza",
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
    mockClient.getWorkbenchOverview.mockResolvedValue({
      tasks: [],
      triggers: [],
      todos: [],
    });
    mockClient.getCodingAgentStatus.mockResolvedValue(null);
  });

  it("allows only one same-tick chat send request", async () => {
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
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    expect(api).not.toBeNull();

    await act(async () => {
      await api?.handleSelectConversation("conv-1");
      api?.setChatInput("hello");
    });

    await act(async () => {
      void api?.handleChatSend();
      void api?.handleChatSend();
    });

    expect(mockClient.sendConversationMessageStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      deferred.resolve({ text: "ok", agentName: "Eliza" });
      await deferred.promise;
    });

    await act(async () => {
      tree?.unmount();
    });
  });

  it("sends image-only chat messages with a fallback prompt", async () => {
    let api: ProbeApi | null = null;
    let tree: TestRenderer.ReactTestRenderer;

    await act(async () => {
      tree = TestRenderer.create(
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

    expect(api).not.toBeNull();

    await act(async () => {
      await api?.handleSelectConversation("conv-1");
      api?.setChatInput("");
      api?.setChatPendingImages([
        {
          data: "aGVsbG8=",
          mimeType: "image/png",
          name: "proof.png",
        },
      ]);
    });

    await act(async () => {
      await api?.handleChatSend();
    });

    expect(mockClient.sendConversationMessageStream).toHaveBeenCalledWith(
      "conv-1",
      "Please review the attached image.",
      expect.any(Function),
      "simple",
      expect.any(AbortSignal),
      [
        {
          data: "aGVsbG8=",
          mimeType: "image/png",
          name: "proof.png",
        },
      ],
      "simple",
    );

    await act(async () => {
      tree?.unmount();
    });
  });

  it("releases lock when active-conversation sync throws before stream send", async () => {
    let api: ProbeApi | null = null;
    let tree: TestRenderer.ReactTestRenderer;

    await act(async () => {
      tree = TestRenderer.create(
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

    expect(api).not.toBeNull();

    await act(async () => {
      await api?.handleSelectConversation("conv-1");
      api?.setChatInput("hello");
    });

    mockClient.sendWsMessage.mockImplementationOnce(() => {
      throw new Error("ws boom");
    });

    await act(async () => {
      await expect(api?.handleChatSend()).rejects.toThrow("ws boom");
    });

    await act(async () => {
      api?.setChatInput("hello again");
      await api?.handleChatSend();
    });

    expect(mockClient.sendConversationMessageStream).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree?.unmount();
    });
  });

  it("keeps optimistic user message and updates assistant text as stream chunks arrive", async () => {
    const deferred = createDeferred<{ text: string; agentName: string }>();
    mockClient.sendConversationMessageStream.mockImplementation(
      async (
        _conversationId: string,
        _text: string,
        onToken: (token: string) => void,
      ) => {
        onToken("Hello");
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
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    expect(api).not.toBeNull();

    await act(async () => {
      await api?.handleSelectConversation("conv-1");
      api?.setChatInput("stream me");
    });

    let sendPromise: Promise<void> | null = null;
    await act(async () => {
      sendPromise = api?.handleChatSend();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      const snapshot = api?.snapshot();
      const optimisticUser = snapshot.conversationMessages.find(
        (message) => message.role === "user" && message.text === "stream me",
      );
      const streamedAssistant = snapshot.conversationMessages.find(
        (message) =>
          message.role === "assistant" && message.id.startsWith("temp-resp-"),
      );

      expect(optimisticUser).toBeDefined();
      expect(streamedAssistant?.text).toBe("Hello");
      expect(snapshot.chatSending).toBe(true);
      expect(snapshot.chatFirstTokenReceived).toBe(true);
    });

    await act(async () => {
      deferred.resolve({ text: "Hello world", agentName: "Eliza" });
      await sendPromise;
    });

    const finalSnapshot = api?.snapshot();
    const finalAssistant = [...finalSnapshot.conversationMessages]
      .reverse()
      .find((message) => message.role === "assistant");

    expect(finalAssistant?.text).toBe("Hello world");
    expect(finalSnapshot.chatSending).toBe(false);
    expect(finalSnapshot.chatFirstTokenReceived).toBe(false);

    await act(async () => {
      tree?.unmount();
    });
  });

  it("de-duplicates cumulative stream token updates", async () => {
    mockClient.sendConversationMessageStream.mockImplementation(
      async (
        _conversationId: string,
        _text: string,
        onToken: (token: string) => void,
      ) => {
        onToken("Hello ");
        onToken("Hello world");
        return { text: "Hello world", agentName: "Eliza" };
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
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    expect(api).not.toBeNull();

    await act(async () => {
      await api?.handleSelectConversation("conv-1");
      api?.setChatInput("stream me");
    });

    await act(async () => {
      await api?.handleChatSend();
    });

    const finalSnapshot = api?.snapshot();
    const finalAssistant = [...finalSnapshot.conversationMessages]
      .reverse()
      .find((message) => message.role === "assistant");

    expect(finalAssistant?.text).toBe("Hello world");
    expect(finalSnapshot.chatSending).toBe(false);
    expect(finalSnapshot.chatFirstTokenReceived).toBe(false);

    await act(async () => {
      tree?.unmount();
    });
  });

  it("drops empty assistant placeholders after silent action-only completions", async () => {
    mockClient.sendConversationMessageStream.mockResolvedValue({
      text: "",
      agentName: "Eliza",
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
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    expect(api).not.toBeNull();

    await act(async () => {
      await api?.handleSelectConversation("conv-1");
      api?.setChatInput("just emote");
    });

    await act(async () => {
      await api?.handleChatSend();
    });

    const snapshot = api?.snapshot();
    expect(
      snapshot?.conversationMessages.some((message) =>
        message.id.startsWith("temp-resp-"),
      ),
    ).toBe(false);
    expect(
      snapshot?.conversationMessages.some(
        (message) => message.role === "assistant" && !message.text.trim(),
      ),
    ).toBe(false);
    expect(
      snapshot?.conversationMessages.some(
        (message) => message.role === "user" && message.text === "just emote",
      ),
    ).toBe(true);

    await act(async () => {
      tree?.unmount();
    });
  });

  it("replaces streamed assistant text when a later chunk is a full snapshot", async () => {
    const deferred = createDeferred<{ text: string; agentName: string }>();
    mockClient.sendConversationMessageStream.mockImplementation(
      async (
        _conversationId: string,
        _text: string,
        onToken: (token: string) => void,
      ) => {
        onToken("world");
        onToken("Hello world");
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
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    expect(api).not.toBeNull();

    await act(async () => {
      await api?.handleSelectConversation("conv-1");
      api?.setChatInput("stream me");
    });

    let sendPromise: Promise<void> | null = null;
    await act(async () => {
      sendPromise = api?.handleChatSend();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      const snapshot = api?.snapshot();
      const streamedAssistant = snapshot.conversationMessages.find(
        (message) =>
          message.role === "assistant" && message.id.startsWith("temp-resp-"),
      );
      expect(streamedAssistant?.text).toBe("Hello world");
    });

    await act(async () => {
      deferred.resolve({ text: "Hello world", agentName: "Eliza" });
      await sendPromise;
    });

    await act(async () => {
      tree?.unmount();
    });
  });

  it("prefers accumulated stream text from the client over re-merging raw chunks", async () => {
    const deferred = createDeferred<{ text: string; agentName: string }>();
    mockClient.sendConversationMessageStream.mockImplementation(
      async (
        _conversationId: string,
        _text: string,
        onToken: (token: string, accumulatedText?: string) => void,
      ) => {
        onToken("world", "world");
        onToken("not-a-delta", "Hello world");
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
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    expect(api).not.toBeNull();

    await act(async () => {
      await api?.handleSelectConversation("conv-1");
      api?.setChatInput("stream me");
    });

    let sendPromise: Promise<void> | null = null;
    await act(async () => {
      sendPromise = api?.handleChatSend();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      const snapshot = api?.snapshot();
      const streamedAssistant = snapshot.conversationMessages.find(
        (message) =>
          message.role === "assistant" && message.id.startsWith("temp-resp-"),
      );
      expect(streamedAssistant?.text).toBe("Hello world");
    });

    await act(async () => {
      deferred.resolve({ text: "Hello world", agentName: "Eliza" });
      await sendPromise;
    });

    await act(async () => {
      tree?.unmount();
    });
  });

  it("edits a user message by truncating later history and resending it", async () => {
    mockClient.getConversationMessages.mockResolvedValue({
      messages: [
        {
          id: "user-1",
          role: "user",
          text: "hello",
          timestamp: 1,
        },
        {
          id: "assistant-1",
          role: "assistant",
          text: "hi",
          timestamp: 2,
        },
        {
          id: "user-2",
          role: "user",
          text: "question",
          timestamp: 3,
        },
        {
          id: "assistant-2",
          role: "assistant",
          text: "answer",
          timestamp: 4,
        },
      ],
    });
    mockClient.truncateConversationMessages.mockResolvedValue({
      ok: true,
      deletedCount: 2,
    });
    mockClient.sendConversationMessageStream.mockImplementation(
      async (
        _conversationId: string,
        _text: string,
        onToken: (token: string) => void,
      ) => {
        onToken("replacement");
        return {
          text: "replacement done",
          agentName: "Eliza",
          completed: true,
        };
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
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    expect(api).not.toBeNull();

    await act(async () => {
      await api?.handleSelectConversation("conv-1");
    });

    let edited = false;
    await act(async () => {
      edited =
        (await api?.handleChatEdit("user-2", "edited question")) ?? false;
    });

    expect(edited).toBe(true);
    expect(mockClient.truncateConversationMessages).toHaveBeenCalledWith(
      "conv-1",
      "user-2",
      { inclusive: true },
    );
    expect(mockClient.sendConversationMessageStream).toHaveBeenCalledWith(
      "conv-1",
      "edited question",
      expect.any(Function),
      "DM",
      expect.any(AbortSignal),
      undefined,
      "simple",
    );

    expect(api?.snapshot().conversationMessages).toEqual([
      {
        id: "user-1",
        role: "user",
        text: "hello",
        timestamp: 1,
        source: undefined,
      },
      {
        id: "assistant-1",
        role: "assistant",
        text: "hi",
        timestamp: 2,
        source: undefined,
      },
      expect.objectContaining({
        role: "user",
        text: "edited question",
      }),
      expect.objectContaining({
        role: "assistant",
        text: "replacement done",
      }),
    ]);

    await act(async () => {
      tree?.unmount();
    });
  });

  it("clears the active thread immediately before replacing it with a new greeting", async () => {
    const deferred = createDeferred<{
      conversation: {
        id: string;
        title: string;
        roomId: string;
        createdAt: string;
        updatedAt: string;
      };
      greeting: {
        text: string;
        persisted: boolean;
      };
    }>();
    mockClient.createConversation.mockImplementation(() => deferred.promise);

    let api: ProbeApi | null = null;
    let tree: TestRenderer.ReactTestRenderer;

    await act(async () => {
      tree = TestRenderer.create(
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

    expect(api).not.toBeNull();

    await act(async () => {
      await api?.handleSelectConversation("conv-1");
    });

    expect(api?.snapshot().conversationMessages).toEqual([
      expect.objectContaining({
        id: "msg-1",
        role: "assistant",
        text: "hello",
      }),
    ]);

    let newConversationPromise: Promise<void> | undefined;
    await act(async () => {
      newConversationPromise = api?.handleNewConversation();
      await Promise.resolve();
    });

    expect(api?.snapshot()).toEqual(
      expect.objectContaining({
        activeConversationId: null,
        chatSending: false,
        chatFirstTokenReceived: false,
        conversationMessages: [],
      }),
    );
    expect(mockClient.createConversation).toHaveBeenCalledWith(undefined, {
      basic-capabilitiesGreeting: true,
      lang: "en",
    });

    await act(async () => {
      deferred.resolve({
        conversation: {
          id: "conv-fresh",
          title: "Fresh chat",
          roomId: "room-fresh",
          createdAt: "2026-02-02T00:00:00.000Z",
          updatedAt: "2026-02-02T00:00:00.000Z",
        },
        greeting: {
          text: "Hey there.",
          persisted: false,
        },
      });
      await newConversationPromise;
    });

    expect(api?.snapshot()).toEqual(
      expect.objectContaining({
        activeConversationId: "conv-fresh",
        conversationMessages: [
          expect.objectContaining({
            role: "assistant",
            text: "Hey there.",
            source: "agent_greeting",
          }),
        ],
      }),
    );
    expect(mockClient.sendWsMessage).toHaveBeenCalledWith({
      type: "active-conversation",
      conversationId: "conv-fresh",
    });

    await act(async () => {
      tree?.unmount();
    });
  });

  it("preserves repeated characters in incremental token streams", async () => {
    const deferred = createDeferred<{ text: string; agentName: string }>();
    mockClient.sendConversationMessageStream.mockImplementation(
      async (
        _conversationId: string,
        _text: string,
        onToken: (token: string) => void,
      ) => {
        for (const token of [
          "H",
          "e",
          "l",
          "l",
          "o",
          " ",
          "w",
          "o",
          "r",
          "l",
          "d",
        ]) {
          onToken(token);
        }
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
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    expect(api).not.toBeNull();

    await act(async () => {
      await api?.handleSelectConversation("conv-1");
      api?.setChatInput("stream me");
    });

    let sendPromise: Promise<void> | null = null;
    await act(async () => {
      sendPromise = api?.handleChatSend();
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      const snapshot = api?.snapshot();
      const streamedAssistant = snapshot.conversationMessages.find(
        (message) =>
          message.role === "assistant" && message.id.startsWith("temp-resp-"),
      );
      expect(streamedAssistant?.text).toBe("Hello world");
      expect(snapshot.chatSending).toBe(true);
    });

    await act(async () => {
      deferred.resolve({ text: "Hello world", agentName: "Eliza" });
      await sendPromise;
    });

    await act(async () => {
      tree?.unmount();
    });
  });

  it("does not block stream completion on conversation list refresh", async () => {
    const refreshDeferred = createDeferred<{
      conversations: Array<{
        id: string;
        title: string;
        roomId: string;
        createdAt: string;
        updatedAt: string;
      }>;
    }>();

    mockClient.listConversations
      .mockResolvedValueOnce({
        conversations: [
          {
            id: "conv-1",
            title: "Chat",
            roomId: "room-1",
            createdAt: "2026-02-01T00:00:00.000Z",
            updatedAt: "2026-02-01T00:00:00.000Z",
          },
        ],
      })
      .mockImplementationOnce(async () => refreshDeferred.promise);

    mockClient.sendConversationMessageStream.mockResolvedValue({
      text: "done",
      agentName: "Eliza",
    });

    let api: ProbeApi | null = null;
    let tree: TestRenderer.ReactTestRenderer;

    await act(async () => {
      tree = TestRenderer.create(
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

    expect(api).not.toBeNull();

    await act(async () => {
      await api?.handleSelectConversation("conv-1");
      api?.setChatInput("quick response");
    });

    let resolved = false;
    await act(async () => {
      const promise = api?.handleChatSend() ?? Promise.resolve();
      promise.then(() => {
        resolved = true;
      });
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(resolved).toBe(true);
      expect(api?.snapshot().chatSending).toBe(false);
    });

    await act(async () => {
      refreshDeferred.resolve({
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
      await Promise.resolve();
    });

    await act(async () => {
      tree?.unmount();
    });
  });

  it("executes custom actions via slash commands without persisting chat", async () => {
    mockClient.listCustomActions.mockResolvedValue([
      {
        id: "action-1",
        name: "SAY_HELLO",
        description: "Says hello",
        parameters: [{ name: "name", description: "Name", required: true }],
        handler: { type: "code", code: "return 'ok';" },
        enabled: true,
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
    mockClient.testCustomAction.mockResolvedValue({
      ok: true,
      output: "Hello, Alice!",
      durationMs: 12,
    });

    let api: ProbeApi | null = null;
    let tree: TestRenderer.ReactTestRenderer;

    await act(async () => {
      tree = TestRenderer.create(
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
      await api?.handleSelectConversation("conv-1");
      api?.setChatInput("/say_hello name=Alice");
    });

    await act(async () => {
      await api?.handleChatSend();
    });

    expect(mockClient.testCustomAction).toHaveBeenCalledWith("action-1", {
      name: "Alice",
    });
    expect(mockClient.sendConversationMessageStream).toHaveBeenCalledTimes(0);
    const assistant = [...(api?.snapshot().conversationMessages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant");
    expect(assistant?.text).toContain("Hello, Alice!");

    await act(async () => {
      tree?.unmount();
    });
  });

  it("handles #remember by storing memory and skipping conversation send", async () => {
    let api: ProbeApi | null = null;
    let tree: TestRenderer.ReactTestRenderer;

    await act(async () => {
      tree = TestRenderer.create(
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
      await api?.handleSelectConversation("conv-1");
      api?.setChatInput("# remember we use typescript");
    });

    await act(async () => {
      await api?.handleChatSend();
    });

    expect(mockClient.rememberMemory).toHaveBeenCalledWith("we use typescript");
    expect(mockClient.sendConversationMessageStream).toHaveBeenCalledTimes(0);
    const assistant = [...(api?.snapshot().conversationMessages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant");
    expect(assistant?.text).toContain("Saved memory note");

    await act(async () => {
      tree?.unmount();
    });
  });

  it("rejects $ with trailing text and requires bare $", async () => {
    mockClient.quickContext.mockResolvedValue({
      query: "hello",
      answer: "Hi there.",
      memories: [
        { id: "m1", text: "we use typescript", createdAt: 1, score: 1 },
      ],
      knowledge: [
        {
          id: "k1",
          text: "Eliza is a TypeScript project",
          similarity: 0.91,
          documentTitle: "README.md",
        },
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
            onReady: (nextApi) => {
              api = nextApi;
            },
          }),
        ),
      );
    });

    await act(async () => {
      await api?.handleSelectConversation("conv-1");
      api?.setChatInput("$ hello");
    });

    await act(async () => {
      await api?.handleChatSend();
    });

    expect(mockClient.quickContext).toHaveBeenCalledTimes(0);
    expect(mockClient.sendConversationMessageStream).toHaveBeenCalledTimes(0);
    const assistant = [...(api?.snapshot().conversationMessages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant");
    expect(assistant?.text).toContain("Use bare `$` only");

    await act(async () => {
      tree?.unmount();
    });
  });

  it("handles bare $ as quick context shortcut", async () => {
    mockClient.quickContext.mockResolvedValue({
      query: "default",
      answer: "Default quick context.",
      memories: [],
      knowledge: [],
    });

    let api: ProbeApi | null = null;
    let tree: TestRenderer.ReactTestRenderer;

    await act(async () => {
      tree = TestRenderer.create(
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
      await api?.handleSelectConversation("conv-1");
      api?.setChatInput("$");
    });

    await act(async () => {
      await api?.handleChatSend();
    });

    expect(mockClient.quickContext).toHaveBeenCalledWith(
      "What is most relevant from memory and knowledge right now?",
      { limit: 6 },
    );
    expect(mockClient.sendConversationMessageStream).toHaveBeenCalledTimes(0);
    const assistant = [...(api?.snapshot().conversationMessages ?? [])]
      .reverse()
      .find((message) => message.role === "assistant");
    expect(assistant?.text).toContain("Default quick context.");

    await act(async () => {
      tree?.unmount();
    });
  });

  it("does not mark a fallback greeting basic-capabilities as an active chat send", async () => {
    const deferred = createDeferred<{
      text: string;
      agentName: string;
      generated: boolean;
      persisted: boolean;
    }>();
    mockClient.createConversation.mockResolvedValue({
      conversation: {
        id: "conv-fresh",
        title: "Fresh chat",
        roomId: "room-fresh",
        createdAt: "2026-02-02T00:00:00.000Z",
        updatedAt: "2026-02-02T00:00:00.000Z",
      },
      greeting: undefined,
    });
    mockClient.requestGreeting.mockReturnValue(deferred.promise);

    let api: ProbeApi | null = null;
    let tree: TestRenderer.ReactTestRenderer;

    await act(async () => {
      tree = TestRenderer.create(
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

    expect(api).not.toBeNull();

    await act(async () => {
      await api?.handleSelectConversation("conv-1");
    });

    await act(async () => {
      await api?.handleNewConversation();
    });

    await vi.waitFor(() => {
      expect(mockClient.requestGreeting).toHaveBeenCalledWith(
        "conv-fresh",
        "en",
      );
    });

    expect(api?.snapshot()).toEqual(
      expect.objectContaining({
        activeConversationId: "conv-fresh",
        chatSending: false,
        chatFirstTokenReceived: false,
        conversationMessages: [],
      }),
    );

    await act(async () => {
      deferred.resolve({
        text: "Hey there.",
        agentName: "Eliza",
        generated: true,
        persisted: false,
      });
      await Promise.resolve();
    });

    expect(api?.snapshot()).toEqual(
      expect.objectContaining({
        chatSending: false,
        conversationMessages: [
          expect.objectContaining({
            role: "assistant",
            text: "Hey there.",
            source: "agent_greeting",
          }),
        ],
      }),
    );

    await act(async () => {
      tree?.unmount();
    });
  });
});
