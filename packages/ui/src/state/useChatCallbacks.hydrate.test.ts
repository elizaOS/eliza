/** Verifies hydrateInitialConversation — chat always has a chat (#1) through the package's configured test harness. */
// @vitest-environment jsdom
//
// Real test of the "chat must ALWAYS have a chat in it" guarantee (#1). The fix
// removed the `tabFromPath()==='chat'` gate so a greeted conversation is seeded
// regardless of the boot route; this drives the extracted hydration policy with
// a fake client and asserts that guarantee directly (not via the overlay, which
// only renders whatever messages already exist).
import { MESSAGE_SOURCE_AGENT_GREETING } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../api";
import {
  type HydrateConversationClient,
  type HydrateInitialConversationDeps,
  hydrateInitialConversation,
  settleConversationHydrationForSend,
  shouldSeedSyntheticConversationGreeting,
} from "./useChatCallbacks";

const CONVERSATION = {
  id: "c1",
  title: "Chat",
  roomId: "r1",
  createdAt: "2026-06-24T00:00:00.000Z",
  updatedAt: "2026-06-24T00:00:00.000Z",
};

function makeFakeClient(
  overrides: Partial<Record<keyof HydrateConversationClient, unknown>> = {},
) {
  return {
    listConversations: vi.fn(async () => ({ conversations: [] })),
    getConversationMessages: vi.fn(async () => ({ messages: [] })),
    sendWsMessage: vi.fn(),
    createConversation: vi.fn(async () => ({
      conversation: { ...CONVERSATION },
      greeting: { text: "hi there" },
    })),
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: test fake satisfies the structural client at the boundary
  } as any;
}

function makeDeps(
  client: ReturnType<typeof makeFakeClient>,
  seedSyntheticGreeting = true,
) {
  const setConversations = vi.fn();
  const setActiveConversationId = vi.fn();
  const setConversationMessages = vi.fn();
  const claimConversationMessagesOwnership = vi.fn();
  const conversationMessagesRef: { current: ConversationMessage[] } = {
    current: [],
  };
  const activeConversationIdRef: { current: string | null } = { current: null };
  const greetingFiredRef = { current: false };
  const loadedConversationIdRef: { current: string | null } = {
    current: null,
  };
  const deps: HydrateInitialConversationDeps = {
    client,
    conversationHydrationEpochRef: { current: 0 },
    activeConversationIdRef,
    greetingFiredRef,
    conversationMessagesRef,
    loadedConversationIdRef,
    claimConversationMessagesOwnership,
    setConversations,
    setActiveConversationId,
    setConversationMessages,
    uiLanguage: "en",
    seedSyntheticGreeting,
  };
  return {
    deps,
    setConversations,
    setActiveConversationId,
    setConversationMessages,
    greetingFiredRef,
    activeConversationIdRef,
    loadedConversationIdRef,
    claimConversationMessagesOwnership,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => vi.clearAllMocks());

describe("hydrateInitialConversation — chat always has a chat (#1)", () => {
  it.each(["/chat", "/notes", "/calendar", "/browser"])(
    "restores the same transcript on repeated launches at %s without creating a chat",
    async (route) => {
      const messages = [
        {
          id: "m1",
          role: "user",
          text: "Please keep replies brief",
          timestamp: 1,
        },
        { id: "m2", role: "assistant", text: "Will do.", timestamp: 2 },
      ];
      const client = makeFakeClient({
        listConversations: vi.fn(async () => ({
          conversations: [CONVERSATION],
        })),
        getConversationMessages: vi.fn(async () => ({ messages })),
      });
      for (let launch = 0; launch < 2; launch++) {
        window.history.replaceState(null, "", route);
        const { deps, activeConversationIdRef, setConversationMessages } =
          makeDeps(client);
        await hydrateInitialConversation(deps);
        expect(activeConversationIdRef.current).toBe(CONVERSATION.id);
        expect(setConversationMessages).toHaveBeenLastCalledWith(messages);
        expect(client.getConversationMessages).toHaveBeenLastCalledWith(
          CONVERSATION.id,
        );
      }
      expect(client.createConversation).not.toHaveBeenCalled();
    },
  );

  it("disables synthetic greetings only for native iOS", () => {
    expect(shouldSeedSyntheticConversationGreeting(true, true)).toBe(false);
    expect(shouldSeedSyntheticConversationGreeting(true, false)).toBe(true);
    expect(shouldSeedSyntheticConversationGreeting(false, true)).toBe(true);
    expect(shouldSeedSyntheticConversationGreeting(false, false)).toBe(true);
  });

  it("starts native iOS with an active empty conversation and no greeting backfill", async () => {
    const client = makeFakeClient();
    const {
      deps,
      setActiveConversationId,
      setConversationMessages,
      greetingFiredRef,
      loadedConversationIdRef,
    } = makeDeps(client, false);

    expect(await hydrateInitialConversation(deps)).toBeNull();
    expect(client.createConversation).toHaveBeenCalledWith(undefined, {
      bootstrapGreeting: false,
      lang: "en",
    });
    expect(setActiveConversationId).toHaveBeenCalledWith("c1");
    expect(setConversationMessages.mock.calls.at(-1)?.[0]).toEqual([]);
    expect(greetingFiredRef.current).toBe(false);
    expect(loadedConversationIdRef.current).toBe("c1");
  });

  it("seeds a greeted conversation when the server has none, on ANY route (not just /chat)", async () => {
    // Boot on a NON-chat route — exactly the case the old gate left empty.
    window.history.replaceState(null, "", "/views");
    const client = makeFakeClient();
    const {
      deps,
      setActiveConversationId,
      setConversationMessages,
      greetingFiredRef,
    } = makeDeps(client);

    const result = await hydrateInitialConversation(deps);

    expect(client.createConversation).toHaveBeenCalledWith(undefined, {
      bootstrapGreeting: true,
      lang: "en",
    });
    expect(setActiveConversationId).toHaveBeenCalledWith("c1");
    const seeded = setConversationMessages.mock.calls.at(-1)?.[0];
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({
      role: "assistant",
      text: "hi there",
      source: MESSAGE_SOURCE_AGENT_GREETING,
    });
    expect(greetingFiredRef.current).toBe(true);
    expect(result).toBeNull(); // greeting inlined → no backfill needed
  });

  it("restores an existing conversation with its messages instead of creating one", async () => {
    const client = makeFakeClient({
      listConversations: vi.fn(async () => ({
        conversations: [{ ...CONVERSATION }],
      })),
      getConversationMessages: vi.fn(async () => ({
        messages: [{ id: "m1", role: "user", text: "hello", timestamp: 1 }],
      })),
    });
    const {
      deps,
      setActiveConversationId,
      setConversationMessages,
      loadedConversationIdRef,
      claimConversationMessagesOwnership,
    } = makeDeps(client);

    const result = await hydrateInitialConversation(deps);

    expect(client.createConversation).not.toHaveBeenCalled();
    expect(setActiveConversationId).toHaveBeenCalledWith("c1");
    expect(claimConversationMessagesOwnership).toHaveBeenCalledWith("c1");
    expect(setConversationMessages.mock.calls.at(-1)?.[0]).toHaveLength(1);
    // The thread holder is bound to the restored conversation so the
    // empty-draft cleanup may legitimately judge it by these messages.
    expect(loadedConversationIdRef.current).toBe("c1");
    expect(result).toBeNull(); // already has messages
  });

  it("selects the restored conversation before its Cloud messages finish loading", async () => {
    let resolveMessages!: (value: { messages: ConversationMessage[] }) => void;
    const messagesPending = new Promise<{ messages: ConversationMessage[] }>(
      (resolve) => {
        resolveMessages = resolve;
      },
    );
    const client = makeFakeClient({
      listConversations: vi.fn(async () => ({
        conversations: [{ ...CONVERSATION }],
      })),
      getConversationMessages: vi.fn(() => messagesPending),
    });
    const { deps, setActiveConversationId, setConversationMessages } =
      makeDeps(client);

    const hydration = hydrateInitialConversation(deps);
    await vi.waitFor(() =>
      expect(setActiveConversationId).toHaveBeenCalledWith("c1"),
    );
    expect(setConversationMessages).not.toHaveBeenCalled();
    expect(document.documentElement.dataset.conversationHistoryApplied).toBe(
      "false",
    );

    resolveMessages({
      messages: [{ id: "m1", role: "user", text: "hello", timestamp: 1 }],
    });
    await expect(hydration).resolves.toBeNull();
    expect(setConversationMessages).toHaveBeenCalledWith([
      { id: "m1", role: "user", text: "hello", timestamp: 1 },
    ]);
    expect(document.documentElement.dataset.conversationHistoryApplied).toBe(
      "true",
    );
  });

  it("leaves the thread holder UNKNOWN when the restore fetch fails (placeholder [] must never feed draft cleanup)", async () => {
    const client = makeFakeClient({
      listConversations: vi.fn(async () => ({
        conversations: [{ ...CONVERSATION }],
      })),
      getConversationMessages: vi.fn(async () => {
        throw new Error("network down");
      }),
    });
    const { deps, loadedConversationIdRef } = makeDeps(client);

    const result = await hydrateInitialConversation(deps);

    // Restored, but its messages were NEVER loaded — the [] in the thread is a
    // placeholder. Binding it to "c1" would let the select/new-chat cleanup
    // judge a possibly-real conversation as an empty draft and delete it.
    expect(result).toBeNull();
    expect(loadedConversationIdRef.current).toBeNull();
    expect(document.documentElement.dataset.conversationHistoryApplied).toBe(
      "false",
    );
  });

  it("preserves visible history on a failed same-conversation refresh while marking recovery incomplete", async () => {
    const client = makeFakeClient({
      listConversations: vi.fn(async () => ({ conversations: [CONVERSATION] })),
      getConversationMessages: vi.fn().mockRejectedValue(new Error("offline")),
    });
    const { deps, setConversationMessages, loadedConversationIdRef } =
      makeDeps(client);
    deps.activeConversationIdRef.current = CONVERSATION.id;
    loadedConversationIdRef.current = CONVERSATION.id;
    const visible: ConversationMessage[] = [
      {
        id: "visible",
        role: "user",
        text: "Keep this history",
        timestamp: 1,
      },
    ];
    deps.conversationMessagesRef.current = visible;
    await hydrateInitialConversation(deps);
    expect(deps.conversationMessagesRef.current).toBe(visible);
    expect(setConversationMessages).not.toHaveBeenCalled();
    expect(loadedConversationIdRef.current).toBeNull();
    expect(client.createConversation).not.toHaveBeenCalled();
  });

  it("does not accept an empty draft when a possible real-history candidate is unavailable", async () => {
    const client = makeFakeClient({
      listConversations: vi.fn(async () => ({
        conversations: [
          CONVERSATION,
          { ...CONVERSATION, id: "real", roomId: "real-room" },
        ],
      })),
      getConversationMessages: vi
        .fn()
        .mockResolvedValueOnce({ messages: [] })
        .mockRejectedValueOnce(new Error("offline")),
    });
    const { deps, loadedConversationIdRef } = makeDeps(client);
    await hydrateInitialConversation(deps);
    expect(loadedConversationIdRef.current).toBeNull();
    expect(client.createConversation).not.toHaveBeenCalled();
  });

  it("skips a saved greeting-only draft when a real conversation exists", async () => {
    window.localStorage.setItem("eliza:chat:activeConversationId", "empty");
    const realConversation = {
      ...CONVERSATION,
      id: "real",
      title: "Real chat",
      roomId: "real-room",
      updatedAt: "2026-06-25T00:00:00.000Z",
    };
    const emptyConversation = {
      ...CONVERSATION,
      id: "empty",
      title: "New Chat",
      roomId: "empty-room",
      updatedAt: "2026-06-26T00:00:00.000Z",
    };
    const client = makeFakeClient({
      listConversations: vi.fn(async () => ({
        conversations: [emptyConversation, realConversation],
      })),
      getConversationMessages: vi.fn(async (id: string) => ({
        messages:
          id === "empty"
            ? [
                {
                  id: "greeting",
                  role: "assistant",
                  source: MESSAGE_SOURCE_AGENT_GREETING,
                  text: "hey",
                  timestamp: 1,
                },
              ]
            : [{ id: "m1", role: "user", text: "hello", timestamp: 2 }],
      })),
    });
    const { deps, setActiveConversationId, setConversationMessages } =
      makeDeps(client);

    const result = await hydrateInitialConversation(deps);

    expect(setActiveConversationId).toHaveBeenCalledWith("real");
    expect(setConversationMessages.mock.calls.at(-1)?.[0]).toEqual([
      { id: "m1", role: "user", text: "hello", timestamp: 2 },
    ]);
    expect(result).toBeNull();
  });

  it("restores the MOST-RECENT real conversation even when the server list is not recency-sorted", async () => {
    window.localStorage.setItem("eliza:chat:activeConversationId", "empty");
    const olderReal = {
      ...CONVERSATION,
      id: "older",
      roomId: "older-room",
      updatedAt: "2026-06-20T00:00:00.000Z",
    };
    const newerReal = {
      ...CONVERSATION,
      id: "newer",
      roomId: "newer-room",
      updatedAt: "2026-06-27T00:00:00.000Z",
    };
    const emptyDraft = {
      ...CONVERSATION,
      id: "empty",
      title: "New Chat",
      roomId: "empty-room",
      updatedAt: "2026-06-28T00:00:00.000Z",
    };
    // Deliberately NOT sorted by recency: the older real chat precedes the newer.
    const client = makeFakeClient({
      listConversations: vi.fn(async () => ({
        conversations: [emptyDraft, olderReal, newerReal],
      })),
      getConversationMessages: vi.fn(async (id: string) => ({
        messages:
          id === "empty"
            ? []
            : [{ id: `${id}-m`, role: "user", text: "hi", timestamp: 2 }],
      })),
    });
    const { deps, setActiveConversationId } = makeDeps(client);

    const result = await hydrateInitialConversation(deps);

    expect(setActiveConversationId).toHaveBeenCalledWith("newer");
    expect(result).toBeNull();
  });

  it("returns the new conversation id to backfill when created WITHOUT an inline greeting", async () => {
    const client = makeFakeClient({
      createConversation: vi.fn(async () => ({
        conversation: { ...CONVERSATION, id: "c2" },
        greeting: { text: "" },
      })),
    });
    const { deps, greetingFiredRef } = makeDeps(client);

    expect(await hydrateInitialConversation(deps)).toBe("c2");
    expect(greetingFiredRef.current).toBe(false);
  });

  it("returns the restored id to backfill when the conversation has no renderable messages", async () => {
    const client = makeFakeClient({
      listConversations: vi.fn(async () => ({
        conversations: [{ ...CONVERSATION }],
      })),
      getConversationMessages: vi.fn(async () => ({ messages: [] })),
    });
    const { deps } = makeDeps(client);

    expect(await hydrateInitialConversation(deps)).toBe("c1");
  });

  it("does not backfill an empty restored conversation under the native iOS policy", async () => {
    const client = makeFakeClient({
      listConversations: vi.fn(async () => ({
        conversations: [{ ...CONVERSATION }],
      })),
      getConversationMessages: vi.fn(async () => ({ messages: [] })),
    });
    const { deps } = makeDeps(client, false);

    expect(await hydrateInitialConversation(deps)).toBeNull();
  });

  it("never throws — a failed create resolves to null", async () => {
    const client = makeFakeClient({
      createConversation: vi.fn(async () => {
        throw new Error("agent down");
      }),
    });
    const { deps } = makeDeps(client);

    expect(await hydrateInitialConversation(deps)).toBeNull();
  });

  it.each([undefined, {}, [null]])(
    "does not create a conversation from a malformed history response: %j",
    async (conversations) => {
      const client = makeFakeClient({
        listConversations: vi.fn(async () => ({ conversations })),
      });
      const { deps, activeConversationIdRef } = makeDeps(client);
      await hydrateInitialConversation(deps);
      expect(client.createConversation).not.toHaveBeenCalled();
      expect(activeConversationIdRef.current).toBeNull();
    },
  );

  it("does not create when the conversation list is unavailable", async () => {
    const client = makeFakeClient({
      listConversations: vi.fn().mockRejectedValue(new Error("offline")),
    });
    await hydrateInitialConversation(makeDeps(client).deps);
    expect(client.createConversation).not.toHaveBeenCalled();
  });
});

describe("settleConversationHydrationForSend", () => {
  it("keeps a restore authoritative past the former one-second cutoff", async () => {
    vi.useFakeTimers();
    try {
      let resolveList!: (value: {
        conversations: (typeof CONVERSATION)[];
      }) => void;
      const client = makeFakeClient({
        listConversations: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveList = resolve;
            }),
        ),
        getConversationMessages: vi.fn(async () => ({
          messages: [
            { id: "history", role: "user", text: "Remember me", timestamp: 1 },
          ],
        })),
      });
      const { deps, activeConversationIdRef } = makeDeps(client);
      const task = hydrateInitialConversation(deps);
      const taskRef = { current: task };
      const settled = settleConversationHydrationForSend(
        taskRef,
        deps.conversationHydrationEpochRef,
      );
      await vi.advanceTimersByTimeAsync(1_100);
      expect(taskRef.current).toBe(task);
      expect(deps.conversationHydrationEpochRef.current).toBe(1);
      expect(client.createConversation).not.toHaveBeenCalled();
      resolveList({ conversations: [CONVERSATION] });
      expect(await settled).toBe(true);
      expect(activeConversationIdRef.current).toBe(CONVERSATION.id);
      expect(client.createConversation).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a completed startup restore retain conversation ownership", async () => {
    const taskRef = { current: Promise.resolve<string | null>("c1") };
    const epochRef = { current: 4 };

    expect(
      await settleConversationHydrationForSend(taskRef, epochRef, 100),
    ).toBe(true);

    expect(epochRef.current).toBe(4);
    expect(taskRef.current).toBeNull();
  });

  it("declines a send while retaining a slow restore for the next retry", async () => {
    let resolve!: (value: string) => void;
    const taskRef = {
      current: new Promise<string | null>((done) => {
        resolve = done;
      }),
    };
    const task = taskRef.current;
    const epochRef = { current: 4 };

    expect(await settleConversationHydrationForSend(taskRef, epochRef, 0)).toBe(
      false,
    );

    expect(epochRef.current).toBe(4);
    expect(taskRef.current).toBe(task);
    resolve("restored");
    expect(
      await settleConversationHydrationForSend(taskRef, epochRef, 100),
    ).toBe(true);
    expect(taskRef.current).toBeNull();
  });

  it("does not accept an old restore after conversation authority changes", async () => {
    let resolve!: (value: string) => void;
    const taskRef = {
      current: new Promise<string | null>((done) => {
        resolve = done;
      }),
    };
    const epochRef = { current: 4 };
    const settled = settleConversationHydrationForSend(taskRef, epochRef, 100);
    epochRef.current++;
    resolve("other-owner");
    expect(await settled).toBe(false);
  });
});
