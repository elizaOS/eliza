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
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/services/config-env.js", () => ({
  readConfigEnvKey: (key: string) => process.env[key],
}));

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

function makeSession(
  id: string,
  overrides: Partial<SessionInfo> = {},
): SessionInfo {
  const now = new Date("2026-07-01T12:00:00.000Z");
  const session: SessionInfo = {
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
  return {
    ...session,
    ...overrides,
    metadata: { ...session.metadata, ...overrides.metadata },
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
      getSessionOutput: vi.fn(async () => "Implemented login validation."),
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
    expect(spawnArgs.initialTask).toContain("[RESUMING AFTER FAILOVER]");
    expect(spawnArgs.initialTask).toContain("fix the login bug");
    expect(spawnArgs.metadata.retryOfSessionId).toBe("s-1");
    expect(spawnArgs.metadata.roomId).toBe(ROOM);
    // The dead session's stale account descriptor is NOT carried forward —
    // spawnSession re-selects and re-stamps it.
    expect(spawnArgs.metadata.account).toBeUndefined();
    expect(spawnArgs.metadata.resumeContext).toMatchObject({
      kind: "rate-limit-failover",
      reason: "rate-limited",
      fromSessionId: "s-1",
      lastProgress: "Implemented login validation.",
    });
    // Dead session stopped; its error narration suppressed (the replacement's
    // own task_complete is the only user-facing message).
    expect(acp.service.stopSession).toHaveBeenCalledWith("s-1");
    expect(handleMessage).not.toHaveBeenCalled();

    await router.stop();
  });

  it("carries the predecessor branch and real on-disk changes into the resume envelope", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "account-failover-resume-"));
    try {
      execFileSync("git", ["init", "-b", "feature/login-fix"], {
        cwd: workdir,
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: workdir,
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: workdir });
      writeFileSync(join(workdir, "README.md"), "baseline\n");
      execFileSync("git", ["add", "."], { cwd: workdir });
      execFileSync("git", ["commit", "-m", "baseline"], { cwd: workdir });
      const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: workdir,
        encoding: "utf8",
      }).trim();
      writeFileSync(
        join(workdir, "src-login.ts"),
        "export const fixed = true;\n",
      );

      const acp = makeAcp([
        makeSession("s-1", {
          workdir,
          metadata: { codingBaselineSha: baseline },
        }),
      ]);
      acp.service.getChangedPaths.mockReturnValue(["src-login.ts"]);
      const { runtime } = makeRuntime(acp.service);
      const router = await SubAgentRouter.start(runtime);

      acp.emit("s-1", "error", { message: "429 rate limit exceeded" });
      await new Promise((resolve) => setTimeout(resolve, 40));

      const spawnArgs = acp.spawnSession.mock.calls[0]?.[0] as {
        initialTask: string;
        metadata: Record<string, unknown>;
      };
      expect(spawnArgs.metadata.resumeContext).toMatchObject({
        branch: "feature/login-fix",
        changedFiles: ["src-login.ts"],
      });
      expect(spawnArgs.initialTask).toContain("feature/login-fix");
      expect(spawnArgs.initialTask).toContain("src-login.ts");

      await router.stop();
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
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

  it("with authReason=token_expired: respawns with a fresh token but does NOT mark the account needs-reauth", async () => {
    // The injected bare CLAUDE_CODE_OAUTH_TOKEN aged out mid-run while the
    // account stays healthy. The router must recover (respawn re-injects a
    // fresh token) WITHOUT sidelining the working account in the pool.
    const acp = makeAcp([makeSession("s-1")]);
    const { runtime, handleMessage } = makeRuntime(acp.service);
    const router = await SubAgentRouter.start(runtime);

    acp.emit("s-1", "error", {
      message: "oauth token has expired",
      failureKind: "auth",
      authReason: "token_expired",
    });
    await new Promise((r) => setTimeout(r, 20));

    // Account NOT marked — it is healthy, only the injected token expired.
    expect(bridge.markNeedsReauth).not.toHaveBeenCalled();
    expect(bridge.markRateLimited).not.toHaveBeenCalled();
    // But the task still recovered via a respawn (fresh token re-injected).
    expect(acp.spawnSession).toHaveBeenCalledTimes(1);
    // Dead session's error narration suppressed (respawn is authoritative).
    expect(handleMessage).not.toHaveBeenCalled();

    await router.stop();
  });

  it("respawns on a token_expired authReason even when the message classifier misses the phrase (jwt expired)", async () => {
    // `classifyAccountFailure` does not recognize `jwt expired` / `session
    // expired` / `expired_token`, but the emitter already typed it via
    // authReason. The router must still fire the recovery respawn, without
    // marking the (healthy) account.
    const acp = makeAcp([makeSession("s-1")]);
    const { runtime, handleMessage } = makeRuntime(acp.service);
    const router = await SubAgentRouter.start(runtime);

    acp.emit("s-1", "error", {
      message: "jwt expired", // NOT matched by classifyAccountFailure
      failureKind: "auth",
      authReason: "token_expired",
    });
    await new Promise((r) => setTimeout(r, 20));

    // Recovered via respawn despite the classifier miss.
    expect(acp.spawnSession).toHaveBeenCalledTimes(1);
    // Account kept healthy (token merely aged out).
    expect(bridge.markNeedsReauth).not.toHaveBeenCalled();
    expect(handleMessage).not.toHaveBeenCalled();

    await router.stop();
  });

  it("token-expiry whose respawn FAILS marks the account needs-reauth (no stuck retry)", async () => {
    // If the parent cannot mint a replacement token (dead refresh / outage),
    // respawnStateLost fails. We must then mark the account needs-reauth so the
    // task terminates honestly instead of lingering in retrying with no worker.
    const acp = makeAcp([makeSession("s-1")]);
    acp.spawnSession.mockRejectedValueOnce(new Error("token refresh failed"));
    const { runtime, handleMessage } = makeRuntime(acp.service);
    const router = await SubAgentRouter.start(runtime);

    acp.emit("s-1", "error", {
      message: "oauth token has expired",
      failureKind: "auth",
      authReason: "token_expired",
    });
    await new Promise((r) => setTimeout(r, 20));

    // Respawn was attempted...
    expect(acp.spawnSession).toHaveBeenCalledTimes(1);
    // ...and failed, so the account IS now marked needs-reauth (fallback).
    expect(bridge.markNeedsReauth).toHaveBeenCalledTimes(1);
    // The honest error reaches the planner/user (no silent stuck retry).
    expect(handleMessage).toHaveBeenCalledTimes(1);

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
