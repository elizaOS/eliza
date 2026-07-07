/**
 * Mid-session account failover: a running sub-agent that dies on a pooled
 * account's rate-limit / auth failure must not fail the task. The router marks
 * the account in the pool, then — while a healthy sibling account remains —
 * respawns the task through the normal spawn path (which selects the sibling)
 * and suppresses the dead session's error post. When the pool is exhausted the
 * honest failure reaches the user, and the respawn budget is bounded by the
 * shared state_lost lineage cap.
 */

// biome-ignore assist/source/organizeImports: comment-only pass preserves import token order.
import { CODING_AGENT_SELECTOR_BRIDGE_SYMBOL } from "@elizaos/core";
import type { Content, HandlerCallback, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubAgentRouter } from "../../src/services/sub-agent-router.js";
import type { SessionInfo } from "../../src/services/types.js";

const BRIDGE_SYMBOL = CODING_AGENT_SELECTOR_BRIDGE_SYMBOL;
const ROOM = "11111111-2222-3333-4444-555555555555";
const ORIGIN_MESSAGE = "99999999-8888-7777-6666-555555555555";

const ACCOUNT = {
  providerId: "anthropic-subscription",
  accountId: "acct-limited",
  label: "Work",
  source: "oauth",
  strategy: "least-used",
};

function makeSession(id: string): SessionInfo {
  const now = new Date("2026-07-01T12:00:00.000Z");
  return {
    id,
    name: "demo",
    agentType: "claude",
    workdir: "/tmp/wf",
    status: "errored",
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata: {
      label: "fix-bug",
      roomId: ROOM,
      source: "telegram",
      messageId: ORIGIN_MESSAGE,
      initialTask: "fix the login bug",
      account: ACCOUNT,
    },
  };
}

/** Multi-session ACP mock: sessions keyed by id, spawnSession records calls. */
function makeAcp(sessions: SessionInfo[]) {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  let handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | undefined;
  const spawnSession = vi.fn(async () => ({ sessionId: "retry-spawned" }));
  return {
    service: {
      onSessionEvent: vi.fn((fn: typeof handler) => {
        handler = fn;
        return () => {
          handler = undefined;
        };
      }),
      getSession: vi.fn(async (id: string) => byId.get(id) ?? null),
      listSessions: vi.fn(async () => [...byId.values()]),
      stopSession: vi.fn(async () => {}),
      updateSessionMetadata: vi.fn(async () => undefined),
      getChangedPaths: vi.fn(() => [] as string[]),
      sendToSession: vi.fn(async () => ({})),
      spawnSession,
    },
    spawnSession,
    emit(id: string, event: string, data: unknown) {
      handler?.(id, event, data);
    },
  };
}

function makeRuntime(acp: unknown, setting?: Record<string, string>) {
  const handleMessage = vi.fn<
    (rt: unknown, m: Memory, cb?: HandlerCallback) => Promise<unknown>
  >(async () => ({}));
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getService: vi.fn(() => acp),
    getSetting: vi.fn((k: string) => setting?.[k]),
    createMemory: vi.fn(async () => undefined),
    createEntity: vi.fn(async () => true),
    addParticipant: vi.fn(async () => true),
    getEntitiesForRoom: vi.fn(async () => []),
    deleteParticipants: vi.fn(async () => true),
    reportError: vi.fn(),
    emitEvent: vi.fn(async () => undefined),
    sendMessageToTarget: vi.fn(async (_t: unknown, content: Content) => ({
      id: "aaaaaaaa-0000-0000-0000-000000000000",
      content,
    })),
    messageService: { handleMessage },
  } as never;
  return { runtime, handleMessage };
}

function makeBridge(healthy: number) {
  return {
    describe: vi.fn(() => ({
      claude: [
        {
          providerId: "anthropic-subscription",
          total: 2,
          enabled: 2,
          healthy,
        },
      ],
    })),
    select: vi.fn(async () => null),
    markRateLimited: vi.fn(async () => undefined),
    markNeedsReauth: vi.fn(async () => undefined),
    recordUsage: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL];
  vi.clearAllMocks();
});

describe("mid-session account failover", () => {
  let bridge: ReturnType<typeof makeBridge>;

  beforeEach(() => {
    bridge = makeBridge(1);
    (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = bridge;
  });

  it("respawns the task on a rate-limit error while a healthy sibling remains, suppressing the error post", async () => {
    const acp = makeAcp([makeSession("s-1")]);
    const { runtime, handleMessage } = makeRuntime(acp.service);
    const router = await SubAgentRouter.start(runtime);

    acp.emit("s-1", "error", { message: "429 rate limit exceeded" });
    await new Promise((r) => setTimeout(r, 20));

    // The dud account was marked BEFORE the respawn re-selected.
    expect(bridge.markRateLimited).toHaveBeenCalledTimes(1);
    // Respawned through the normal spawn path with the original task + origin.
    expect(acp.spawnSession).toHaveBeenCalledTimes(1);
    const spawnArgs = acp.spawnSession.mock.calls[0]?.[0] as {
      agentType: string;
      initialTask: string;
      metadata: Record<string, unknown>;
    };
    expect(spawnArgs.agentType).toBe("claude");
    expect(spawnArgs.initialTask).toBe("fix the login bug");
    expect(spawnArgs.metadata.retryOfSessionId).toBe("s-1");
    expect(spawnArgs.metadata.roomId).toBe(ROOM);
    // The dead session's stale account descriptor is NOT carried forward —
    // spawnSession re-selects and re-stamps it.
    expect(spawnArgs.metadata.account).toBeUndefined();
    // Dead session stopped; its error narration suppressed (the replacement's
    // own task_complete is the only user-facing message).
    expect(acp.service.stopSession).toHaveBeenCalledWith("s-1");
    expect(handleMessage).not.toHaveBeenCalled();

    await router.stop();
  });

  it("respawns on a needs-reauth session error too (expired injected token mid-run)", async () => {
    const acp = makeAcp([makeSession("s-1")]);
    const { runtime, handleMessage } = makeRuntime(acp.service);
    const router = await SubAgentRouter.start(runtime);

    acp.emit("s-1", "error", {
      message: "401 Unauthorized: token expired",
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(bridge.markNeedsReauth).toHaveBeenCalledTimes(1);
    expect(acp.spawnSession).toHaveBeenCalledTimes(1);
    expect(handleMessage).not.toHaveBeenCalled();

    await router.stop();
  });

  it("delivers the honest failure (no respawn) when the pool has no healthy account left", async () => {
    bridge = makeBridge(0);
    (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = bridge;
    const acp = makeAcp([makeSession("s-1")]);
    const { runtime, handleMessage } = makeRuntime(acp.service);
    const router = await SubAgentRouter.start(runtime);

    acp.emit("s-1", "error", { message: "429 rate limit exceeded" });
    await new Promise((r) => setTimeout(r, 20));

    expect(bridge.markRateLimited).toHaveBeenCalledTimes(1);
    expect(acp.spawnSession).not.toHaveBeenCalled();
    // The error narration reaches the planner/user.
    expect(handleMessage).toHaveBeenCalledTimes(1);

    await router.stop();
  });

  it("delivers a normal task error unchanged (no failover, no pool mark)", async () => {
    const acp = makeAcp([makeSession("s-1")]);
    const { runtime, handleMessage } = makeRuntime(acp.service);
    const router = await SubAgentRouter.start(runtime);

    acp.emit("s-1", "error", {
      message: "TypeError: cannot read property 'x' of undefined",
    });
    await new Promise((r) => setTimeout(r, 20));

    expect(bridge.markRateLimited).not.toHaveBeenCalled();
    expect(bridge.markNeedsReauth).not.toHaveBeenCalled();
    expect(acp.spawnSession).not.toHaveBeenCalled();
    expect(handleMessage).toHaveBeenCalledTimes(1);

    await router.stop();
  });

  it("exhausts the shared lineage budget and posts ONE honest account-failure terminal", async () => {
    // Four sessions in the same origin lineage (respawn cascade): the first
    // three rate-limit errors respawn; the fourth crosses the cap (3) and
    // posts a single terminal narration naming the account failure. Pin the cap
    // to 3 so this stays a mechanism test — the default is now derived from the
    // shared crash-retry budget (#14104).
    const sessions = ["s-1", "s-2", "s-3", "s-4"].map(makeSession);
    const acp = makeAcp(sessions);
    const { runtime, handleMessage } = makeRuntime(acp.service, {
      ACPX_STATE_LOST_RESPAWN_CAP: "3",
    });
    const router = await SubAgentRouter.start(runtime);

    for (const [i, s] of sessions.entries()) {
      acp.emit(s.id, "error", {
        message: `429 rate limit exceeded (turn ${i})`,
      });
      await new Promise((r) => setTimeout(r, 20));
    }

    expect(acp.spawnSession).toHaveBeenCalledTimes(3);
    expect(handleMessage).toHaveBeenCalledTimes(1);
    const posted = handleMessage.mock.calls[0]?.[1] as Memory;
    const text = String((posted.content as Content).text ?? "");
    expect(text).toContain("account rate-limited");
    expect(text).toContain("exhausted its automatic account-failover restarts");

    await router.stop();
  });
});
