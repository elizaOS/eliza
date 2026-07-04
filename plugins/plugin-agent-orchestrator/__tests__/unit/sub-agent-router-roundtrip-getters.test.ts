/**
 * Verifies SubAgentRouter round-trip getters (#8901).
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import type { Content, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ROUND_TRIP_CAP } from "../../src/services/router-loop-guard.js";
import { SubAgentRouter } from "../../src/services/sub-agent-router.js";
import type { SessionInfo } from "../../src/services/types.js";

const SESSION_ID = "01234567-89ab-cdef-0123-456789abcdef";
const ROOM = "11111111-2222-3333-4444-555555555555";

function makeSession(): SessionInfo {
  const now = new Date("2026-05-07T12:00:00.000Z");
  return {
    id: SESSION_ID,
    name: "demo-task",
    agentType: "codex",
    workdir: "/tmp/orch-getter-test",
    status: "ready",
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata: { label: "fix-bug-42", roomId: ROOM, source: "telegram" },
  };
}

function makeAcp(session: SessionInfo) {
  let handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | undefined;
  return {
    service: {
      onSessionEvent: vi.fn(
        (cb: (sessionId: string, event: string, data: unknown) => void) => {
          handler = cb;
          return () => {
            handler = undefined;
          };
        },
      ),
      getSession: vi.fn(async () => session),
      getChangedPaths: vi.fn(() => [] as string[]),
      updateSessionMetadata: vi.fn(async () => undefined),
      stopSession: vi.fn(async () => undefined),
    },
    emit(event: string, data: unknown) {
      handler?.(SESSION_ID, event, data);
    },
  };
}

function makeRuntime(
  acpService: unknown,
  setting: Record<string, string> = {},
) {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getService: vi.fn(() => acpService),
    getSetting: vi.fn((k: string) => setting[k]),
    createEntity: vi.fn(async () => true),
    addParticipant: vi.fn(async () => true),
    createMemory: vi.fn(async () => undefined),
    emitEvent: vi.fn(async () => undefined),
    sendMessageToTarget: vi.fn(
      async (_t: unknown, content: Content): Promise<Memory> =>
        ({ id: "m", content }) as Memory,
    ),
    messageService: { handleMessage: vi.fn(async () => ({})) },
  } as never;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("SubAgentRouter round-trip getters (#8901)", () => {
  it("exposes the default cap and a zero count before any round-trip", async () => {
    const acp = makeAcp(makeSession());
    const router = await SubAgentRouter.start(makeRuntime(acp.service));
    try {
      expect(router.getRoundTripCap()).toBe(DEFAULT_ROUND_TRIP_CAP);
      expect(router.getRoundTripCount(SESSION_ID)).toBe(0);
    } finally {
      await router.stop();
    }
  });

  it("counts a real injected round-trip and honors a configured cap", async () => {
    const acp = makeAcp(makeSession());
    const router = await SubAgentRouter.start(
      makeRuntime(acp.service, { ACPX_SUB_AGENT_ROUND_TRIP_CAP: "8" }),
    );
    try {
      expect(router.getRoundTripCap()).toBe(8);

      // A `blocked` event is injected and drives the real loop-guard reducer's
      // round-trip increment (no URL verification / change-set capture, unlike
      // task_complete) — so the getter reads the genuine accumulated count.
      acp.emit("blocked", { message: "waiting on input" });
      await flush();

      expect(router.getRoundTripCount(SESSION_ID)).toBe(1);
      expect(router.getRoundTripCount("some-other-session")).toBe(0);
    } finally {
      await router.stop();
    }
  });
});

// isActive() is the accessor SwarmCoordinatorService consults before ceding
// ownership of an origin-routed session's completion (issue
// elizaOS/eliza#11634). It must report true only while the router is bound to
// the ACP stream, and flip to false when disabled or stopped — otherwise the
// coordinator would go silent (router not posting) or double-post (both
// posting).
describe("SubAgentRouter.isActive (#11634 ownership gate)", () => {
  it("is true once bound to the ACP session-event stream", async () => {
    const acp = makeAcp(makeSession());
    const router = await SubAgentRouter.start(makeRuntime(acp.service));
    try {
      expect(router.isActive()).toBe(true);
    } finally {
      await router.stop();
    }
  });

  it("is false after stop() unbinds the stream", async () => {
    const acp = makeAcp(makeSession());
    const router = await SubAgentRouter.start(makeRuntime(acp.service));
    expect(router.isActive()).toBe(true);
    await router.stop();
    expect(router.isActive()).toBe(false);
  });

  it("is false when disabled via ACPX_SUB_AGENT_ROUTER_DISABLED (never binds)", async () => {
    const acp = makeAcp(makeSession());
    const router = await SubAgentRouter.start(
      makeRuntime(acp.service, { ACPX_SUB_AGENT_ROUTER_DISABLED: "1" }),
    );
    try {
      // start() returns before binding, so the router never posts — the
      // coordinator must NOT cede ownership to it.
      expect(router.isActive()).toBe(false);
    } finally {
      await router.stop();
    }
  });
});
