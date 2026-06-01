// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { MutableRefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingAgentSession,
  Conversation,
  ConversationMessage,
  ImageAttachment,
} from "../api";
import type { LoadConversationMessagesResult } from "./internal";
import { type UseChatSendDeps, useChatSend } from "./useChatSend";

const mocks = vi.hoisted(() => ({
  client: {
    abortConversationTurn: vi.fn(),
    createConversation: vi.fn(),
    createLifeOpsGoal: vi.fn(),
    sendConversationMessageStream: vi.fn(),
    sendWsMessage: vi.fn(),
    stopCodingAgent: vi.fn(),
  },
}));

vi.mock("../api", () => ({
  client: mocks.client,
}));

function conversation(id: string, roomId: string): Conversation {
  return {
    id,
    roomId,
    title: "New Chat",
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  };
}

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => res(value as T | PromiseLike<T>);
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortError(): Error {
  const err = new Error("aborted");
  err.name = "AbortError";
  return err;
}

function makeDeps(
  overrides: {
    activeConversationId?: string | null;
    conversations?: Conversation[];
    messages?: ConversationMessage[];
  } = {},
): UseChatSendDeps {
  const conversationsRef = {
    current: overrides.conversations ?? [],
  } as MutableRefObject<Conversation[]>;
  const conversationMessagesRef = {
    current: overrides.messages ?? [],
  } as MutableRefObject<ConversationMessage[]>;
  const chatPendingImagesRef = {
    current: [],
  } as MutableRefObject<ImageAttachment[]>;

  const setConversations: UseChatSendDeps["setConversations"] = (value) => {
    conversationsRef.current =
      typeof value === "function" ? value(conversationsRef.current) : value;
  };
  const setConversationMessages: UseChatSendDeps["setConversationMessages"] = (
    value,
  ) => {
    conversationMessagesRef.current =
      typeof value === "function"
        ? value(conversationMessagesRef.current)
        : value;
  };

  return {
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId: overrides.activeConversationId ?? null,
    ptySessionsRef: {
      current: [],
    } as MutableRefObject<CodingAgentSession[]>,
    setChatInput: vi.fn(),
    setChatSending: vi.fn(),
    setChatFirstTokenReceived: vi.fn(),
    setChatLastUsage: vi.fn(),
    setChatPendingImages: vi.fn(),
    setConversations,
    setActiveConversationId: vi.fn(),
    setCompanionMessageCutoffTs: vi.fn(),
    setConversationMessages,
    setUnreadConversations: vi.fn(),
    setActionNotice: vi.fn(),
    activeConversationIdRef: {
      current: overrides.activeConversationId ?? null,
    } as MutableRefObject<string | null>,
    chatInputRef: { current: "" } as MutableRefObject<string>,
    chatPendingImagesRef,
    conversationsRef,
    conversationMessagesRef,
    chatAbortRef: {
      current: null,
    } as MutableRefObject<AbortController | null>,
    chatSendBusyRef: {
      current: false,
    } as MutableRefObject<boolean>,
    chatSendNonceRef: { current: 0 },
    loadConversations: vi.fn(async () => conversationsRef.current),
    loadConversationMessages: vi.fn(
      async (): Promise<LoadConversationMessagesResult> => ({ ok: true }),
    ),
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    pollCloudCredits: vi.fn(async () => true),
  };
}

function mockStreamingUntilAbort(started: Deferred<void>) {
  mocks.client.sendConversationMessageStream.mockImplementation(
    (
      _id: string,
      _text: string,
      _onToken: (token: string, accumulatedText?: string) => void,
      _channelType: string,
      signal?: AbortSignal,
    ) => {
      started.resolve();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(abortError()), {
          once: true,
        });
      });
    },
  );
}

describe("useChatSend stop handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.abortConversationTurn.mockResolvedValue({
      aborted: true,
      roomId: "room-1",
      reason: "ui-chat-stop",
    });
    mocks.client.createLifeOpsGoal.mockReset();
    mocks.client.stopCodingAgent.mockResolvedValue(undefined);
  });

  it("aborts the backend turn using the latest conversation room id when Stop is clicked", async () => {
    const started = deferred();
    mockStreamingUntilAbort(started);
    const deps = makeDeps({
      activeConversationId: "conv-1",
      conversations: [conversation("conv-1", "room-1")],
    });
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hello", {
        conversationId: "conv-1",
      });
      await started.promise;
    });

    act(() => {
      result.current.handleChatStop();
    });

    await act(async () => {
      await sendPromise;
    });

    expect(mocks.client.abortConversationTurn).toHaveBeenCalledTimes(1);
    expect(mocks.client.abortConversationTurn).toHaveBeenCalledWith(
      "room-1",
      "ui-chat-stop",
    );
  });

  it("aborts a newly created conversation by the room id returned from creation", async () => {
    const started = deferred();
    mockStreamingUntilAbort(started);
    mocks.client.createConversation.mockResolvedValue({
      conversation: conversation("conv-new", "room-new"),
    });
    const deps = makeDeps();
    const { result } = renderHook(() => useChatSend(deps));

    let sendPromise: Promise<void> | undefined;
    await act(async () => {
      sendPromise = result.current.sendChatText("hello");
      await started.promise;
    });

    act(() => {
      result.current.handleChatStop();
    });

    await act(async () => {
      await sendPromise;
    });

    expect(mocks.client.abortConversationTurn).toHaveBeenCalledTimes(1);
    expect(mocks.client.abortConversationTurn).toHaveBeenCalledWith(
      "room-new",
      "ui-chat-stop",
    );
  });
});

describe("useChatSend LifeOps commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.createLifeOpsGoal.mockResolvedValue({
      goal: {
        title: "ship the upstream patches",
      },
      links: [],
    });
  });

  it("creates a LifeOps goal through the real client path", async () => {
    const deps = makeDeps({
      activeConversationId: "conv-lifeops",
      conversations: [conversation("conv-lifeops", "room-lifeops")],
      messages: [
        {
          id: "msg-1",
          role: "user",
          text: "We need real PR-ready LifeOps workstreams.",
          timestamp: 1780000000000,
        },
        {
          id: "msg-2",
          role: "assistant",
          text: "Next step is wiring goals into orchestrator tasks.",
          timestamp: 1780000001000,
        },
      ],
    });
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText(
        "/goal sprint ship the upstream patches",
      );
    });

    expect(mocks.client.createLifeOpsGoal).toHaveBeenCalledTimes(1);
    expect(mocks.client.createLifeOpsGoal).toHaveBeenCalledWith({
      title: "ship the upstream patches",
      metadata: expect.objectContaining({
        source: "chat_command",
        command: "/goal",
        lifeopsGoalStyle: expect.objectContaining({
          kind: "sprint",
          label: "Sprint",
        }),
        lifeopsGoalWorkstream: expect.objectContaining({
          enabled: true,
          autoSpawnAgent: true,
          framework: "codex",
          label: "GoalScout",
          roomId: "room-lifeops",
          recentContext: [
            {
              role: "user",
              text: "We need real PR-ready LifeOps workstreams.",
              timestamp: 1780000000000,
            },
            {
              role: "assistant",
              text: "Next step is wiring goals into orchestrator tasks.",
              timestamp: 1780000001000,
            },
          ],
        }),
      }),
    });
    expect(mocks.client.createConversation).not.toHaveBeenCalled();
    expect(mocks.client.sendConversationMessageStream).not.toHaveBeenCalled();
    expect(
      deps.conversationMessagesRef.current.map((message) => message.text),
    ).toContain(
      "Created LifeOps goal: ship the upstream patches\nStyle: Sprint\nWorkstream: queued with Codex subagent",
    );
  });

  it("returns usage without creating a goal when the title is missing", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useChatSend(deps));

    await act(async () => {
      await result.current.sendChatText("/goal sprint");
    });

    expect(mocks.client.createLifeOpsGoal).not.toHaveBeenCalled();
    expect(
      deps.conversationMessagesRef.current.map((message) => message.text),
    ).toContain(
      "Usage: /goal [ongoing|sprint|milestone|maintenance] <goal title>",
    );
  });
});
