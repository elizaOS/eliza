// @vitest-environment jsdom
//
// Real test of the "chat must ALWAYS have a chat in it" guarantee (#1). The fix
// removed the `tabFromPath()==='chat'` gate so a greeted conversation is seeded
// regardless of the boot route; this drives the extracted hydration policy with
// a fake client and asserts that guarantee directly (not via the overlay, which
// only renders whatever messages already exist).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../api";
import {
  type HydrateConversationClient,
  type HydrateInitialConversationDeps,
  hydrateInitialConversation,
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

function makeDeps(client: ReturnType<typeof makeFakeClient>) {
  const setConversations = vi.fn();
  const setActiveConversationId = vi.fn();
  const setConversationMessages = vi.fn();
  const conversationMessagesRef: { current: ConversationMessage[] } = {
    current: [],
  };
  const activeConversationIdRef: { current: string | null } = { current: null };
  const greetingFiredRef = { current: false };
  const deps: HydrateInitialConversationDeps = {
    client,
    conversationHydrationEpochRef: { current: 0 },
    activeConversationIdRef,
    greetingFiredRef,
    conversationMessagesRef,
    setConversations,
    setActiveConversationId,
    setConversationMessages,
    uiLanguage: "en",
  };
  return {
    deps,
    setConversations,
    setActiveConversationId,
    setConversationMessages,
    greetingFiredRef,
    activeConversationIdRef,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
});
afterEach(() => vi.clearAllMocks());

describe("hydrateInitialConversation — chat always has a chat (#1)", () => {
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
      source: "agent_greeting",
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
    const { deps, setActiveConversationId, setConversationMessages } =
      makeDeps(client);

    const result = await hydrateInitialConversation(deps);

    expect(client.createConversation).not.toHaveBeenCalled();
    expect(setActiveConversationId).toHaveBeenCalledWith("c1");
    expect(setConversationMessages.mock.calls.at(-1)?.[0]).toHaveLength(1);
    expect(result).toBeNull(); // already has messages
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
