// @vitest-environment jsdom
//
// #10700 — send/voice/new-chat lifecycle race, driven against the REAL send
// queue.
//
// The reported bug is a cross-conversation misroute: the shell `send()` path
// (`useShellController.send` — both a text turn and a VOICE_DM converse turn)
// calls `sendChatText(text)` / `sendChatText(text, { channelType: "VOICE_DM" })`
// with **no** `conversationId`. Before the fix, `runQueuedChatSend` bound the
// target late — `convId = turn.conversationId ?? activeConversationIdRef.current`
// resolved at DRAIN time — so a `clearConversation()` (new chat) issued while an
// earlier turn was still draining flipped `activeConversationIdRef.current` and
// the queued turn was delivered to the WRONG (new) conversation.
//
// This suite renders the real `useChatSend` hook (the actual serialized send
// queue + single-flight drain loop the shell send()/voice paths delegate to),
// mocks the network only at the `client` boundary, and drives it statefully.
// It reproduces the race deterministically and fuzzes randomized interleavings
// of send-text / send-voice / new-chat / stream-completion, asserting the
// message-lifecycle invariants from the issue after the walk:
//   (a) no lost / no duplicate turns,
//   (b) every turn delivered to the conversation active at its ENQUEUE,
//   (c) in-conversation ordering preserved,
//   (d) no stuck `chatSending`.
//
// The companion full-app e2e (real gestures through the shell) is a sibling
// item; this component-level suite owns the queue-layer data lifecycle where
// the race actually lives.

import { act, cleanup, renderHook } from "@testing-library/react";
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
    sendConversationMessage: vi.fn(),
    sendConversationMessageStream: vi.fn(),
    sendWsMessage: vi.fn(),
    stopCodingAgent: vi.fn(),
    renameConversation: vi.fn(() => Promise.resolve()),
    truncateConversationMessages: vi.fn(() => Promise.resolve()),
    getBaseUrl: vi.fn(() => ""),
  },
}));

vi.mock("../api", () => ({ client: mocks.client }));

// Same Capacitor stub the sibling useChatSend.test.tsx uses: keep the real
// client-cloud classifier (do not mock it) so we exercise production routing.
vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

/** Deterministic PRNG so a failing seed reproduces exactly. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Delivery {
  convId: string;
  text: string;
  channelType: string;
}

/**
 * A stateful harness around the real hook. `conversationsRef` /
 * `activeConversationIdRef` behave like the live app state; the `client` stream
 * is deferred so we can open the exact enqueue→drain race window on demand.
 */
function makeHarness(initialActive: string) {
  const conversations: Conversation[] = ["A", "B", "C", "D"].map((id) => ({
    id,
    roomId: `room-${id}`,
    title: "New Chat",
    createdAt: "2026-05-15T00:00:00.000Z",
    updatedAt: "2026-05-15T00:00:00.000Z",
  }));
  const conversationsRef = {
    current: conversations,
  } as MutableRefObject<Conversation[]>;
  const conversationMessagesRef = {
    current: [],
  } as MutableRefObject<ConversationMessage[]>;
  const activeConversationIdRef = {
    current: initialActive,
  } as MutableRefObject<string | null>;

  let chatSending = false;

  const deliveries: Delivery[] = [];
  const pending: Array<() => void> = [];

  // Record the delivery target (convId) the moment the queue dispatches, then
  // park the stream until the test releases it — this is what lets a new-chat
  // slip between an earlier turn's dispatch and a later turn's drain.
  mocks.client.sendConversationMessageStream.mockImplementation(
    (
      convId: string,
      text: string,
      _onToken: (t: string, acc?: string) => void,
      channelType: string,
    ) =>
      new Promise<{ text: string; completed: boolean }>((resolve) => {
        deliveries.push({ convId, text, channelType });
        pending.push(() => resolve({ text: `reply:${text}`, completed: true }));
      }),
  );

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

  const deps: UseChatSendDeps = {
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId: initialActive,
    ptySessionsRef: { current: [] } as MutableRefObject<CodingAgentSession[]>,
    setChatInput: vi.fn(),
    setChatSending: (v) => {
      chatSending = v;
    },
    setChatFirstTokenReceived: vi.fn(),
    setServerTurnStatus: vi.fn(),
    setChatLastUsage: vi.fn(),
    setChatPendingImages: vi.fn(),
    setConversations,
    // Mirror the live clearConversation/select semantics: the state setter and
    // the ref move together.
    setActiveConversationId: (v) => {
      activeConversationIdRef.current = v;
    },
    setCompanionMessageCutoffTs: vi.fn(),
    setConversationMessages,
    setUnreadConversations: vi.fn(),
    setActionNotice: vi.fn(),
    activeConversationIdRef,
    chatInputRef: { current: "" } as MutableRefObject<string>,
    chatPendingImagesRef: {
      current: [],
    } as MutableRefObject<ImageAttachment[]>,
    conversationsRef,
    conversationMessagesRef,
    chatAbortRef: { current: null } as MutableRefObject<AbortController | null>,
    chatSendBusyRef: { current: false } as MutableRefObject<boolean>,
    chatSendNonceRef: { current: 0 },
    loadConversations: vi.fn(async () => conversationsRef.current),
    loadConversationMessages: vi.fn(
      async (): Promise<LoadConversationMessagesResult> => ({ ok: true }),
    ),
    elizaCloudEnabled: false,
    elizaCloudConnected: false,
    pollCloudCredits: vi.fn(async () => true),
  };

  return {
    deps,
    deliveries,
    get chatSending() {
      return chatSending;
    },
    activeId: () => activeConversationIdRef.current as string,
    /** Move the active conversation (models clearConversation / new-chat). */
    newChat: (id: string) => {
      activeConversationIdRef.current = id;
    },
    pendingCount: () => pending.length,
    /** Release the oldest parked stream, unblocking the drain loop by one turn. */
    releaseOne: () => {
      const next = pending.shift();
      if (next) next();
      return Boolean(next);
    },
    pending,
  };
}

/** Let queued microtasks (the drain loop's awaits) settle. */
async function flushMicrotasks(times = 4) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useChatSend send/new-chat race (#10700)", () => {
  it("deterministic repro: a shell send() queued behind an in-flight turn is delivered to the conversation active at ENQUEUE, not at drain", async () => {
    const h = makeHarness("A");
    const { result } = renderHook(() => useChatSend(h.deps));

    // t0 occupies the drain (its stream is parked).
    let p0: Promise<void> | undefined;
    let pA: Promise<void> | undefined;
    await act(async () => {
      p0 = result.current.sendChatText("t0"); // shell path, no conversationId
      await flushMicrotasks();
    });
    expect(h.pendingCount()).toBe(1); // t0 dispatched to A, awaiting stream

    // tA enqueues behind t0 while A is still active — captured target is A.
    await act(async () => {
      pA = result.current.sendChatText("tA"); // shell path, no conversationId
      await flushMicrotasks();
    });

    // New chat flips the active conversation to B BEFORE tA drains.
    h.newChat("B");

    // Release t0 → the loop shifts tA and resolves its target. This is the race
    // point: pre-fix, tA bound to activeConversationIdRef.current === "B".
    await act(async () => {
      h.releaseOne();
      await flushMicrotasks();
      // Release tA's own stream so the turn settles.
      h.releaseOne();
      await flushMicrotasks();
      await Promise.all([p0, pA]);
    });

    const tA = h.deliveries.find((d) => d.text === "tA");
    expect(tA).toBeDefined();
    expect(tA?.convId).toBe("A"); // NOT "B" — the fix pins this
    expect(h.chatSending).toBe(false); // not latched on
  });

  it("voice (VOICE_DM) converse turns are pinned the same way", async () => {
    const h = makeHarness("A");
    const { result } = renderHook(() => useChatSend(h.deps));

    let p0: Promise<void> | undefined;
    let pVoice: Promise<void> | undefined;
    await act(async () => {
      p0 = result.current.sendChatText("t0");
      await flushMicrotasks();
    });
    await act(async () => {
      // Exactly how useShellController routes a committed voice turn.
      pVoice = result.current.sendChatText("voiceTurn", {
        channelType: "VOICE_DM",
        metadata: { voiceSource: "talkmode" },
      });
      await flushMicrotasks();
    });
    h.newChat("C");
    await act(async () => {
      h.releaseOne();
      await flushMicrotasks();
      h.releaseOne();
      await flushMicrotasks();
      await Promise.all([p0, pVoice]);
    });

    const voice = h.deliveries.find((d) => d.text === "voiceTurn");
    expect(voice?.convId).toBe("A");
    expect(voice?.channelType).toBe("VOICE_DM");
  });

  async function runSeed(seed: number): Promise<void> {
      const rand = mulberry32(seed);
      const pool = ["A", "B", "C", "D"];
      const h = makeHarness("A");
      const { result } = renderHook(() => useChatSend(h.deps));
      const api = result.current;
      expect(api, `seed ${seed}: hook did not mount`).toBeTruthy();

      // Recorded intent: text → { target captured at enqueue, order rank }.
      const expected = new Map<string, { target: string; order: number }>();
      const perTargetOrder: Record<string, string[]> = {};
      const inflight: Array<Promise<void>> = [];
      let counter = 0;

      const STEPS = 18;
      for (let step = 0; step < STEPS; step++) {
        const roll = rand();
        // eslint-disable-next-line no-await-in-loop
        await act(async () => {
          if (roll < 0.4) {
            // send-text or send-voice from the shell path (no conversationId).
            // act() flushes the enqueue + synchronous drain-start on its own.
            const text = `m${seed}-${counter++}`;
            const target = h.activeId();
            expected.set(text, {
              target,
              order: (perTargetOrder[target] ??= []).push(text) - 1,
            });
            const voice = roll < 0.15;
            inflight.push(
              voice
                ? api.sendChatText(text, { channelType: "VOICE_DM" })
                : api.sendChatText(text),
            );
          } else if (roll < 0.7) {
            // new-chat: move the active conversation
            h.newChat(pool[Math.floor(rand() * pool.length)]);
          } else {
            // complete an in-flight stream (advances the drain under a possibly
            // just-changed active conversation — the race window)
            h.releaseOne();
          }
        });
      }

      // Drain everything that remains. Release one parked stream, then let its
      // continuation run (which shifts the next queued turn and dispatches — and
      // parks — its stream) before releasing again. A tight synchronous release
      // loop would not work: resolve() continuations are deferred microtasks, so
      // the next turn's stream is not yet parked when the loop re-checks.
      await act(async () => {
        for (let guard = 0; guard < 400; guard++) {
          if (h.pendingCount() === 0) {
            await flushMicrotasks();
            if (h.pendingCount() === 0) break;
          }
          h.releaseOne();
          await flushMicrotasks();
        }
        await Promise.allSettled(inflight);
      });

      // (a) no lost / no duplicate: every enqueued text delivered exactly once.
      const byText = new Map<string, Delivery[]>();
      for (const d of h.deliveries) {
        (byText.get(d.text) ?? byText.set(d.text, []).get(d.text)!).push(d);
      }
      for (const [text, meta] of expected) {
        const got = byText.get(text) ?? [];
        expect(got.length, `seed ${seed}: "${text}" delivered ${got.length}× (expected 1)`).toBe(1);
        // (b) correct target: delivered to the conversation active at enqueue.
        expect(got[0]?.convId, `seed ${seed}: "${text}" misrouted`).toBe(meta.target);
      }
      // No phantom deliveries beyond what we enqueued.
      expect(h.deliveries.length, `seed ${seed}: phantom deliveries`).toBe(expected.size);

      // (c) ordering: within each target, delivery order matches enqueue order.
      for (const [target, texts] of Object.entries(perTargetOrder)) {
        const deliveredOrder = h.deliveries
          .filter((d) => d.convId === target)
          .map((d) => d.text);
        expect(deliveredOrder, `seed ${seed}: ordering broken for ${target}`).toEqual(texts);
      }

      // (d) no stuck send state after the walk.
      expect(h.chatSending, `seed ${seed}: chatSending latched on`).toBe(false);
  }

  it(
    "fuzz: randomized send-text / send-voice / new-chat / stream-complete preserves no-lost, correct-target, ordering, no-stuck across seeds",
    async () => {
      for (const seed of [1, 2, 3, 4, 5]) {
        // eslint-disable-next-line no-await-in-loop
        await runSeed(seed);
        cleanup(); // tear down this seed's hook before the next renderHook
        vi.clearAllMocks();
      }
    },
    60_000,
  );
});
