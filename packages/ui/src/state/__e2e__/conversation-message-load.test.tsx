// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { client } from "../../api/client";
import type { ConversationMessage } from "../../api/client-types-chat";
import { type DataLoadersDeps, useDataLoaders } from "../useDataLoaders";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const ref = <T,>(current: T) => ({ current });
const noEffect = () => {};
function row(id: string): ConversationMessage {
  return {
    id: `message-${id}`,
    role: "user",
    text: `text-${id}`,
    timestamp: 1,
  };
}
function conversation(id: string) {
  return {
    id,
    title: id,
    roomId: id,
    createdAt: "2026-11-08T00:00:00.000Z",
    updatedAt: "2026-11-08T00:00:00.000Z",
  };
}
function loaderHost() {
  const active = ref<string | null>("a");
  const messages = ref<ConversationMessage[]>([row("a")]);
  const requests: Array<{
    id: string;
    options: unknown;
    reply: ReturnType<typeof deferred<{ messages: ConversationMessage[] }>>;
  }> = [];
  const lists: Array<
    ReturnType<
      typeof deferred<Awaited<ReturnType<typeof client.listConversations>>>
    >
  > = [];
  const publications: Array<{ active: string | null; rows: string[] }> = [];
  vi.spyOn(client, "getConversationMessages").mockImplementation(
    (id, options) => {
      const reply = deferred<{ messages: ConversationMessage[] }>();
      requests.push({ id, options, reply });
      return reply.promise;
    },
  );
  vi.spyOn(client, "listConversations").mockImplementation(() => {
    const reply =
      deferred<Awaited<ReturnType<typeof client.listConversations>>>();
    lists.push(reply);
    return reply.promise;
  });
  const deps: DataLoadersDeps = {
    autonomousStoreRef: ref({
      eventsById: {},
      eventOrder: [],
      runIndex: {},
      watermark: null,
    }),
    autonomousEventsRef: ref([]),
    autonomousLatestEventIdRef: ref(null),
    autonomousRunHealthByRunIdRef: ref({}),
    autonomousReplayInFlightRef: ref(false),
    setAutonomousEvents: noEffect,
    setAutonomousLatestEventId: noEffect,
    setAutonomousRunHealthByRunId: noEffect,
    activeConversationIdRef: active,
    conversationMessagesRef: messages,
    greetingFiredRef: ref(false),
    setConversations: noEffect,
    setActiveConversationId: (id) => {
      active.current = id;
    },
    setConversationMessages: (values) => {
      messages.current = values;
      publications.push({
        active: active.current,
        rows: values.map((value) => value.id),
      });
    },
    loadWalletConfig: async () => {},
    agentStatus: null,
    characterData: null,
    characterDraft: null,
    loadCharacter: async () => {},
    selectedVrmIndex: 0,
    firstRunComplete: false,
    uiLanguage: "en",
    setOwnerNameState: noEffect,
  };
  const hook = renderHook(() => useDataLoaders(deps));
  const loaders = hook.result.current;
  function claim(id: string | null) {
    loaders.claimConversationMessagesOwnership(id);
    active.current = id;
  }
  claim("a");
  return {
    active,
    messages,
    requests,
    lists,
    publications,
    loaders,
    claim,
    unmount: hook.unmount,
  };
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("conversation message load ownership", () => {
  it("clears old transcript rows before a new owner's request", async () => {
    const host = loaderHost();
    host.claim("b");
    const load = host.loaders.loadConversationMessages("b");
    expect(host.messages.current).toEqual([]);
    host.requests[0].reply.resolve({ messages: [row("b")] });
    expect(await load).toEqual({ ok: true });
    expect(host.messages.current).toEqual([row("b")]);
  });

  it("ignores a transport success after another owner claims the view", async () => {
    const host = loaderHost();
    const load = host.loaders.loadConversationMessages("a");
    host.claim("b");
    host.requests[0].reply.resolve({ messages: [row("stale-a")] });
    expect(await load).toEqual({ ok: true });
    expect(host.messages.current).not.toEqual([row("stale-a")]);
    expect(host.active.current).toBe("b");
  });

  it("keeps a newer same-owner response when an older request finishes", async () => {
    const host = loaderHost();
    const older = host.loaders.loadConversationMessages("a");
    const newer = host.loaders.loadConversationMessages("a");
    host.requests[1].reply.resolve({ messages: [row("new")] });
    await newer;
    host.requests[0].reply.resolve({ messages: [row("old")] });
    await older;
    expect(host.messages.current).toEqual([row("new")]);
  });

  it("fences a missing-thread list response after a new owner claim", async () => {
    const host = loaderHost();
    const load = host.loaders.loadConversationMessages("a");
    host.requests[0].reply.reject(
      Object.assign(new Error("gone"), { status: 404 }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(host.lists).toHaveLength(1);
    host.claim("c");
    host.lists[0].resolve({ conversations: [conversation("b")] } as Awaited<
      ReturnType<typeof client.listConversations>
    >);
    expect(await load).toEqual({ ok: true });
    expect(host.active.current).toBe("c");
  });

  it("returns the loader's fallback ownership after a missing-thread reply", async () => {
    const host = loaderHost();
    const load = host.loaders.loadConversationMessages("a");
    host.requests[0].reply.reject(
      Object.assign(new Error("gone"), { status: 404 }),
    );
    await Promise.resolve();
    await Promise.resolve();
    host.lists[0].resolve({ conversations: [conversation("b")] } as Awaited<
      ReturnType<typeof client.listConversations>
    >);
    expect((await load).ok).toBe(false);
    expect(host.active.current).toBe("b");
    expect(host.messages.current).toEqual([]);
  });

  it("preserves a cached transcript after transient revalidation failure", async () => {
    const host = loaderHost();
    const initial = host.loaders.loadConversationMessages("a");
    host.requests[0].reply.resolve({ messages: [row("a")] });
    await initial;
    const reload = host.loaders.loadConversationMessages("a");
    host.requests[1].reply.reject(
      Object.assign(new Error("temporary"), { status: 503 }),
    );
    expect(await reload).toEqual({ ok: true });
    expect(host.messages.current).toEqual([row("a")]);
  });

  it("fences a centered window superseded by a newest-history request", async () => {
    const host = loaderHost();
    const around = host.loaders.loadConversationMessagesAround("a", "target");
    const newest = host.loaders.loadConversationMessages("a");
    host.requests[1].reply.resolve({ messages: [row("newest")] });
    await newest;
    host.requests[0].reply.resolve({ messages: [row("around")] });
    expect(await around).toBe(false);
    expect(host.messages.current).toEqual([row("newest")]);
  });

  it("does not publish an around window after its callback changes ownership", async () => {
    const host = loaderHost();
    const around = host.loaders.loadConversationMessagesAround("a", "target", {
      onMessages: () => host.claim("b"),
    });
    host.requests[0].reply.resolve({ messages: [row("stale-around")] });
    expect(await around).toBe(false);
    expect(host.active.current).toBe("b");
    expect(host.messages.current).not.toEqual([row("stale-around")]);
  });
});
