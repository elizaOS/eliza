// @vitest-environment jsdom
//
// Unit coverage for the conversation-message prefetch cache + abortable load
// added for smooth swipe navigation: an adjacent conversation is warmed so a
// swipe paints instantly from memory, and a rapid swipe aborts the prior
// in-flight load so a stale fetch can never clobber the latest thread.

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../api";

const mocks = vi.hoisted(() => ({
  client: {
    getConversationMessages: vi.fn(),
    listConversations: vi.fn(async () => ({ conversations: [] })),
    getConfig: vi.fn(async () => ({ ui: {} })),
  },
}));

vi.mock("../api", () => ({ client: mocks.client }));

import { type DataLoadersDeps, useDataLoaders } from "./useDataLoaders";

function userMsg(id: string): ConversationMessage {
  return {
    id,
    role: "user",
    text: `msg-${id}`,
    timestamp: 0,
  } as ConversationMessage;
}

function assistantMsg(id: string): ConversationMessage {
  return {
    id,
    role: "assistant",
    text: `msg-${id}`,
    timestamp: 0,
  } as ConversationMessage;
}

function makeDeps() {
  const conversationMessagesRef = { current: [] as ConversationMessage[] };
  const activeConversationIdRef = { current: null as string | null };
  const greetingFiredRef = { current: false };
  const setConversationMessages = vi.fn((v: ConversationMessage[]) => {
    conversationMessagesRef.current = v;
  });
  const noop = () => {};
  const deps = {
    autonomousStoreRef: { current: {} },
    autonomousEventsRef: { current: [] },
    autonomousLatestEventIdRef: { current: null },
    autonomousRunHealthByRunIdRef: { current: {} },
    autonomousReplayInFlightRef: { current: false },
    setAutonomousEvents: noop,
    setAutonomousLatestEventId: noop,
    setAutonomousRunHealthByRunId: noop,
    activeConversationIdRef,
    conversationMessagesRef,
    greetingFiredRef,
    setConversations: vi.fn(),
    setActiveConversationId: vi.fn(),
    setConversationMessages,
    loadWalletConfig: async () => {},
    agentStatus: null,
    characterData: null,
    characterDraft: null,
    loadCharacter: async () => {},
    selectedVrmIndex: 0,
    firstRunComplete: false,
    uiLanguage: "en",
    setOwnerNameState: noop,
  } as unknown as DataLoadersDeps;
  return {
    deps,
    setConversationMessages,
    conversationMessagesRef,
    activeConversationIdRef,
  };
}

beforeEach(() => {
  mocks.client.getConversationMessages.mockReset();
  mocks.client.listConversations.mockReset();
  mocks.client.listConversations.mockResolvedValue({ conversations: [] });
});

describe("useDataLoaders — conversation message prefetch cache", () => {
  it("prefetch warms the cache so the next load paints synchronously (no network wait)", async () => {
    mocks.client.getConversationMessages.mockImplementation(
      async (id: string) => ({ messages: [userMsg(id)] }),
    );
    const { deps, setConversationMessages } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      result.current.prefetchConversationMessages(["conv-x"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.client.getConversationMessages).toHaveBeenCalledTimes(1);

    // The follow-up load paints from cache SYNCHRONOUSLY — before its own
    // revalidation fetch resolves — so a swiped-to neighbor never flashes empty.
    setConversationMessages.mockClear();
    let loadPromise: Promise<unknown>;
    act(() => {
      loadPromise = result.current.loadConversationMessages("conv-x");
    });
    expect(setConversationMessages).toHaveBeenCalledTimes(1);
    expect(setConversationMessages.mock.calls[0]?.[0]).toEqual([
      userMsg("conv-x"),
    ]);
    await act(async () => {
      await loadPromise;
    });
  });

  it("prefetch skips ids already cached or already in flight", async () => {
    mocks.client.getConversationMessages.mockImplementation(
      async (id: string) => ({ messages: [userMsg(id)] }),
    );
    const { deps } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      // Same id twice in one call → a single fetch (in-flight dedupe).
      result.current.prefetchConversationMessages(["c1", "c1"]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.client.getConversationMessages).toHaveBeenCalledTimes(1);

    // Now cached → a repeat prefetch issues no new fetch.
    await act(async () => {
      result.current.prefetchConversationMessages(["c1"]);
      await Promise.resolve();
    });
    expect(mocks.client.getConversationMessages).toHaveBeenCalledTimes(1);
  });

  it("clears stale messages immediately when loading an uncached conversation", async () => {
    let resolveConvB: ((m: ConversationMessage[]) => void) | undefined;
    mocks.client.getConversationMessages.mockImplementation(
      (id: string) =>
        new Promise((resolve) => {
          if (id === "conv-b") {
            resolveConvB = (m) => resolve({ messages: m });
          }
        }),
    );
    const { deps, setConversationMessages, conversationMessagesRef } =
      makeDeps();
    conversationMessagesRef.current = [userMsg("old-thread")];
    const { result } = renderHook(() => useDataLoaders(deps));

    let loadPromise: Promise<unknown>;
    act(() => {
      loadPromise = result.current.loadConversationMessages("conv-b");
    });

    expect(setConversationMessages).toHaveBeenCalledWith([]);
    expect(conversationMessagesRef.current).toEqual([]);

    await act(async () => {
      resolveConvB?.([userMsg("new-thread")]);
      await loadPromise;
    });
    expect(conversationMessagesRef.current).toEqual([userMsg("new-thread")]);
  });

  it("a newer load aborts the prior in-flight one so a stale fetch never wins", async () => {
    const resolvers: Record<string, (m: ConversationMessage[]) => void> = {};
    mocks.client.getConversationMessages.mockImplementation(
      (id: string, opts?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          resolvers[id] = (m) => resolve({ messages: m });
          opts?.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );
    const { deps, conversationMessagesRef } = makeDeps();
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      const p1 = result.current.loadConversationMessages("conv-a"); // fetch A
      const p2 = result.current.loadConversationMessages("conv-b"); // aborts A
      // Resolve B (the latest) and then A (the superseded, late) fetch.
      resolvers["conv-b"]?.([userMsg("b1")]);
      resolvers["conv-a"]?.([userMsg("a1")]);
      await Promise.allSettled([p1, p2]);
    });

    // Only the latest selection's messages reach the thread.
    expect(conversationMessagesRef.current).toEqual([userMsg("b1")]);
  });

  it("preserves local optimistic temp turns during same-conversation revalidation", async () => {
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [userMsg("persisted-1")] })
      .mockResolvedValueOnce({
        messages: [userMsg("persisted-1"), assistantMsg("server-late")],
      });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    conversationMessagesRef.current = [
      userMsg("persisted-1"),
      { ...userMsg("temp-user"), timestamp: 10 },
      { ...assistantMsg("temp-resp-user"), text: "", timestamp: 11 },
    ];
    setConversationMessages.mockClear();

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["persisted-1", "server-late", "temp-user", "temp-resp-user"]);
    expect(setConversationMessages).toHaveBeenLastCalledWith(
      conversationMessagesRef.current,
    );
  });

  it("drops optimistic temp turns once the server reload carries the same user and assistant turn", async () => {
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [userMsg("persisted-1")] })
      .mockResolvedValueOnce({
        messages: [
          userMsg("persisted-1"),
          { ...userMsg("server-user"), text: "hello", timestamp: 20 },
          {
            ...assistantMsg("server-assistant"),
            text: "hi there",
            timestamp: 21,
          },
        ],
      });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    conversationMessagesRef.current = [
      userMsg("persisted-1"),
      { ...userMsg("temp-100"), text: "hello", timestamp: 10 },
      {
        ...assistantMsg("temp-resp-100"),
        text: "hi there",
        timestamp: 11,
      },
    ];
    setConversationMessages.mockClear();

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["persisted-1", "server-user", "server-assistant"]);
    expect(
      conversationMessagesRef.current.some((message) =>
        message.id.startsWith("temp-"),
      ),
    ).toBe(false);
  });

  it("keeps an in-flight temp assistant when the server has only persisted the user turn", async () => {
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [userMsg("persisted-1")] })
      .mockResolvedValueOnce({
        messages: [
          userMsg("persisted-1"),
          { ...userMsg("server-user"), text: "hello", timestamp: 20 },
        ],
      });
    const {
      deps,
      setConversationMessages,
      conversationMessagesRef,
      activeConversationIdRef,
    } = makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    conversationMessagesRef.current = [
      userMsg("persisted-1"),
      { ...userMsg("temp-100"), text: "hello", timestamp: 10 },
      {
        ...assistantMsg("temp-resp-100"),
        text: "partial stream",
        timestamp: 11,
      },
    ];
    setConversationMessages.mockClear();

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual(["persisted-1", "server-user", "temp-resp-100"]);
  });

  it("keeps a distinct repeated temp user message when only the earlier identical turn is persisted", async () => {
    const firstUser = {
      ...userMsg("server-user-1"),
      text: "yes",
      timestamp: 1_000,
    };
    const firstAssistant = {
      ...assistantMsg("server-assistant-1"),
      text: "ok",
      timestamp: 2_000,
    };
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [firstUser, firstAssistant] })
      .mockResolvedValueOnce({ messages: [firstUser, firstAssistant] });
    const { deps, conversationMessagesRef, activeConversationIdRef } =
      makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    conversationMessagesRef.current = [
      firstUser,
      firstAssistant,
      { ...userMsg("temp-21000"), text: "yes", timestamp: 21_000 },
      {
        ...assistantMsg("temp-resp-21000"),
        text: "",
        timestamp: 21_100,
      },
    ];

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual([
      "server-user-1",
      "server-assistant-1",
      "temp-21000",
      "temp-resp-21000",
    ]);
  });

  it("keeps an identical in-flight streamed assistant when only the repeated user turn has persisted", async () => {
    const firstUser = {
      ...userMsg("server-user-1"),
      text: "ping",
      timestamp: 1_000,
    };
    const firstAssistant = {
      ...assistantMsg("server-assistant-1"),
      text: "ok",
      timestamp: 2_000,
    };
    const repeatedUser = {
      ...userMsg("server-user-2"),
      text: "ping",
      timestamp: 21_000,
    };
    mocks.client.getConversationMessages
      .mockResolvedValueOnce({ messages: [firstUser, firstAssistant] })
      .mockResolvedValueOnce({
        messages: [firstUser, firstAssistant, repeatedUser],
      });
    const { deps, conversationMessagesRef, activeConversationIdRef } =
      makeDeps();
    activeConversationIdRef.current = "conv-a";
    const { result } = renderHook(() => useDataLoaders(deps));

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });
    conversationMessagesRef.current = [
      firstUser,
      firstAssistant,
      { ...userMsg("temp-21000"), text: "ping", timestamp: 21_000 },
      {
        ...assistantMsg("temp-resp-21000"),
        text: "ok",
        timestamp: 22_000,
      },
    ];

    await act(async () => {
      await result.current.loadConversationMessages("conv-a");
    });

    expect(
      conversationMessagesRef.current.map((message) => message.id),
    ).toEqual([
      "server-user-1",
      "server-assistant-1",
      "server-user-2",
      "temp-resp-21000",
    ]);
  });
});
