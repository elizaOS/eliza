/**
 * Pins the `failed` producer for un-respawnable session crashes (#13771,
 * regression from #13830). Drives the REAL {@link OrchestratorTaskService}
 * event bridge over a real in-memory store and a FakeAcp emitting real `error`
 * session events, then reads the resulting durable task status.
 *
 * The invariant under test: a plain session crash (non-zero exit / generic
 * error — NOT an account rate-limit/needs-reauth, NOT `session_state_lost`) has
 * NO respawn producer in `sub-agent-router.ts` (its `classifyAccountFailure` /
 * `session_state_lost` respawn gates never fire on a generic error), so the
 * task MUST reach terminal `failed` on the FIRST such crash. Routing it to a
 * non-terminal `retrying → active` on the false assumption the router will
 * re-drive it wedges the task forever — the exact P0 #13771 was meant to fix.
 * The account-failover / state-lost cases stay non-terminal because the router
 * DOES respawn them; those are asserted here too so the fix can't over-correct.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { CODING_AGENT_SELECTOR_BRIDGE_SYMBOL } from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";
import { MAX_SESSION_RETRY_ATTEMPTS } from "../../src/services/orchestrator-task-types.js";

const BRIDGE_SYMBOL = CODING_AGENT_SELECTOR_BRIDGE_SYMBOL;

/** Register a global coding-account bridge reporting `healthy` accounts for the
 * `claude` agent type, so `hasHealthyPooledAccount("claude")` reflects the pool
 * the way the router's failover gate would see it. */
function installBridge(healthy: number): void {
  (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL] = {
    describe: () => ({
      claude: [
        { providerId: "anthropic-subscription", total: 2, enabled: 2, healthy },
      ],
    }),
    select: async () => null,
    markRateLimited: async () => undefined,
    markNeedsReauth: async () => undefined,
    recordUsage: async () => undefined,
  };
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[BRIDGE_SYMBOL];
});

// Keep criteria-free tasks criteria-free so a `task_complete` never fires the
// auto-verifier here (mirrors attach-session.test.ts).
const PREV_GOAL_CONTRACT = process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
beforeAll(() => {
  process.env.ELIZA_REQUIRE_GOAL_CONTRACT = "0";
});
afterAll(() => {
  if (PREV_GOAL_CONTRACT === undefined)
    delete process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
  else process.env.ELIZA_REQUIRE_GOAL_CONTRACT = PREV_GOAL_CONTRACT;
});

/** Minimal ACP stand-in: captures the orchestrator's event subscription so a
 * test can drive real `error` session events through the real bridge. */
class FakeAcp {
  private handler:
    | ((sessionId: string, event: string, data: unknown) => void)
    | null = null;

  onSessionEvent(
    cb: (sessionId: string, event: string, data: unknown) => void,
  ): () => void {
    this.handler = cb;
    return () => {
      this.handler = null;
    };
  }

  emit(sessionId: string, event: string, data: unknown = {}): void {
    this.handler?.(sessionId, event, data);
  }
}

function runtime(acp: FakeAcp): IAgentRuntime {
  return {
    getService: () => acp,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    reportError: vi.fn(),
  } as never;
}

async function makeService(): Promise<{
  service: OrchestratorTaskService;
  acp: FakeAcp;
  taskId: string;
}> {
  const acp = new FakeAcp();
  const store = new OrchestratorTaskStore({ backend: "memory" });
  const service = new OrchestratorTaskService(runtime(acp), { store });
  await service.start();
  const task = await service.createTask({
    title: "Build the thing",
    goal: "Ship it",
  });
  return { service, acp, taskId: task.id };
}

/** Attach a live session and emit an `error` for it, letting the bridge settle. */
async function crash(
  service: OrchestratorTaskService,
  acp: FakeAcp,
  taskId: string,
  sessionId: string,
  errorData: Record<string, unknown>,
): Promise<void> {
  await service.attachSession(taskId, {
    sessionId,
    agentType: "codex",
    workdir: "/tmp/workdir",
    status: "ready",
    label: "worker",
  });
  acp.emit(sessionId, "error", errorData);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("OrchestratorTaskService — un-respawnable session crash terminates the task", () => {
  it("drives the task to terminal `failed` on the FIRST generic (non-account, non-state-lost) crash", async () => {
    const { service, acp, taskId } = await makeService();

    // A plain process crash: no auth/429 signal, no session_state_lost. The
    // router respawns NEITHER of those categories — it re-drives only account
    // failures and session_state_lost — so nothing will ever re-spawn this
    // lineage. The task must not be parked non-terminal waiting for a respawn
    // that will never come.
    await crash(service, acp, taskId, "sess-crash-1", {
      message: "sub-agent process exited with code 1",
    });

    const detail = await service.getTask(taskId);
    expect(detail?.status).toBe("failed");
  });

  it("terminates a mid-build-verify-retry crash (buildVerifyRetryCount in (0,max)) rather than wedging it", async () => {
    // The precise P0 shape called out in #13771: a session already partway
    // through the build-verify retry lineage crashes generically. There is no
    // remaining respawn producer, so it must go terminal, not sit non-terminal.
    const { service, acp, taskId } = await makeService();

    await service.attachSession(taskId, {
      sessionId: "sess-midretry",
      agentType: "codex",
      workdir: "/tmp/workdir",
      status: "ready",
      label: "worker",
      metadata: { buildVerifyRetryCount: 1 },
    });
    acp.emit("sess-midretry", "error", {
      message: "build verify step crashed: exit 137",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const detail = await service.getTask(taskId);
    expect(detail?.status).toBe("failed");
  });

  it("never leaves the task non-terminal after a generic crash, whatever the budget", async () => {
    // Even if a generic crash were treated as retryable, a lineage of crashes
    // must eventually terminate. Emitting MAX crashes (each a fresh session)
    // must land `failed` — the task can never hang in `active`/`retrying`.
    const { service, acp, taskId } = await makeService();
    for (let i = 0; i < MAX_SESSION_RETRY_ATTEMPTS; i++) {
      await crash(service, acp, taskId, `sess-loop-${i}`, {
        message: `worker crashed (attempt ${i}): exit 1`,
      });
    }
    const detail = await service.getTask(taskId);
    expect(detail?.status).toBe("failed");
  });

  it("keeps a session_state_lost crash NON-terminal (the router deterministically respawns it)", async () => {
    // The one legitimately-retryable crash: the router's respawnStateLost
    // re-drives it under a bounded cap, so the durable task must stay
    // non-terminal for that recovery to land. This guards against the fix
    // over-correcting and failing a genuinely-recoverable lineage.
    const { service, acp, taskId } = await makeService();

    await crash(service, acp, taskId, "sess-statelost", {
      failureKind: "session_state_lost",
      message: "ACP session state lost; connection dropped",
    });

    const detail = await service.getTask(taskId);
    expect(detail?.status).not.toBe("failed");
    expect(detail?.status).toBe("active");
  });

  it("keeps a pooled-account rate-limit crash NON-terminal while a healthy sibling remains (router fails the account over)", async () => {
    // A pooled-account rate-limit is respawned by the router's in-router
    // account failover while a healthy sibling remains, so — like state-lost —
    // the task must stay non-terminal for that respawn. Requires a real pooled
    // account on the session AND a healthy sibling in the bridge, matching the
    // router's exact failover gate.
    installBridge(1);
    const { service, acp, taskId } = await makeService();
    await service.attachSession(taskId, {
      sessionId: "sess-ratelimit",
      agentType: "claude",
      workdir: "/tmp/workdir",
      status: "ready",
      label: "worker",
      metadata: {
        account: {
          providerId: "anthropic-subscription",
          accountId: "acct-limited",
          label: "Work",
        },
      },
    });
    acp.emit("sess-ratelimit", "error", { message: "429 rate limit exceeded" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const detail = await service.getTask(taskId);
    expect(detail?.status).not.toBe("failed");
    expect(detail?.status).toBe("active");
  });

  it("TERMINATES a pooled-account rate-limit crash when the pool is exhausted (no sibling to fail over to)", async () => {
    // The pool has 0 healthy accounts, so the router posts the honest failure
    // and does NOT respawn — the crash is un-respawnable and the task must
    // terminate rather than wait for a failover that cannot happen.
    installBridge(0);
    const { service, acp, taskId } = await makeService();
    await service.attachSession(taskId, {
      sessionId: "sess-ratelimit-exhausted",
      agentType: "claude",
      workdir: "/tmp/workdir",
      status: "ready",
      label: "worker",
      metadata: {
        account: {
          providerId: "anthropic-subscription",
          accountId: "acct-limited",
          label: "Work",
        },
      },
    });
    acp.emit("sess-ratelimit-exhausted", "error", {
      message: "429 rate limit exceeded",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const detail = await service.getTask(taskId);
    expect(detail?.status).toBe("failed");
  });
});
