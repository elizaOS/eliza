// @vitest-environment jsdom
//
// #10700 — interleaved send-text / send-voice / new-chat lifecycle.
//
// The send queue is a stateful machine, not a set of pure calls. A turn enqueued
// through the SHELL send() path (voice converse turns + tapped suggestions)
// carries NO explicit conversationId, so `runQueuedChatSend` resolves its target
// LATE — `turn.conversationId ?? activeConversationIdRef.current ?? ""`
// (useChatSend.ts ~824) — at DRAIN time. A `new-chat` (clearConversation) issued
// while such a turn is still queued flips `activeConversationIdRef.current`, so
// the queued turn drains into the WRONG (new) conversation. The composer path
// (handleChatSend) snapshots conversationId at enqueue and is immune; the shell
// send() path is the asymmetric, unprotected surface this suite pins.
//
// The definitive routing truth is the first argument of
// `client.sendConversationMessageStream(convId, text, …)` — that is where the
// turn is actually delivered. We assert on it. The single-flight drain lets us
// park a turn in flight and enqueue another BEHIND it, opening a deterministic
// window to fire a new-chat while a turn is queued (no microtask racing).

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
    abortConversationTurn: vi.fn(() => Promise.resolve({ aborted: true })),
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

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
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

// ── A controllable in-memory conversation store shared by the deps + mocks ────

interface StreamCall {
  convId: string;
  text: string;
  channelType: string;
}

interface RaceHarness {
  deps: UseChatSendDeps;
  /** Every stream the hook opened, in order — the routing ground truth. */
  streamCalls: StreamCall[];
  /** Resolve the single in-flight stream, advancing the single-flight drain. */
  resolveInFlight: (reply?: string) => void;
  /** Number of streams still awaiting resolution (0 or 1 under single-flight). */
  inFlightCount: () => number;
  /** Simulate clearConversation's net effect on the send hook: switch active. */
  newChat: (id: string, roomId: string) => void;
  /** The conversation active right now (what a shell send() would bind to). */
  activeId: () => string | null;
}

function makeHarness(seed: {
  activeConversationId: string | null;
  conversations: Conversation[];
}): RaceHarness {
  const conversationsRef = {
    current: [...seed.conversations],
  } as MutableRefObject<Conversation[]>;
  const conversationMessagesRef = {
    current: [],
  } as MutableRefObject<ConversationMessage[]>;
  const activeConversationIdRef = {
    current: seed.activeConversationId,
  } as MutableRefObject<string | null>;

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
  const setActiveConversationId: UseChatSendDeps["setActiveConversationId"] = (
    value,
  ) => {
    activeConversationIdRef.current = value;
  };

  const streamCalls: StreamCall[] = [];
  const pending: Array<(reply: { text: string; completed: boolean }) => void> =
    [];

  mocks.client.sendConversationMessageStream.mockImplementation(
    (
      id: string,
      text: string,
      _onToken: unknown,
      channelType: string,
    ): Promise<{ text: string; completed: boolean }> => {
      streamCalls.push({ convId: id, text, channelType });
      return new Promise((resolve) => {
        pending.push(resolve);
      });
    },
  );

  // Cold-open conversation creation hands out deterministic ids.
  let created = 0;
  mocks.client.createConversation.mockImplementation(() => {
    created += 1;
    const conv = conversation(`created-${created}`, `room-created-${created}`);
    return Promise.resolve({ conversation: conv });
  });

  const deps: UseChatSendDeps = {
    t: (key) => key,
    uiLanguage: "en",
    tab: "chat",
    activeConversationId: seed.activeConversationId,
    ptySessionsRef: { current: [] } as MutableRefObject<CodingAgentSession[]>,
    setChatInput: vi.fn(),
    setChatSending: vi.fn(),
    setChatFirstTokenReceived: vi.fn(),
    setServerTurnStatus: vi.fn(),
    setChatLastUsage: vi.fn(),
    setChatPendingImages: vi.fn(),
    setConversations,
    setActiveConversationId,
    setCompanionMessageCutoffTs: vi.fn(),
    setConversationMessages,
    setUnreadConversations: vi.fn(),
    setChatReplyTarget: vi.fn(),
    setActionNotice: vi.fn(),
    activeConversationIdRef,
    chatInputRef: { current: "" } as MutableRefObject<string>,
    chatPendingImagesRef: { current: [] } as MutableRefObject<
      ImageAttachment[]
    >,
    chatReplyTargetRef: { current: null },
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
    streamCalls,
    resolveInFlight: (reply = "reply") => {
      const next = pending.shift();
      next?.({ text: reply, completed: true });
    },
    inFlightCount: () => pending.length,
    newChat: (id, roomId) => {
      conversationsRef.current = [
        conversation(id, roomId),
        ...conversationsRef.current,
      ];
      activeConversationIdRef.current = id;
    },
    activeId: () => activeConversationIdRef.current,
  };
}

/** Let queued microtasks + the drain loop settle. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

type Send = (
  text: string,
  options?: {
    channelType?: "DM" | "VOICE_DM";
    conversationId?: string | null;
  },
) => Promise<void>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.client.getBaseUrl.mockReturnValue("");
});

describe("#10700 shell send() → new-chat routing race", () => {
  it("routes a queued VOICE_DM turn to the conversation it was sent in, NOT a mid-flight new chat", async () => {
    const h = makeHarness({
      activeConversationId: "conv-A",
      conversations: [conversation("conv-A", "room-A")],
    });
    const { result } = renderHook(() => useChatSend(h.deps));
    const send = result.current.sendChatText as unknown as Send;

    // Turn 1 (composer path, explicit conv) holds the single-flight drain: its
    // stream is opened but left in flight, parking the queue.
    const p1 = send("first", { conversationId: "conv-A" });
    await settle();
    expect(h.inFlightCount()).toBe(1);

    // Turn 2 is a SHELL voice turn: no conversationId. It sits behind turn 1.
    const p2 = send("voice turn", { channelType: "VOICE_DM" });
    await settle();

    // While the voice turn is queued, the user starts a NEW chat.
    h.newChat("conv-B", "room-B");
    await settle();
    expect(h.activeId()).toBe("conv-B");

    // Drain turn 1, then turn 2.
    await act(async () => {
      h.resolveInFlight();
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();
    await act(async () => {
      h.resolveInFlight();
    });
    await act(async () => {
      await Promise.all([p1, p2]);
    });

    const voiceStream = h.streamCalls.find((c) => c.text === "voice turn");
    expect(voiceStream).toBeDefined();
    // The turn belongs to conv-A (where it was spoken), never conv-B.
    expect(voiceStream?.convId).toBe("conv-A");
    expect(voiceStream?.channelType).toBe("VOICE_DM");
  });

  it("does NOT create a second conversation on a cold-open double shell-send", async () => {
    // Regression guard for the fix: pinning conversationId at enqueue must NOT
    // make a rapid second cold-open turn spawn its own conversation. When no
    // conversation exists, both turns must land in the single one that gets
    // created — the enqueue pin stays null (cold open) and the drain-time
    // fallback joins the just-created conversation.
    const h = makeHarness({
      activeConversationId: null,
      conversations: [],
    });
    const { result } = renderHook(() => useChatSend(h.deps));
    const send = result.current.sendChatText as unknown as Send;

    const p1 = send("cold one", { channelType: "VOICE_DM" });
    const p2 = send("cold two", { channelType: "VOICE_DM" });
    await settle();

    // Drain both turns.
    await act(async () => {
      h.resolveInFlight();
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();
    await act(async () => {
      h.resolveInFlight();
    });
    await act(async () => {
      await Promise.all([p1, p2]);
    });

    expect(mocks.client.createConversation).toHaveBeenCalledTimes(1);
    const convIds = new Set(h.streamCalls.map((c) => c.convId));
    expect(convIds.size).toBe(1);
    expect(h.streamCalls.map((c) => c.text)).toEqual(["cold one", "cold two"]);
  });

  it("keeps composer (explicit-conv) sends immune to a mid-flight new-chat", async () => {
    // Control: the handleChatSend path already snapshots conversationId, so it
    // must remain correctly routed under the same interleaving (no regression).
    const h = makeHarness({
      activeConversationId: "conv-A",
      conversations: [conversation("conv-A", "room-A")],
    });
    const { result } = renderHook(() => useChatSend(h.deps));
    const send = result.current.sendChatText as unknown as Send;

    const p1 = send("hold", { conversationId: "conv-A" });
    await settle();
    const p2 = send("typed", { conversationId: "conv-A" });
    await settle();
    h.newChat("conv-B", "room-B");
    await settle();

    await act(async () => {
      h.resolveInFlight();
      await Promise.resolve();
      await Promise.resolve();
    });
    await settle();
    await act(async () => {
      h.resolveInFlight();
    });
    await act(async () => {
      await Promise.all([p1, p2]);
    });

    expect(h.streamCalls.find((c) => c.text === "typed")?.convId).toBe(
      "conv-A",
    );
  });

  it("restores a queued-undelivered send to the composer when new-chat interrupts (no lost message)", async () => {
    // The REAL new-chat path (handleNewConversation) calls
    // interruptActiveChatPipeline() BEFORE switching conversations, which
    // drains the send queue. A turn enqueued behind an in-flight one (the
    // composer explicitly offers "send another") was resolved WITHOUT
    // delivery: composer already cleared at enqueue, optimistic bubble only
    // painted at drain → the words vanished with no trace. The interrupt must
    // restore the undelivered text to the composer (and return it, so the
    // new-chat draft wipe can re-apply it).
    const h = makeHarness({
      activeConversationId: "conv-A",
      conversations: [conversation("conv-A", "room-A")],
    });
    const { result } = renderHook(() => useChatSend(h.deps));
    const send = result.current.sendChatText as unknown as Send;

    const p1 = send("hold", { conversationId: "conv-A" });
    await settle();
    // Queued BEHIND the in-flight turn — never drained before the interrupt.
    const p2 = send("my queued words", { conversationId: "conv-A" });
    await settle();

    let restored = "";
    await act(async () => {
      restored = result.current.interruptActiveChatPipeline();
    });
    // The mock stream only settles via resolveInFlight — the abort does not
    // reject it. Release it so p1 can settle; p2 settled at interrupt time.
    await act(async () => {
      h.resolveInFlight();
    });
    await act(async () => {
      await Promise.allSettled([p1, p2]);
    });

    // Not delivered anywhere…
    expect(
      h.streamCalls.find((c) => c.text === "my queued words"),
    ).toBeUndefined();
    // …but restored to the composer, returned to the caller, and announced.
    expect(restored).toBe("my queued words");
    expect(h.deps.setChatInput).toHaveBeenCalledWith("my queued words");
    expect(h.deps.setActionNotice).toHaveBeenCalledWith(
      expect.stringContaining("restored"),
      "info",
      expect.any(Number),
    );
  });

  it("interrupt with an empty queue restores nothing", async () => {
    const h = makeHarness({
      activeConversationId: "conv-A",
      conversations: [conversation("conv-A", "room-A")],
    });
    const { result } = renderHook(() => useChatSend(h.deps));

    let restored = "not-empty";
    await act(async () => {
      restored = result.current.interruptActiveChatPipeline();
    });
    expect(restored).toBe("");
    expect(h.deps.setChatInput).not.toHaveBeenCalled();
  });
});

// ── Seeded fuzz: random interleavings of send-text / send-voice / new-chat ─────

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

interface ExpectedTurn {
  text: string;
  expectedConv: string;
  kind: "text" | "voice";
}

describe("#10700 seeded fuzz — send-text / send-voice / new-chat invariants", () => {
  for (const seed of [1, 7, 42, 1337, 90210]) {
    it(`seed ${seed}: every turn routes to its enqueue-time conversation`, async () => {
      const rng = mulberry32(seed);
      const h = makeHarness({
        activeConversationId: "conv-0",
        conversations: [conversation("conv-0", "room-0")],
      });
      const { result } = renderHook(() => useChatSend(h.deps));
      const send = result.current.sendChatText as unknown as Send;

      const expected: ExpectedTurn[] = [];
      const pendingPromises: Promise<void>[] = [];
      let convCounter = 0;
      let turnCounter = 0;
      const trace: string[] = [];

      const STEPS = 40;
      for (let step = 0; step < STEPS; step++) {
        const roll = rng();
        if (roll < 0.4) {
          // SHELL voice send — the asymmetric surface (no conversationId).
          const text = `v${turnCounter++}`;
          const expectedConv = h.activeId() as string;
          expected.push({ text, expectedConv, kind: "voice" });
          trace.push(`step ${step}: send-voice "${text}" @ ${expectedConv}`);
          pendingPromises.push(send(text, { channelType: "VOICE_DM" }));
          await settle();
        } else if (roll < 0.7) {
          // Composer text send — explicit conversationId (control path).
          const text = `t${turnCounter++}`;
          const expectedConv = h.activeId() as string;
          expected.push({ text, expectedConv, kind: "text" });
          trace.push(`step ${step}: send-text "${text}" @ ${expectedConv}`);
          pendingPromises.push(send(text, { conversationId: expectedConv }));
          await settle();
        } else if (roll < 0.88) {
          // New chat — flip the active conversation while turns may be queued.
          convCounter += 1;
          const id = `conv-${convCounter}`;
          trace.push(`step ${step}: new-chat -> ${id}`);
          h.newChat(id, `room-${convCounter}`);
          await settle();
        } else if (h.inFlightCount() > 0) {
          // Drain one in-flight turn, advancing the single-flight queue.
          trace.push(`step ${step}: drain-one`);
          await act(async () => {
            h.resolveInFlight();
            await Promise.resolve();
            await Promise.resolve();
          });
          await settle();
        }
      }

      // Drain everything that remains.
      for (let i = 0; i < STEPS + 5 && h.inFlightCount() > 0; i++) {
        await act(async () => {
          h.resolveInFlight();
          await Promise.resolve();
          await Promise.resolve();
        });
        await settle();
      }
      await act(async () => {
        await Promise.allSettled(pendingPromises);
      });

      // INVARIANT 1: no lost / no duplicate — exactly one stream per turn.
      expect(h.streamCalls.length).toBe(expected.length);

      // INVARIANT 2: each turn routed to the conversation active at ITS enqueue,
      // regardless of any new-chat that happened while it was queued.
      for (const turn of expected) {
        const call = h.streamCalls.find((c) => c.text === turn.text);
        const detail = `${turn.kind} "${turn.text}" expected @ ${turn.expectedConv}\nTRACE:\n${trace.join("\n")}`;
        expect(call, `missing stream for ${detail}`).toBeDefined();
        expect(call?.convId, `misrouted ${detail}`).toBe(turn.expectedConv);
      }

      // INVARIANT 3: ordering — streams open in enqueue order (single-flight).
      expect(h.streamCalls.map((c) => c.text)).toEqual(
        expected.map((t) => t.text),
      );

      // INVARIANT 4: no stuck sending — the queue is fully drained.
      expect(h.deps.chatSendBusyRef.current).toBe(false);
      expect(h.inFlightCount()).toBe(0);
    });
  }
});
