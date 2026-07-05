/**
 * Real-engine concurrency e2e for the admission substrate (#13778, epic #13766
 * WS8): drives 10 tasks against `ELIZA_ACP_MAX_SESSIONS=5` through the ACTUAL
 * `AcpService` admission + session-accounting code paths — `spawnSession` →
 * `reserveSessionSlot` (the check-and-reserve mutex) → `enforceSessionLimit` /
 * `countActiveSlots` → typed `SessionCapError`, plus `getCapacity()` and
 * `stopSession()` slot-reclaim. No live model and no real subprocess: the native
 * ACP transport and `node:child_process` are stubbed so each spawn resolves to a
 * real "ready" session deterministically, letting the harness assert the
 * structural throughput/back-pressure contract (WS2 admission model, #13816)
 * under genuine concurrent load.
 *
 * What this covers that the acp-service unit suite does not: the drain lane —
 * excess tasks are typed-rejected while the pool is saturated, parked, then
 * re-admitted as real slots free, until ALL ten complete, with a live invariant
 * that worker accounting never over-subscribes past the cap at any observation.
 *
 * Deferred to follow-ups (noted in the PR, not half-done here): scenario-runner
 * multi-task turn kind + runId/scenarioId per-task correlation (WS8 item 2),
 * orchestrator_lifecycle structural scoring (item 3), and the scheduled CI lane
 * (item 4) — those depend on live-model harness wiring beyond this package.
 */
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type AcpJsonRpcMessage,
  type ApprovalPreset,
  SessionCapError,
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
type NativeMockState = { instances: MockNativeClient[] };

function getNativeMockState(): NativeMockState {
  const g = globalThis as typeof globalThis & {
    __acpConcurrencyNativeMock?: NativeMockState;
  };
  g.__acpConcurrencyNativeMock ??= { instances: [] };
  return g.__acpConcurrencyNativeMock;
}

// The native transport is the fake subprocess: constructing a client and driving
// its lifecycle methods resolves synchronously, so `spawnSession` returns a real
// "ready" session without a live agent. The admission code the session flows
// through afterwards is entirely real.
vi.mock("../../src/services/acp-native-transport.js", () => {
  const state = getNativeMockState();
  const NativeAcpClient = class MockNativeAcpClient
    implements MockNativeClient
  {
    opts: NativeOptions;
    eventHandler?: NativeEventHandler;
    start = vi.fn(async () => undefined);
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
      state.instances.push(this);
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
  return { NativeAcpClient };
});

// git is unavailable in the harness, so baseline/diff capture degrades to
// undefined instead of hanging on an un-invoked promisified callback.
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
      if (typeof callback === "function") {
        callback(new Error("git unavailable in test"), "", "");
      }
    },
  ),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
  spawn: vi.fn(() => {
    const p = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      stdin: Writable;
      kill: () => boolean;
    };
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.stdin = new Writable({ write: (_c, _e, cb) => cb() });
    p.kill = () => true;
    return p;
  }),
}));

import { AcpService } from "../../src/services/acp-service.js";

function runtime(settings: Record<string, string | undefined> = {}) {
  // ELIZA_ACP_TRANSPORT undefined selects the native transport (the fake client
  // mocked above), so spawns resolve to "ready" without the CLI proc-mock dance.
  const values: Record<string, string | undefined> = { ...settings };
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getSetting: vi.fn((key: string) => values[key]),
    services: new Map<string, unknown[]>(),
  } as never;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

afterEach(() => {
  getNativeMockState().instances.length = 0;
  vi.useRealTimers();
});

const CAP = 5;
const TOTAL = 10;

describe("orchestrator concurrency e2e — 10 tasks vs maxSessions=5", () => {
  it("saturates at exactly the cap and typed-rejects the excess with a correct capacity readout", async () => {
    const service = new AcpService(
      runtime({ ELIZA_ACP_MAX_SESSIONS: String(CAP) }),
    );
    await service.start();

    // Fire all ten in the same tick and hold every admitted session open (no
    // stop), so the check-and-reserve mutex must let exactly CAP through and
    // reject the rest — the pure back-pressure snapshot, timing-independent.
    const results = await Promise.allSettled(
      Array.from({ length: TOTAL }, (_, i) =>
        service.spawnSession({
          name: `sat-${i}`,
          workdir: "/tmp/acp-conc-sat",
          slotClass: "worker",
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(CAP);
    expect(rejected).toHaveLength(TOTAL - CAP);
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason as SessionCapError;
      expect(reason).toBeInstanceOf(SessionCapError);
      expect(reason.code).toBe("SESSION_CAP_REACHED");
      expect(reason.slotClass).toBe("worker");
      expect(reason.maxSessions).toBe(CAP);
    }

    // The authoritative capacity readout agrees: fully saturated, none free,
    // never over-subscribed past the cap.
    const cap = await service.getCapacity();
    expect(cap).toMatchObject({
      maxSessions: CAP,
      activeWorkers: CAP,
      freeWorkerSlots: 0,
    });
    const active = (await service.listSessions()).filter(
      (s) =>
        !["stopped", "errored", "completed", "cancelled"].includes(s.status),
    );
    expect(active).toHaveLength(CAP);

    await service.stop();
  });

  it("drains all 10 tasks to completion under back-pressure without ever over-subscribing", async () => {
    const service = new AcpService(
      runtime({ ELIZA_ACP_MAX_SESSIONS: String(CAP) }),
    );
    await service.start();

    // Park-and-retry back-pressure driver: on a typed cap rejection a task waits
    // for the NEXT real terminal ("stopped") event — a genuine slot free — then
    // re-attempts admission through the same real gate. A short race timeout is a
    // pure progress guarantee (a missed edge can never wedge the drain); it never
    // fabricates capacity. This is the WS2 admission model exercising the real
    // accounting, not a private mirror counter.
    let wakeOnFree: () => void = () => undefined;
    let slotFreed = new Promise<void>((r) => {
      wakeOnFree = r;
    });
    const unsubscribe = service.onSessionEvent((_sid, event) => {
      if (event === "stopped") {
        wakeOnFree();
        slotFreed = new Promise<void>((r) => {
          wakeOnFree = r;
        });
      }
    });

    let inFlight = 0;
    let maxInFlight = 0;
    let maxActiveWorkers = 0;
    let capRejections = 0;
    const completed: number[] = [];

    async function runTask(i: number): Promise<void> {
      for (;;) {
        const parkedOn = slotFreed;
        let spawned: Awaited<ReturnType<AcpService["spawnSession"]>>;
        try {
          spawned = await service.spawnSession({
            name: `task-${i}`,
            workdir: "/tmp/acp-conc-drain",
            slotClass: "worker",
          });
        } catch (err) {
          if (err instanceof SessionCapError) {
            expect(err.slotClass).toBe("worker");
            expect(err.maxSessions).toBe(CAP);
            capRejections += 1;
            await Promise.race([parkedOn, delay(5)]);
            continue;
          }
          throw err;
        }

        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Invariant checked against the REAL store-derived count on every
        // admission: worker accounting must never exceed the cap.
        const cap = await service.getCapacity();
        maxActiveWorkers = Math.max(maxActiveWorkers, cap.activeWorkers);
        expect(cap.activeWorkers).toBeLessThanOrEqual(CAP);
        expect(inFlight).toBeLessThanOrEqual(CAP);

        // Hold the slot across a macrotask so tasks fired after this one contend
        // for a full pool (forcing real back-pressure), then release it.
        await delay(15);
        inFlight -= 1;
        await service.stopSession(spawned.sessionId);
        completed.push(i);
        return;
      }
    }

    const drove = Promise.all(
      Array.from({ length: TOTAL }, (_, i) => runTask(i)),
    );
    await Promise.race([
      drove,
      delay(10_000).then(() => {
        throw new Error(
          `drain deadlocked: only ${completed.length}/${TOTAL} tasks completed`,
        );
      }),
    ]);
    unsubscribe();

    // Every task ran through to a real terminal state.
    expect(completed).toHaveLength(TOTAL);
    expect(new Set(completed).size).toBe(TOTAL);
    // Back-pressure actually engaged — the excess was typed-rejected, not queued
    // silently or dropped.
    expect(capRejections).toBeGreaterThan(0);
    // The pool saturated to exactly the cap and never past it.
    expect(maxActiveWorkers).toBe(CAP);
    expect(maxInFlight).toBe(CAP);

    // The engine drained clean: no leaked active sessions, capacity fully free.
    const finalCap = await service.getCapacity();
    expect(finalCap.activeWorkers).toBe(0);
    expect(finalCap.freeWorkerSlots).toBe(CAP);
    const stillActive = (await service.listSessions()).filter(
      (s) =>
        !["stopped", "errored", "completed", "cancelled"].includes(s.status),
    );
    expect(stillActive).toHaveLength(0);

    await service.stop();
  });

  it("keeps the system verifier headroom uncontended while the worker pool drains 10 tasks", async () => {
    // The #8898 read-only verifier must never deadlock behind the very worker
    // pool it is trying to clear: at a full worker cap a `system` spawn draws on
    // reserved headroom instead. This asserts that guarantee holds under the same
    // 10-vs-5 load — a saturated worker pool leaves the system slot admittable.
    const service = new AcpService(
      runtime({
        ELIZA_ACP_MAX_SESSIONS: String(CAP),
        ELIZA_ACP_SYSTEM_SESSION_HEADROOM: "1",
      }),
    );
    await service.start();

    // Saturate the worker pool.
    const workers = await Promise.allSettled(
      Array.from({ length: TOTAL }, (_, i) =>
        service.spawnSession({
          name: `w-${i}`,
          workdir: "/tmp/acp-conc-headroom",
          slotClass: "worker",
        }),
      ),
    );
    expect(workers.filter((r) => r.status === "fulfilled")).toHaveLength(CAP);

    // A system spawn is still admitted despite the full worker pool.
    const verifier = await service.spawnSession({
      name: "verifier",
      slotClass: "system",
      workdir: "/tmp/acp-conc-headroom",
    });
    expect(verifier.sessionId).toBeTruthy();

    const cap = await service.getCapacity();
    expect(cap).toMatchObject({
      activeWorkers: CAP,
      activeSystem: 1,
      freeWorkerSlots: 0,
      freeSystemSlots: 0,
    });

    await service.stop();
  });
});
