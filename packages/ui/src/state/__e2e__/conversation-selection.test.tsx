// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api/client";
import type { ConversationMessage } from "../../api/client-types-chat";
import { chatDraftStorageKey } from "../ChatComposerContext.hooks";
import type { LoadConversationMessagesResult } from "../types";
import {
  type UseChatCallbacksDeps,
  useChatCallbacks,
} from "../useChatCallbacks";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const ref = <T,>(current: T) => ({ current });
const noEffect = () => {};
beforeEach(() => {
  window.localStorage.clear();
  vi.spyOn(client, "sendWsMessage").mockImplementation(() => {});
  vi.spyOn(client, "deleteConversation").mockResolvedValue({ ok: true });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** Actual mounted hook and send interruption, with controlled host loaders.
 * This checks the callback lifetime, not the full message loader or rendering. */
function selectionHost(emptyPrevious = false) {
  const active = ref<string | null>("a");
  const input = ref("edited-a");
  const epoch = ref(0);
  const messages = ref<ConversationMessage[]>([
    {
      id: "message-a",
      text: "hello",
      role: emptyPrevious ? "assistant" : "user",
      timestamp: 0,
    },
  ]);
  const requests: Array<{
    id: string;
    reply: ReturnType<typeof deferred<LoadConversationMessagesResult>>;
  }> = [];
  const list =
    deferred<Awaited<ReturnType<UseChatCallbacksDeps["loadConversations"]>>>();
  const claims: Array<string | null> = [];
  const notices: string[] = [];
  for (const id of ["a", "b", "c"])
    window.localStorage.setItem(chatDraftStorageKey(id), `saved-${id}`);
  const deps = {
    t: (key: string) => key,
    uiLanguage: "en",
    tab: "chat",
    agentStatus: null,
    activeConversationId: "a",
    chatInput: input.current,
    firstRunComplete: false,
    companionMessageCutoffTs: 0,
    ptySessions: [],
    activeConversationIdRef: active,
    chatInputRef: input,
    chatPendingImagesRef: ref([]),
    chatReplyTargetRef: ref(null),
    conversationsRef: ref([]),
    conversationMessagesRef: messages,
    conversationHydrationEpochRef: epoch,
    chatAbortRef: ref(null),
    chatSendBusyRef: ref(false),
    chatSendNonceRef: ref(0),
    greetingFiredRef: ref(false),
    greetingInFlightConversationRef: ref(null),
    lifecycleBusyRef: ref(false),
    lifecycleActionRef: ref(null),
    loadedConversationIdRef: ref<string | null>("a"),
    coordinatorResetRef: ref(null),
    elizaCloudPreferDisconnectedUntilLoginRef: ref(false),
    firstRunCompletionCommittedRef: ref(false),
    setChatInput: (text: string) => {
      input.current = text;
    },
    setChatPendingImages: noEffect,
    setActiveConversationId: (id: string | null) => {
      active.current = id;
    },
    setConversationMessages: noEffect,
    setConversations: noEffect,
    setUnreadConversations: noEffect,
    setServerTurnStatus: noEffect,
    setChatSending: noEffect,
    setChatFirstTokenReceived: noEffect,
    setActionNotice: (text: string) => {
      notices.push(text);
    },
    claimConversationMessagesOwnership: (id: string | null) => {
      claims.push(id);
      return claims.length;
    },
    discardConversationMessageState: noEffect,
    loadConversationMessages: (id: string) => {
      const reply = deferred<LoadConversationMessagesResult>();
      requests.push({ id, reply });
      return reply.promise;
    },
    loadConversations: () => list.promise,
  } satisfies Partial<UseChatCallbacksDeps>;
  const hook = renderHook(() =>
    useChatCallbacks(deps as unknown as UseChatCallbacksDeps),
  );
  return {
    callbacks: hook.result.current,
    unmount: hook.unmount,
    active,
    input,
    epoch,
    requests,
    list,
    claims,
    notices,
  };
}

describe("conversation selection callback", () => {
  it("persists the leaving draft and selects the target before its load settles", async () => {
    const host = selectionHost();
    const selection = host.callbacks.handleSelectConversation("b");
    expect(host.active.current).toBe("b");
    expect(host.input.current).toBe("saved-b");
    expect(window.localStorage.getItem(chatDraftStorageKey("a"))).toBe(
      "edited-a",
    );
    expect(host.claims).toEqual(["b"]);
    expect(host.requests.map(({ id }) => id)).toEqual(["b"]);
    expect(client.sendWsMessage).toHaveBeenCalledWith({
      type: "active-conversation",
      conversationId: "b",
    });
    host.requests[0].reply.resolve({ ok: true });
    await selection;
  });
  it("retains late rollback after its calling surface retires", async () => {
    const host = selectionHost();
    const selection = host.callbacks.handleSelectConversation("b");
    host.unmount();
    host.requests[0].reply.resolve({
      ok: false,
      status: 500,
      message: "network",
    });
    await Promise.resolve();
    expect(host.active.current).toBe("a");
    expect(host.input.current).toBe("edited-a");
    expect(host.claims).toEqual(["b", "a"]);
    host.requests[1].reply.resolve({ ok: true });
    await selection;
    expect(host.notices).toEqual(["Failed to load conversation: network"]);
  });
  it("keeps the newer selection when an older load fails", async () => {
    const host = selectionHost();
    const first = host.callbacks.handleSelectConversation("b");
    const second = host.callbacks.handleSelectConversation("c");
    host.requests[0].reply.resolve({
      ok: false,
      status: 500,
      message: "old failure",
    });
    await first;
    expect(host.active.current).toBe("c");
    expect(host.input.current).toBe("saved-c");
    expect(host.claims).toEqual(["b", "c"]);
    expect(host.notices).toEqual([]);
    host.requests[1].reply.resolve({ ok: true });
    await second;
  });
  it("fences an old missing-target list after another selection", async () => {
    const host = selectionHost();
    const rejected = vi.fn();
    const first = host.callbacks.handleSelectConversation("b", {
      onRejected: rejected,
    });
    host.requests[0].reply.resolve({
      ok: false,
      status: 404,
      message: "missing",
    });
    await Promise.resolve();
    expect(rejected).toHaveBeenCalledOnce();
    const second = host.callbacks.handleSelectConversation("c");
    host.list.resolve(null);
    await first;
    expect(host.active.current).toBe("c");
    expect(host.notices).toEqual([]);
    host.requests[1].reply.resolve({ ok: true });
    await second;
  });
  it("clears the selection when the missing-target list has no fallback", async () => {
    const host = selectionHost();
    const first = host.callbacks.handleSelectConversation("b");
    host.requests[0].reply.resolve({
      ok: false,
      status: 404,
      message: "missing",
    });
    host.list.resolve(null);
    await first;
    expect(host.active.current).toBeNull();
    expect(host.input.current).toBe("");
    expect(host.claims).toEqual(["b", null]);
    expect(host.notices).toEqual([
      "Conversation was not found. Refreshed the conversation list.",
    ]);
  });
  it("removes an owned empty draft before leaving it", async () => {
    const host = selectionHost(true);
    const first = host.callbacks.handleSelectConversation("b");
    expect(client.deleteConversation).toHaveBeenCalledWith("a");
    expect(window.localStorage.getItem(chatDraftStorageKey("a"))).toBeNull();
    expect(host.input.current).toBe("saved-b");
    host.requests[0].reply.resolve({ ok: true });
    await first;
  });
  it("uses the actual stored draft when saving the edit fails", async () => {
    const host = selectionHost();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage refused");
    });
    const first = host.callbacks.handleSelectConversation("b");
    host.requests[0].reply.resolve({
      ok: false,
      status: 500,
      message: "network",
    });
    await Promise.resolve();
    expect(host.active.current).toBe("a");
    expect(host.input.current).toBe("saved-a");
    host.requests[1].reply.resolve({ ok: true });
    await first;
  });
  it("advances the epoch without reloading an already visible conversation", async () => {
    const host = selectionHost();
    await host.callbacks.handleSelectConversation("a");
    expect(host.epoch.current).toBe(1);
    expect(host.requests).toEqual([]);
    expect(host.claims).toEqual([]);
    expect(host.input.current).toBe("edited-a");
  });
});
