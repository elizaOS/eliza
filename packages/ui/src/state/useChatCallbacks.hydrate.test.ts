/** Verifies the all-platform active-but-empty initial chat contract. */
// @vitest-environment jsdom
//
// Real test of the "chat must ALWAYS have a chat in it" guarantee (#1). The fix
// creates an active conversation regardless of boot route, but never invents a
// canned assistant turn. This drives the extracted hydration policy with a fake
// client and asserts the storage contract directly.
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
  seedSyntheticGreeting = false,
) {
  const setConversations = vi.fn();
  const setActiveConversationId = vi.fn();
  const setConversationMessages = vi.fn();
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
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => vi.clearAllMocks());

describe("hydrateInitialConversation — chat always has a chat (#1)", () => {
  it("disables synthetic greetings on every chat surface", () => {
    expect(shouldSeedSyntheticConversationGreeting(true, true)).toBe(false);
    expect(shouldSeedSyntheticConversationGreeting(true, false)).toBe(false);
    expect(shouldSeedSyntheticConversationGreeting(false, true)).toBe(false);
    expect(shouldSeedSyntheticConversationGreeting(false, false)).toBe(false);
  });

  it.each([
    [true, true, "native iOS"],
    [true, false, "native desktop"],
    [false, true, "mobile web"],
    [false, false, "desktop web"],
  ] as const)(
    "starts %s/%s (%s) with one active empty conversation and no greeting backfill",
    async (native, ios, _surface) => {
      const client = makeFakeClient();
      const {
        deps,
        setActiveConversationId,
        setConversationMessages,
        greetingFiredRef,
        activeConversationIdRef,
        loadedConversationIdRef,
      } = makeDeps(
        client,
        shouldSeedSyntheticConversationGreeting(native, ios),
      );

      expect(await hydrateInitialConversation(deps)).toBeNull();
      expect(client.createConversation).toHaveBeenCalledWith(undefined, {
        bootstrapGreeting: false,
        lang: "en",
      });
      expect(setActiveConversationId).toHaveBeenCalledWith("c1");
      expect(activeConversationIdRef.current).toBe("c1");
      expect(setConversationMessages.mock.calls.at(-1)?.[0]).toEqual([]);
      expect(greetingFiredRef.current).toBe(false);
      expect(loadedConversationIdRef.current).toBe("c1");
    },
  );

  it("retains explicit legacy greeting hydration as an isolated compatibility path", async () => {
    // No product platform opts into this path; keeping it testable avoids
    // changing the lower-level API contract for external consumers.
    window.history.replaceState(null, "", "/views");
    const client = makeFakeClient();
    const {
      deps,
      setActiveConversationId,
      setConversationMessages,
      greetingFiredRef,
    } = makeDeps(client, true);

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
    expect(result).toBeNull();
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
    } = makeDeps(client);

    const result = await hydrateInitialConversation(deps);

    expect(client.createConversation).not.toHaveBeenCalled();
    expect(setActiveConversationId).toHaveBeenCalledWith("c1");
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

    resolveMessages({
      messages: [{ id: "m1", role: "user", text: "hello", timestamp: 1 }],
    });
    await expect(hydration).resolves.toBeNull();
    expect(setConversationMessages).toHaveBeenCalledWith([
      { id: "m1", role: "user", text: "hello", timestamp: 1 },
    ]);
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
    // The global no-greeting policy has no backfill work to schedule even
    // though the failed fetch correctly leaves ownership unknown.
    expect(result).toBeNull();
    expect(loadedConversationIdRef.current).toBeNull();
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

  it("returns the new conversation id for an explicit legacy backfill policy", async () => {
    const client = makeFakeClient({
      createConversation: vi.fn(async () => ({
        conversation: { ...CONVERSATION, id: "c2" },
        greeting: { text: "" },
      })),
    });
    const { deps, greetingFiredRef } = makeDeps(client, true);

    expect(await hydrateInitialConversation(deps)).toBe("c2");
    expect(greetingFiredRef.current).toBe(false);
  });

  it("returns an empty restored id for an explicit legacy backfill policy", async () => {
    const client = makeFakeClient({
      listConversations: vi.fn(async () => ({
        conversations: [{ ...CONVERSATION }],
      })),
      getConversationMessages: vi.fn(async () => ({ messages: [] })),
    });
    const { deps } = makeDeps(client, true);

    expect(await hydrateInitialConversation(deps)).toBe("c1");
  });

  it("does not backfill an empty restored conversation under the global product policy", async () => {
    const client = makeFakeClient({
      listConversations: vi.fn(async () => ({
        conversations: [{ ...CONVERSATION }],
      })),
      getConversationMessages: vi.fn(async () => ({ messages: [] })),
    });
    const { deps } = makeDeps(client);

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
});

describe("settleConversationHydrationForSend", () => {
  it("lets a completed startup restore retain conversation ownership", async () => {
    const taskRef = { current: Promise.resolve<string | null>("c1") };
    const epochRef = { current: 4 };

    await settleConversationHydrationForSend(taskRef, epochRef, 100);

    expect(epochRef.current).toBe(4);
    expect(taskRef.current).toBeNull();
  });

  it("invalidates a hung restore before the send claims conversation ownership", async () => {
    const taskRef = {
      current: new Promise<string | null>(() => {}),
    };
    const epochRef = { current: 4 };

    await settleConversationHydrationForSend(taskRef, epochRef, 0);

    expect(epochRef.current).toBe(5);
    expect(taskRef.current).toBeNull();
  });
});
