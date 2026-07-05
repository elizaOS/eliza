/**
 * Real-engine admission-queue e2e (issue #13778 item 1).
 *
 * Drives N tasks through the REAL orchestrator admission queue and REAL
 * AcpService worker cap, not a fake ACP: `spawnAgentForTask` →
 * `runtime.getService(AcpService)` → `acp.spawnSession` → `reserveSessionSlot`.
 * Only the subprocess leaf (`NativeAcpClient`) is stubbed (native transport), so
 * every admitted spawn deterministically reaches "ready" without a live acp
 * binary while the queue logic runs 100% real.
 *
 * Asserts the WS2 admission-control decision: N > maxSessions spawns QUEUE
 * (they don't reject and no task is dropped), the cap is never overshot, and
 * freeing a slot admits the next queued spawn — until all N are admitted.
 *
 * Deliberately OUT OF SCOPE here (each has/needs its own suite, per #13778):
 *  - stall-watchdog firing on a wedged session (task-watchdog.test.ts),
 *  - the terminal `failed` producer (native mock resolves "ready"),
 *  - zero-leaked-workspace GC assertion (acp-scratch-gc.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  AcpJsonRpcMessage,
  ApprovalPreset,
} from "../../src/services/types.js";

type NativeEventHandler = (
  event: AcpJsonRpcMessage,
  sessionId?: string,
) => void;
type NativeOptions = {
  command: string;
  cwd: string;
  approvalPreset: ApprovalPreset;
  timeoutMs?: number;
  terminal?: boolean;
  env?: NodeJS.ProcessEnv;
  onEvent?: NativeEventHandler;
  onStderr?: (chunk: string) => void;
};
type MockNativeClient = {
  opts: NativeOptions;
  eventHandler?: NativeEventHandler;
  start: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  approvesPermissionRequest: ReturnType<typeof vi.fn>;
  setEventHandler: (handler: NativeEventHandler | undefined) => void;
  setTimeoutMs: (timeoutMs: number | undefined) => void;
  emit: (event: AcpJsonRpcMessage, sessionId?: string) => void;
};
type NativeMockState = {
  NativeAcpClient?: new (opts: NativeOptions) => MockNativeClient;
  instances: MockNativeClient[];
  startImplementation?: (client: MockNativeClient) => Promise<void>;
};

function getNativeMockState(): NativeMockState {
  const g = globalThis as typeof globalThis & {
    __acpAdmissionQueueNativeMock?: NativeMockState;
  };
  g.__acpAdmissionQueueNativeMock ??= { instances: [] };
  return g.__acpAdmissionQueueNativeMock;
}

// Stub only the subprocess leaf so each spawn deterministically reaches "ready".
vi.mock("../../src/services/acp-native-transport.js", () => {
  const state = getNativeMockState();
  state.NativeAcpClient = class MockNativeAcpClient
    implements MockNativeClient
  {
    opts: NativeOptions;
    eventHandler?: NativeEventHandler;
    start = vi.fn(async () => {
      await getNativeMockState().startImplementation?.(this);
    });
    createSession = vi.fn(async () => ({
      sessionId: "protocol-session",
      agentSessionId: "agent-session",
    }));
    prompt = vi.fn(async () => ({ stopReason: "end_turn" }));
    cancel = vi.fn(async () => undefined);
    closeSession = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    approvesPermissionRequest = vi.fn((_params: unknown) => true);
    constructor(opts: NativeOptions) {
      this.opts = opts;
      this.eventHandler = opts.onEvent;
      getNativeMockState().instances.push(this);
    }
    setEventHandler(handler: NativeEventHandler | undefined) {
      this.eventHandler = handler;
      this.opts.onEvent = handler;
    }
    setTimeoutMs(timeoutMs: number | undefined) {
      this.opts.timeoutMs = timeoutMs;
    }
    emit(event: AcpJsonRpcMessage, sessionId?: string) {
      this.eventHandler?.(event, sessionId);
    }
  };
  return { NativeAcpClient: state.NativeAcpClient };
});

// git is unavailable in the test; make workspace-diff's promisified execFile
// degrade instead of hanging every spawn.
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
  execFile: vi.fn(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb?: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const callback = typeof _opts === "function" ? _opts : cb;
      if (typeof callback === "function")
        callback(new Error("git unavailable in test"), "", "");
    },
  ),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
  spawn: vi.fn(),
}));

import { AcpService } from "../../src/services/acp-service.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";

// createTask auto-populates acceptance criteria for criteria-free goals; disable
// so tasks stay on the fast path and don't pull in the goal-contract machinery.
const PREV_GOAL_CONTRACT = process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
beforeAll(() => {
  process.env.ELIZA_REQUIRE_GOAL_CONTRACT = "0";
});
afterAll(() => {
  if (PREV_GOAL_CONTRACT === undefined)
    delete process.env.ELIZA_REQUIRE_GOAL_CONTRACT;
  else process.env.ELIZA_REQUIRE_GOAL_CONTRACT = PREV_GOAL_CONTRACT;
});

// Runtime for the AcpService itself (native transport, small cap, fast poll).
function acpRuntime(settings: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    ELIZA_ACP_TRANSPORT: undefined, // native
    ...settings,
  };
  return {
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: vi.fn((key: string) => values[key]),
    services: new Map<string, unknown[]>(),
  } as never;
}

// Runtime the orchestrator sees: getService returns the REAL AcpService so
// spawnAgentForTask drives the real admission queue.
function orchestratorRuntime(acp: AcpService) {
  return {
    getService: (type: string) =>
      type === AcpService.serviceType ? acp : null,
    getSetting: () => undefined,
    character: { name: "Test" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as never;
}

const isActive = (s: { status: string }) =>
  !["stopped", "errored", "completed", "cancelled"].includes(s.status);

async function poll(
  cond: () => Promise<boolean> | boolean,
  ms = 4000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("poll timed out waiting for admission-queue condition");
}

describe("orchestrator admission queue — N tasks vs maxSessions (#13778)", () => {
  it("queues tasks beyond the session cap through the real orchestrator and admits them as slots free", async () => {
    const CAP = 5;
    const N = 10;

    const acp = new AcpService(
      acpRuntime({
        ELIZA_ACP_MAX_SESSIONS: String(CAP),
        ELIZA_ACP_ADMISSION_POLL_MS: "5",
      }),
    );
    await acp.start();

    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = new OrchestratorTaskService(orchestratorRuntime(acp), {
      store,
    });
    await service.start();

    const activeSessions = async () =>
      (await acp.listSessions()).filter(isActive);

    // Create N distinct tasks (distinct avoids sibling-name-pool contention).
    const tasks = [];
    for (let i = 0; i < N; i++) {
      tasks.push(
        await service.createTask({
          title: `t-${i}`,
          goal: "Implement and verify",
        }),
      );
    }

    // Fire all N spawns concurrently through the real orchestrator. The first
    // CAP admit; the rest return queued task DTOs (not rejects, not drops).
    const details = await Promise.all(
      tasks.map((t) => service.spawnAgentForTask(t.id)),
    );
    expect(details.filter((detail) => detail?.admission).length).toBe(N - CAP);
    expect(details.filter((detail) => detail && !detail.admission).length).toBe(
      CAP,
    );

    await poll(async () => (await activeSessions()).length === CAP);
    expect((await activeSessions()).length).toBe(CAP);
    expect(await service.getAdmissionSnapshot()).toMatchObject({
      queueDepth: N - CAP,
    });

    // Free slots one at a time; each freed slot admits exactly one queued spawn
    // and the cap is never overshot.
    for (let expectedQueued = N - CAP; expectedQueued > 0; expectedQueued--) {
      const active = await activeSessions();
      expect(active.length).toBeLessThanOrEqual(CAP);
      await acp.stopSession(active[0].id);
      await poll(
        async () =>
          (await service.getAdmissionSnapshot()).queueDepth ===
          expectedQueued - 1,
      );
      expect((await activeSessions()).length).toBeLessThanOrEqual(CAP);
    }

    // All N tasks eventually admitted exactly one session — nothing dropped,
    // nothing rejected, and the worker cap was never overshot.
    expect(await service.getAdmissionSnapshot()).toMatchObject({
      queueDepth: 0,
    });
    expect(await acp.listSessions()).toHaveLength(N);

    await service.stop();
    await acp.stop();
  });
});
