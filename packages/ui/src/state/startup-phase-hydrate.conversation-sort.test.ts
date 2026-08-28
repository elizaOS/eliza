/** Verifies bindReadyPhase conversation ordering is total for unparseable updatedAt via jsdom with mocked API client — deterministic, no live agent. */
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "../api";
import { bindReadyPhase, type ReadyPhaseDeps } from "./startup-phase-hydrate";

const clientMock = vi.hoisted(() => {
  const handlers = new Map<string, (data: Record<string, unknown>) => void>();
  return {
    connectWs: vi.fn(),
    disconnectWs: vi.fn(),
    getCodingAgentStatus: vi.fn(async () => ({ tasks: [] })),
    getBaseUrl: vi.fn(() => "http://127.0.0.1:31337"),
    sendWsMessage: vi.fn(),
    handlers,
    onWsEvent: vi.fn(
      (event: string, handler: (data: Record<string, unknown>) => void) => {
        handlers.set(event, handler);
        return () => {
          handlers.delete(event);
        };
      },
    ),
  };
});

vi.mock("../api", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...(original as object),
    client: clientMock,
  };
});

vi.mock("../components/views/device-control-interact", () => ({
  registerDeviceControlInteractHandler: vi.fn(() => () => {}),
}));

function makeDeps(overrides: Partial<ReadyPhaseDeps> = {}): ReadyPhaseDeps {
  return {
    setAgentStatusIfChanged: vi.fn(),
    setPendingRestart: vi.fn(),
    setPendingRestartReasons: vi.fn(),
    setSystemWarnings: vi.fn(),
    showRestartBanner: vi.fn(),
    setPtySessions: vi.fn(),
    hasPtySessionsRef: { current: false } as React.MutableRefObject<boolean>,
    agentRunningRef: { current: false } as React.MutableRefObject<boolean>,
    setTabRaw: vi.fn(),
    setConversationMessages: vi.fn(),
    setUnreadConversations: vi.fn(),
    setConversations: vi.fn(),
    appendAutonomousEvent: vi.fn(),
    notifyHeartbeatEvent: vi.fn(),
    loadPlugins: vi.fn(async () => {}),
    loadWalletConfig: vi.fn(async () => {}),
    pollCloudCredits: vi.fn(),
    activeConversationIdRef: { current: null } as React.RefObject<
      string | null
    >,
    elizaCloudPollInterval: { current: null } as React.MutableRefObject<
      number | null
    >,
    elizaCloudLoginPollTimer: { current: null } as React.MutableRefObject<
      number | null
    >,
    setActionNotice: vi.fn(),
    ...overrides,
  };
}

function makeConversation(id: string, updatedAt: string): Conversation {
  return {
    id,
    title: id,
    roomId: `room-${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}

describe("bindReadyPhase conversation sort is total", () => {
  beforeEach(() => {
    clientMock.handlers.clear();
    clientMock.onWsEvent.mockClear();
  });

  it("conversation-updated: invalid updatedAt sorts last and valid entries stay newest-first", () => {
    const deps = makeDeps();
    const captured: Array<(prev: Conversation[]) => Conversation[]> = [];
    deps.setConversations = vi.fn((updater: unknown) => {
      if (typeof updater === "function") {
        captured.push(updater as (prev: Conversation[]) => Conversation[]);
      }
    }) as unknown as ReadyPhaseDeps["setConversations"];

    const cleanup = bindReadyPhase({ current: deps });
    const handler = clientMock.handlers.get("conversation-updated");
    expect(handler).toBeDefined();

    const invalid = makeConversation("invalid", "");
    const older = makeConversation("older", "2026-01-01T00:00:00.000Z");
    const updated = makeConversation("updated", "2026-01-03T00:00:00.000Z");

    handler?.({ conversation: updated });

    expect(captured.length).toBe(1);
    const result = captured[0]([invalid, older, updated]);

    expect(result.map((c) => c.id)).toEqual(["updated", "older", "invalid"]);

    cleanup();
  });

  it("proactive-message: target moves to front, valid order preserved, invalid last", () => {
    const deps = makeDeps();
    deps.activeConversationIdRef = { current: null } as React.RefObject<
      string | null
    >;
    const captured: Array<(prev: Conversation[]) => Conversation[]> = [];
    deps.setConversations = vi.fn((updater: unknown) => {
      if (typeof updater === "function") {
        captured.push(updater as (prev: Conversation[]) => Conversation[]);
      }
    }) as unknown as ReadyPhaseDeps["setConversations"];

    const cleanup = bindReadyPhase({ current: deps });
    const handler = clientMock.handlers.get("proactive-message");
    expect(handler).toBeDefined();

    const invalid = makeConversation("invalid", "");
    const newest = makeConversation("newest", "2026-01-02T00:00:00.000Z");
    const target = makeConversation("target", "2026-01-01T00:00:00.000Z");

    handler?.({
      conversationId: "target",
      message: {
        id: "msg-1",
        role: "user",
        text: "hello",
        timestamp: Date.now(),
        source: "other-source",
      },
    });

    expect(captured.length).toBe(1);
    const result = captured[0]([invalid, target, newest]);

    expect(result[0].id).toBe("target");
    expect(result[1].id).toBe("newest");
    expect(result[2].id).toBe("invalid");
    expect(result.map((c) => c.id)).toEqual(["target", "newest", "invalid"]);

    cleanup();
  });

  it("both sites handle Infinity and NaN as unparseable and keep valid newest-first", () => {
    const deps = makeDeps();
    const captured: Array<(prev: Conversation[]) => Conversation[]> = [];
    deps.setConversations = vi.fn((updater: unknown) => {
      if (typeof updater === "function") {
        captured.push(updater as (prev: Conversation[]) => Conversation[]);
      }
    }) as unknown as ReadyPhaseDeps["setConversations"];

    const cleanup = bindReadyPhase({ current: deps });

    const handlerUpdated = clientMock.handlers.get("conversation-updated");
    const handlerProactive = clientMock.handlers.get("proactive-message");
    expect(handlerUpdated).toBeDefined();
    expect(handlerProactive).toBeDefined();

    const invalidEmpty = makeConversation("invalidEmpty", "");
    const invalidInfinity = makeConversation("invalidInfinity", "Infinity");
    const older = makeConversation("older", "2026-01-01T00:00:00.000Z");
    const newer = makeConversation("newer", "2026-01-02T00:00:00.000Z");

    if (!handlerUpdated || !handlerProactive)
      throw new Error("handlers missing");
    handlerUpdated({ conversation: newer });
    const result1 = captured[0]([invalidEmpty, invalidInfinity, older, newer]);
    expect(result1.slice(0, 2).map((c) => c.id)).toEqual(["newer", "older"]);
    expect(
      result1
        .slice(2)
        .map((c) => c.id)
        .sort(),
    ).toEqual(["invalidEmpty", "invalidInfinity"].sort());

    captured.length = 0;

    handlerProactive({
      conversationId: "older",
      message: {
        id: "msg-2",
        role: "user",
        text: "hi",
        timestamp: Date.now(),
      },
    });
    const result2 = captured[0]([invalidEmpty, older, newer]);
    expect(result2[0].id).toBe("older");
    expect(result2[1].id).toBe("newer");
    expect(result2[2].id).toBe("invalidEmpty");

    cleanup();
  });
});
