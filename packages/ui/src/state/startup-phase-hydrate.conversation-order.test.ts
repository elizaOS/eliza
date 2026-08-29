/**
 * Pins the total ordering of the ready-phase conversation list.
 *
 * Drives the real exported `bindReadyPhase` through the WebSocket handlers it
 * registers, so both re-sort sites are exercised on their production path. The
 * `client` module is stubbed at the api boundary to capture handlers; the
 * ordering under test is the real one.
 */
// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
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
        return () => handlers.delete(event);
      },
    ),
    sendWsMessage: vi.fn(),
  };
});

vi.mock("../api", () => ({
  client: clientMock,
}));

vi.mock("../utils", () => ({
  isTransientOptionalFetchFailure: () => false,
}));

vi.mock("../bridge/storage-bridge", () => ({
  setStorageValue: vi.fn(async () => {}),
}));

function conversation(id: string, updatedAt: string, title = id): Conversation {
  return {
    id,
    title,
    roomId: `room-${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt,
  };
}

function makeDeps(initial: Conversation[]): {
  deps: ReadyPhaseDeps;
  readConversations: () => Conversation[];
} {
  let conversations = initial;
  const deps: ReadyPhaseDeps = {
    setActionNotice: vi.fn(),
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
    setConversations: vi.fn((value) => {
      conversations =
        typeof value === "function" ? value(conversations) : value;
    }),
    appendAutonomousEvent: vi.fn(),
    notifyHeartbeatEvent: vi.fn(),
    loadPlugins: vi.fn(async () => {}),
    loadWalletConfig: vi.fn(async () => {}),
    pollCloudCredits: vi.fn(),
    activeConversationIdRef: { current: null },
    elizaCloudPollInterval: { current: null },
    elizaCloudLoginPollTimer: { current: null },
  };
  return { deps, readConversations: () => conversations };
}

describe("bindReadyPhase conversation ordering", () => {
  it("keeps a conversation with an unparseable updatedAt from pinning itself above a newly updated one", () => {
    clientMock.handlers.clear();
    const { deps, readConversations } = makeDeps([
      conversation("invalid", ""),
      conversation("updated", "2026-01-02T00:00:00.000Z", "Old title"),
      conversation("older", "2026-01-01T00:00:00.000Z"),
    ]);
    const cleanup = bindReadyPhase({ current: deps });

    try {
      clientMock.handlers.get("conversation-updated")?.({
        conversation: conversation(
          "updated",
          "2026-01-03T00:00:00.000Z",
          "New title",
        ),
      });

      expect(readConversations().map(({ id }) => id)).toEqual([
        "updated",
        "older",
        "invalid",
      ]);
    } finally {
      cleanup();
    }
  });

  it("moves the conversation a proactive message arrived in to the top past an unparseable updatedAt", () => {
    clientMock.handlers.clear();
    const { deps, readConversations } = makeDeps([
      conversation("invalid", "not-a-date"),
      conversation("newest", "2026-01-03T00:00:00.000Z"),
      conversation("target", "2026-01-01T00:00:00.000Z"),
    ]);
    const cleanup = bindReadyPhase({ current: deps });

    try {
      clientMock.handlers.get("proactive-message")?.({
        conversationId: "target",
        message: {
          id: "msg-1",
          role: "assistant",
          text: "hello",
          timestamp: Date.parse("2026-01-04T00:00:00.000Z"),
        },
      });

      expect(readConversations().map(({ id }) => id)).toEqual([
        "target",
        "newest",
        "invalid",
      ]);
    } finally {
      cleanup();
    }
  });

  it("breaks a tie on id so equal updatedAt values keep a deterministic order", () => {
    clientMock.handlers.clear();
    const { deps, readConversations } = makeDeps([
      conversation("b-conv", "2026-01-02T00:00:00.000Z"),
      conversation("a-conv", "2026-01-02T00:00:00.000Z"),
    ]);
    const cleanup = bindReadyPhase({ current: deps });

    try {
      clientMock.handlers.get("conversation-updated")?.({
        conversation: conversation("a-conv", "2026-01-02T00:00:00.000Z"),
      });

      expect(readConversations().map(({ id }) => id)).toEqual([
        "a-conv",
        "b-conv",
      ]);
    } finally {
      cleanup();
    }
  });
});
