// @vitest-environment jsdom
/**
 * Ordering contract for the two conversation re-sort sites in bindReadyPhase.
 *
 * Both the `conversation-updated` and `proactive-message` WebSocket handlers
 * re-sort the sidebar's conversation list. The wire payload reaches the sort
 * unvalidated, so an unparseable `updatedAt` must sort last rather than
 * leaving the comparator NaN-valued and the whole ordering undefined. Drives
 * the real exported bindReadyPhase through its registered handlers; the
 * comparator itself is never re-implemented here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../api";
import { bindReadyPhase, type ReadyPhaseDeps } from "./startup-phase-hydrate";

const clientMock = vi.hoisted(() => {
  const handlers = new Map<string, (data: Record<string, unknown>) => void>();
  return {
    connectWs: vi.fn(),
    disconnectWs: vi.fn(),
    getCodingAgentStatus: vi.fn(async () => ({ tasks: [] })),
    handlers,
    onWsEvent: vi.fn(
      (event: string, handler: (data: Record<string, unknown>) => void) => {
        handlers.set(event, handler);
        return () => {
          handlers.delete(event);
        };
      },
    ),
    sendWsMessage: vi.fn(),
    getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
    repointBaseUrl: vi.fn(),
    setToken: vi.fn(),
  };
});

vi.mock("../api", () => ({ client: clientMock }));

// The storage bridge dynamically imports the native secure-store package,
// which is not installed in every environment; mock it the same way the
// storage-bridge contract suite does so transform-time resolution succeeds.
vi.mock("@elizaos/capacitor-secure-store", () => ({
  SecureStore: {
    get: async () => ({ value: null }),
    set: async () => undefined,
    remove: async () => undefined,
  },
}));

function makeConversation(id: string, updatedAt: string): Conversation {
  return {
    id,
    title: id,
    updatedAt,
  } as Conversation;
}

interface Captured {
  deps: ReadyPhaseDeps;
  latestOrder: (initial: Conversation[]) => string[];
}

function makeDeps(): Captured {
  let updater: ((prev: Conversation[]) => Conversation[]) | null = null;
  const deps = {
    setAgentStatusIfChanged: vi.fn(),
    setPendingRestart: vi.fn(),
    setPendingRestartReasons: vi.fn(),
    setSystemWarnings: vi.fn(),
    showRestartBanner: vi.fn(),
    setPtySessions: vi.fn(),
    hasPtySessionsRef: { current: false },
    agentRunningRef: { current: false },
    setTabRaw: vi.fn(),
    setConversationMessages: vi.fn(),
    setUnreadConversations: vi.fn(),
    setConversations: vi.fn(
      (next: (prev: Conversation[]) => Conversation[]) => {
        updater = next;
      },
    ),
    appendAutonomousEvent: vi.fn(),
    notifyHeartbeatEvent: vi.fn(),
    loadPlugins: vi.fn(async () => {}),
    loadWalletConfig: vi.fn(async () => {}),
    pollCloudCredits: vi.fn(),
    activeConversationIdRef: { current: null },
    elizaCloudPollInterval: { current: null },
    elizaCloudLoginPollTimer: { current: null },
    setActionNotice: vi.fn(),
  } as unknown as ReadyPhaseDeps;
  return {
    deps,
    latestOrder: (initial: Conversation[]) => {
      if (!updater) throw new Error("setConversations was never called");
      return updater(initial).map((conversation) => conversation.id);
    },
  };
}

function fire(event: string, data: Record<string, unknown>): void {
  const handler = clientMock.handlers.get(event);
  if (!handler) throw new Error(`no handler registered for ${event}`);
  handler(data);
}

describe("bindReadyPhase conversation re-sort ordering", () => {
  let cleanup: (() => void) | undefined;

  beforeEach(() => {
    clientMock.handlers.clear();
  });

  // bindReadyPhase installs an interval and window listeners; unbind after
  // every case, including the last one.
  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it("conversation-updated: valid conversations take their true order and an unparseable updatedAt sorts last", () => {
    const captured = makeDeps();
    cleanup = bindReadyPhase({ current: captured.deps });

    fire("conversation-updated", {
      conversation: makeConversation("updated", "2026-01-03T00:00:00.000Z"),
    });

    const order = captured.latestOrder([
      makeConversation("invalid", ""),
      makeConversation("updated", "2026-01-01T00:00:00.000Z"),
      makeConversation("older", "2026-01-02T00:00:00.000Z"),
    ]);

    expect(order).toEqual(["updated", "older", "invalid"]);
  });

  it("proactive-message: the targeted conversation rises to the top past an unparseable neighbour", () => {
    const captured = makeDeps();
    cleanup = bindReadyPhase({ current: captured.deps });

    fire("proactive-message", {
      conversationId: "target",
      message: {
        id: "m1",
        role: "assistant",
        text: "hello",
        timestamp: 1767312000000,
      },
    });

    const order = captured.latestOrder([
      makeConversation("invalid", ""),
      makeConversation("target", "2026-01-01T00:00:00.000Z"),
      makeConversation("newest", "2026-01-02T00:00:00.000Z"),
    ]);

    expect(order[0]).toBe("target");
    expect(order[order.length - 1]).toBe("invalid");
  });

  it("two unparseable stamps order deterministically by id instead of by traversal luck", () => {
    const captured = makeDeps();
    cleanup = bindReadyPhase({ current: captured.deps });

    fire("conversation-updated", {
      conversation: makeConversation("valid", "2026-01-03T00:00:00.000Z"),
    });

    const order = captured.latestOrder([
      makeConversation("z-bad", "not-a-date"),
      makeConversation("a-bad", ""),
      makeConversation("valid", "2026-01-01T00:00:00.000Z"),
    ]);

    expect(order).toEqual(["valid", "a-bad", "z-bad"]);
  });

  it("two equal parseable stamps compare 0 and keep their incoming order", () => {
    const captured = makeDeps();
    cleanup = bindReadyPhase({ current: captured.deps });

    fire("conversation-updated", {
      conversation: makeConversation("newest", "2026-01-03T00:00:00.000Z"),
    });

    // The id tie-break is reserved for two unparseable stamps. Equal valid
    // stamps must not be reordered into id order — `conversation-updated`
    // stamps `new Date().toISOString()`, so same-millisecond ties are real and
    // the sort's stability is what keeps the sidebar from shuffling.
    const order = captured.latestOrder([
      makeConversation("z-equal", "2026-01-01T00:00:00.000Z"),
      makeConversation("a-equal", "2026-01-01T00:00:00.000Z"),
      makeConversation("newest", "2026-01-02T00:00:00.000Z"),
    ]);

    expect(order).toEqual(["newest", "z-equal", "a-equal"]);
  });
});
