// Concurrency-stress coverage for AcpService (Wave 3.3 / Domain L).
//
// GAP CLOSED: the existing acp-service.test.ts:1528 proves the
// ELIZA_ACP_MAX_SESSIONS cap holds for 6 concurrent spawns with MAX=2 — count
// + error substring only. It does NOT exercise the >=10-simultaneous-session
// stress path, per-session workdir isolation, native-client cwd isolation,
// acpxSessionId non-leakage, per-session event routing, or terminal-state
// convergence after close. This file is that superset: it fires 10–12
// concurrent native spawns and asserts that nothing leaks across sessions and
// that the promise-chain reserve mutex (reserveSessionSlot, acp-service.ts
// ~L2000) never overshoots the cap under contention. A real regression — a
// shared/last-write-wins cwd in spawnNativeSession, a non-atomic check-then-
// reserve race, a constant acpxSessionId, or a mis-keyed event — would be
// caught here while the legacy single-assertion test would still pass.
//
// Deterministic: the native transport is mocked (no subprocess, no network, no
// timers). Each spawn resolves to "ready" via real microtasks (mkdir +
// writeWorkspaceIdentity + InMemorySessionStore WriteQueue), so NO fake timers
// are used — fake timers would stall mkdtemp/mkdir/WriteQueue.

import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AcpJsonRpcMessage,
  ApprovalPreset,
} from "../../src/services/types.js";
import { TERMINAL_SESSION_STATUSES } from "../../src/services/types.js";

// ---------------------------------------------------------------------------
// Native transport mock — mirrors acp-service.test.ts lines 49-96 VERBATIM,
// with ONE required deviation: createSession returns a UNIQUE sessionId per
// call (counter + cwd-derived) so each session records a DISTINCT
// acpxSessionId in the store. The reference mock's constant "protocol-session"
// would make the no-leakage assertion vacuous.
// ---------------------------------------------------------------------------

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
  setEventHandler: (handler: NativeEventHandler | undefined) => void;
  setTimeoutMs: (timeoutMs: number | undefined) => void;
  emit: (event: AcpJsonRpcMessage, sessionId?: string) => void;
};
type NativeMockState = {
  NativeAcpClient?: new (opts: NativeOptions) => MockNativeClient;
  instances: MockNativeClient[];
  seq: number;
};

function getNativeMockState(): NativeMockState {
  const globalWithMock = globalThis as typeof globalThis & {
    __acpStressNativeMock?: NativeMockState;
  };
  globalWithMock.__acpStressNativeMock ??= { instances: [], seq: 0 };
  return globalWithMock.__acpStressNativeMock;
}

const nativeClientMock = getNativeMockState();

vi.mock("../../src/services/acp-native-transport.js", () => {
  const state = getNativeMockState();
  state.NativeAcpClient = class MockNativeAcpClient
    implements MockNativeClient
  {
    opts: NativeOptions;
    eventHandler?: NativeEventHandler;
    start = vi.fn(async () => undefined);
    // UNIQUE per instance + keyed off cwd so a workdir/session mismatch (a
    // last-write-wins cwd leak in spawnNativeSession) becomes detectable.
    createSession = vi.fn(async (cwd: string) => {
      const n = ++getNativeMockState().seq;
      return {
        sessionId: `proto-${n}-${cwd}`,
        agentSessionId: `agent-${n}`,
      };
    });
    prompt = vi.fn(async () => ({ stopReason: "end_turn" }));
    cancel = vi.fn(async () => undefined);
    closeSession = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);

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

// Imported AFTER the vi.mock so AcpService binds to the mocked transport.
import { AcpService } from "../../src/services/acp-service.js";

// workspace-diff promisifies execFile (baseline SHA/dirty capture). The
// promisified form hangs unless the callback fires, which would stall every
// spawn; make git look unavailable so capture degrades to undefined.
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
  spawn: vi.fn(),
}));

// Runtime helper: same shape as the reference test, but transport defaults to
// NATIVE (undefined → AcpService picks "native"). The reference helper forces
// ELIZA_ACP_TRANSPORT:"cli"; we must NOT, since the stress path is native.
function runtime(settings: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    ELIZA_ACP_TRANSPORT: undefined,
    ...settings,
  };
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

// `setting()` falls back to process.env, so a leaked env var would override the
// runtime helper and silently flip the transport/cap. Scrub the relevant keys.
const SCRUBBED_ENV_KEYS = [
  "ELIZA_ACP_TRANSPORT",
  "ACPX_TRANSPORT",
  "ELIZA_ACP_MAX_SESSIONS",
  "ELIZA_ACP_WORKSPACE_ROOT",
  "ACPX_DEFAULT_CWD",
  "ELIZA_ACP_CLI",
  "ELIZA_PLATFORM",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of SCRUBBED_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  nativeClientMock.instances.length = 0;
  nativeClientMock.seq = 0;
});

const createdDirs: string[] = [];
let activeService: AcpService | undefined;

afterEach(async () => {
  vi.useRealTimers();
  if (activeService) {
    await activeService.stop().catch(() => undefined);
    activeService = undefined;
  }
  await Promise.all(
    createdDirs
      .splice(0)
      .map((dir) =>
        rm(dir, { recursive: true, force: true }).catch(() => undefined),
      ),
  );
  for (const key of SCRUBBED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

async function makeWorkdirs(n: number): Promise<string[]> {
  const dirs = await Promise.all(
    Array.from({ length: n }, () => mkdtemp(join(tmpdir(), "acp-stress-"))),
  );
  createdDirs.push(...dirs);
  return dirs;
}

function isTerminal(status: string): boolean {
  return TERMINAL_SESSION_STATUSES.has(status);
}

describe("AcpService — concurrent-spawn stress (Domain L)", () => {
  it("holds ELIZA_ACP_MAX_SESSIONS exactly under >=10 concurrent spawns", async () => {
    // 12 concurrent spawns, cap 4: the promise-chain reserve mutex must
    // serialize check-and-reserve so the race cannot overshoot the cap.
    activeService = new AcpService(runtime({ ELIZA_ACP_MAX_SESSIONS: "4" }));
    await activeService.start();

    const dirs = await makeWorkdirs(12);
    const results = await Promise.allSettled(
      dirs.map((wd, i) =>
        (activeService as AcpService).spawnSession({
          name: `cap-${i}`,
          agentType: "codex",
          workdir: wd,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(4);
    expect(rejected).toHaveLength(8);
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(Error);
      // The cap value is interpolated into the message: "...reached (4)".
      expect((reason as Error).message).toMatch(/max session limit reached/);
      expect((reason as Error).message).toContain("(4)");
    }

    // STORE AGREES WITH CAP: never more than maxSessions active rows.
    const sessions = await (activeService as AcpService).listSessions();
    const active = sessions.filter((s) => !isTerminal(s.status));
    expect(active).toHaveLength(4);
  });

  it("spawns 10 isolated sessions concurrently with no cross-session leakage", async () => {
    const N = 10;
    activeService = new AcpService(runtime({ ELIZA_ACP_MAX_SESSIONS: "16" }));
    await activeService.start();

    // Register the event sink BEFORE spawning so every "ready" is observed.
    const eventsBySession = new Map<string, string[]>();
    activeService.onSessionEvent((sid, event) => {
      const list = eventsBySession.get(sid) ?? [];
      list.push(event);
      eventsBySession.set(sid, list);
    });

    const dirs = await makeWorkdirs(N);
    const results = await Promise.allSettled(
      dirs.map((wd, i) =>
        (activeService as AcpService).spawnSession({
          name: `proj-${i}`,
          agentType: "codex",
          workdir: wd,
        }),
      ),
    );

    // HIGH-CONCURRENCY SUCCESS: all 10 fulfill as "ready".
    const fulfilled = results.filter(
      (
        r,
      ): r is PromiseFulfilledResult<
        Awaited<ReturnType<AcpService["spawnSession"]>>
      > => r.status === "fulfilled",
    );
    expect(fulfilled).toHaveLength(N);
    for (const r of fulfilled) {
      expect(r.value.status).toBe("ready");
    }

    const resolvedInputs = dirs.map((d) => path.resolve(d));
    const localIds = fulfilled.map((r) => r.value.id);

    // DISTINCT WORKDIRS, NO COLLISION: each spawn result keeps its own
    // path.resolve(input) workdir; pairwise distinct.
    const resultWorkdirs = fulfilled.map((r) => r.value.workdir);
    expect(new Set(resultWorkdirs).size).toBe(N);
    expect(new Set(resultWorkdirs)).toEqual(new Set(resolvedInputs));

    // NATIVE CLIENT CWD ISOLATION: one client per session, each constructed
    // with its OWN resolved cwd (no shared/last-write-wins cwd).
    expect(nativeClientMock.instances).toHaveLength(N);
    const clientCwds = nativeClientMock.instances.map((c) => c.opts.cwd);
    expect(new Set(clientCwds).size).toBe(N);
    expect(new Set(clientCwds)).toEqual(new Set(resolvedInputs));

    // NO ACPX-SESSION-ID LEAKAGE: every persisted acpxSessionId is distinct,
    // and the per-cwd-derived id proves the session whose workdir is W carries
    // the acpxSessionId minted from W (no event/store cross-wiring).
    const sessions = await activeService.listSessions();
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const acpxIds = sessions.map((s) => s.acpxSessionId);
    expect(acpxIds.every((v) => typeof v === "string" && v.length > 0)).toBe(
      true,
    );
    expect(new Set(acpxIds).size).toBe(N);
    for (const s of sessions) {
      // createSession returned `proto-<n>-<cwd>`; the cwd suffix must match the
      // session's own workdir — a mismatch means a concurrent spawn's id was
      // written onto the wrong session row.
      expect(s.acpxSessionId).toContain(s.workdir);
    }

    // PER-SESSION EVENT ROUTING: every emitted event is keyed by one of the 10
    // known local session ids, and each of the 10 saw a "ready".
    const knownIds = new Set(localIds);
    for (const sid of eventsBySession.keys()) {
      expect(knownIds.has(sid)).toBe(true);
    }
    for (const sid of localIds) {
      expect(eventsBySession.get(sid)).toContain("ready");
      // The session whose local id is sid must own a store row.
      expect(byId.has(sid)).toBe(true);
    }
  });

  it("converges every session to a terminal status after closeSession", async () => {
    const N = 10;
    activeService = new AcpService(runtime({ ELIZA_ACP_MAX_SESSIONS: "16" }));
    await activeService.start();

    const dirs = await makeWorkdirs(N);
    const results = await Promise.allSettled(
      dirs.map((wd, i) =>
        (activeService as AcpService).spawnSession({
          name: `term-${i}`,
          agentType: "codex",
          workdir: wd,
        }),
      ),
    );
    const ids = results
      .filter(
        (
          r,
        ): r is PromiseFulfilledResult<
          Awaited<ReturnType<AcpService["spawnSession"]>>
        > => r.status === "fulfilled",
      )
      .map((r) => r.value.sessionId);
    expect(ids).toHaveLength(N);

    // Before close, none are terminal.
    const before = await activeService.listSessions();
    expect(before.filter((s) => !isTerminal(s.status))).toHaveLength(N);

    // Close all concurrently → native close path sets status "stopped".
    await Promise.all(
      ids.map((id) => (activeService as AcpService).closeSession(id)),
    );

    const after = await activeService.listSessions();
    expect(after).toHaveLength(N);
    for (const s of after) {
      expect(isTerminal(s.status)).toBe(true);
      expect(s.status).toBe("stopped");
    }
    // No session lingers active.
    expect(after.filter((s) => !isTerminal(s.status))).toHaveLength(0);
  });

  it("writes an independent on-disk identity scaffold into each workdir", async () => {
    // Real-FS isolation: writeWorkspaceIdentity scaffolds AGENTS.md + CLAUDE.md
    // into each bare temp workdir; distinct dirs => independent files, proving
    // the per-workdir scaffold ran once per session without cross clobber.
    const N = 10;
    activeService = new AcpService(runtime({ ELIZA_ACP_MAX_SESSIONS: "16" }));
    await activeService.start();

    const dirs = await makeWorkdirs(N);
    await Promise.all(
      dirs.map((wd, i) =>
        (activeService as AcpService).spawnSession({
          name: `id-${i}`,
          agentType: "codex",
          workdir: wd,
        }),
      ),
    );

    for (const dir of dirs) {
      const agents = join(path.resolve(dir), "AGENTS.md");
      const claude = join(path.resolve(dir), "CLAUDE.md");
      await expect(access(agents)).resolves.toBeUndefined();
      await expect(access(claude)).resolves.toBeUndefined();
      const agentsBody = await readFile(agents, "utf8");
      // The scaffold is the operating manual, not an empty placeholder.
      expect(agentsBody).toContain("Eliza coding sub-agent");
    }
  });
});
