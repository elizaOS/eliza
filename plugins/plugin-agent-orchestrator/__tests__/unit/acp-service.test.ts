/**
 * Verifies AcpService.
 * Drives a real ACP subprocess; deterministic harness (no live model).
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  promises as fs,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import path, { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The ACP implementation runs every workdir through `path.resolve`, which on
// Windows turns `/tmp/acp-test` into `C:\tmp\acp-test`. Tests pass the
// POSIX-style string in and compare the spawn cwd against the resolved
// form so the same source compares correctly on both POSIX and Windows.
const RESOLVED_ACP_WORKDIR = path.resolve("/tmp/acp-test");

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
type NativeMockState = {
  NativeAcpClient?: new (opts: NativeOptions) => MockNativeClient;
  instances: MockNativeClient[];
  startImplementation?: (client: MockNativeClient) => Promise<void>;
};

function getNativeMockState(): NativeMockState {
  const globalWithMock = globalThis as typeof globalThis & {
    __acpServiceNativeMock?: NativeMockState;
  };
  globalWithMock.__acpServiceNativeMock ??= { instances: [] };
  return globalWithMock.__acpServiceNativeMock;
}

const nativeClientMock = getNativeMockState();

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
    // Mirrors the real transport's auto-approve decision. Defaults to true to
    // match the default `autonomous` preset (every op approved); individual
    // tests override it to exercise the restrictive / cancel paths.
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

import { AcpService } from "../../src/services/acp-service.js";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
  // execFile is promisified by workspace-diff (baseline/diff capture). The
  // promisified form hangs unless the callback is invoked, which would stall
  // every spawn test; make the mock behave like an unavailable git so capture
  // degrades to undefined.
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

type MockProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: Writable;
  stdinWrites: string[];
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

const spawnMock = spawn as unknown as ReturnType<typeof vi.fn>;

const GIT_IDENTITY_ENV_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "ELIZA_CODING_GIT_AUTHOR_NAME",
  "ELIZA_CODING_GIT_AUTHOR_EMAIL",
  "ELIZA_CODING_GIT_COMMITTER_NAME",
  "ELIZA_CODING_GIT_COMMITTER_EMAIL",
  "ELIZA_CONFIG_PATH",
] as const;

function snapshotEnv(
  keys: readonly string[],
): Record<string, string | undefined> {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function runtime(
  settings: Record<string, string | undefined> = {},
  services: Record<string, unknown> = {},
) {
  // Unit tests mock child_process.spawnSync as a failed process. Pin the
  // elizaos adapter command so unrelated AcpService tests never accidentally
  // exercise first-use provisioning through that mock; the real provisioning
  // path has its own focused eliza-code-acp-install.test.ts coverage.
  const values = {
    ELIZA_ACP_TRANSPORT: "cli",
    ELIZA_ELIZAOS_ACP_COMMAND: "eliza-code-acp",
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
    // spawnSession consults getService for the broker-router (isParentAgentBroker
    // Wired) and the skills service (SKILLS.md manifest); default to none.
    getService: vi.fn((name: string) => services[name] ?? null),
    services: new Map<string, unknown[]>(),
  } as never;
}

function proc(): MockProc {
  const p = new EventEmitter() as MockProc;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.stdinWrites = [];
  p.stdin = new Writable({
    write(chunk, _enc, cb) {
      p.stdinWrites.push(chunk.toString());
      cb();
    },
  });
  p.killed = false;
  p.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === "SIGKILL") p.killed = true;
    return true;
  });
  return p;
}

// Each spawn registration includes a deferred that resolves when spawn() is
// actually invoked. Tests await the deferred before emitting stdout/close —
// guarantees stream listeners have already been attached.
interface ProcRegistration {
  proc: MockProc;
  spawned: Promise<void>;
}

function nextProc(): ProcRegistration {
  const p = proc();
  let resolveSpawned: () => void = () => undefined;
  const spawned = new Promise<void>((resolve) => {
    resolveSpawned = resolve;
  });
  spawnMock.mockImplementationOnce(((..._args: unknown[]) => {
    // resolve on next microtask so the synchronous listener-attach inside
    // runAcpx (proc.stdout.on("data", ...), proc.on("close", ...)) completes
    // before the test fires emits.
    queueMicrotask(resolveSpawned);
    return p;
  }) as never);
  return { proc: p, spawned };
}

async function waitForSpawn(
  reg: ProcRegistration,
  timeoutMs = 4000,
): Promise<void> {
  await Promise.race([
    reg.spawned,
    new Promise<void>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              `waitForSpawn: spawn never invoked within ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      ).unref?.();
    }),
  ]);
  // give listener-attach a microtask
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function closeOk(reg: ProcRegistration | MockProc) {
  const p =
    "proc" in (reg as ProcRegistration)
      ? (reg as ProcRegistration).proc
      : (reg as MockProc);
  // close on next tick so any sync-emitted data above is flushed first
  setImmediate(() => p.emit("close", 0, null));
}

async function waitForSessionStatus(
  service: AcpService,
  sessionId: string,
  status: string,
  timeoutMs = 4000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const session = await service.getSession(sessionId);
    if (session?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const session = await service.getSession(sessionId);
  throw new Error(
    `expected session ${sessionId} to reach ${status}, got ${session?.status}`,
  );
}

beforeEach(() => {
  spawnMock.mockReset();
  nativeClientMock.instances.length = 0;
  nativeClientMock.startImplementation = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

function firstNativeClient(): MockNativeClient {
  const client = nativeClientMock.instances[0];
  if (!client) throw new Error("expected NativeAcpClient to be constructed");
  return client;
}

describe("AcpService", () => {
  it("fails with a clear diagnostic when acpx is missing on Android", async () => {
    const previousPlatform = process.env.ELIZA_PLATFORM;
    process.env.ELIZA_PLATFORM = "android";
    try {
      const service = new AcpService(runtime({ ELIZA_ACP_CLI: "/no/acpx" }));
      const events: Array<[string, string, unknown]> = [];
      service.onSessionEvent((sid, event, data) =>
        events.push([sid, event, data]),
      );
      await service.start();

      await expect(
        service.spawnSession({
          name: "missing-acpx",
          agentType: "codex",
          workdir: "/tmp/acp-test",
        }),
      ).rejects.toThrow(/acpx CLI is not available/);

      expect(spawnMock).not.toHaveBeenCalled();
      expect(events.some(([, event]) => event === "error")).toBe(true);
      await service.stop();
    } finally {
      if (previousPlatform === undefined) delete process.env.ELIZA_PLATFORM;
      else process.env.ELIZA_PLATFORM = previousPlatform;
    }
  });

  it("static start wires the runtime-backed durable session store", async () => {
    const rt = runtime() as {
      databaseAdapter: { query: ReturnType<typeof vi.fn> };
    };
    rt.databaseAdapter = { query: vi.fn() };

    const service = await AcpService.start(rt as never);

    const store = Reflect.get(service, "store") as { backend: string };
    expect(store.backend).toBe("runtime-db");
    await service.stop();
  });

  it("spawns a session, emits ready, and stores the session", async () => {
    const reg = nextProc();
    const service = new AcpService(runtime());
    const events: Array<[string, string, unknown]> = [];
    service.onSessionEvent((sid, event, data) =>
      events.push([sid, event, data]),
    );
    await service.start();

    const promise = service.spawnSession({
      name: "s1",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(reg);
    reg.proc.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"session_started","params":{"sessionId":"s1"}}\n',
      ),
    );
    closeOk(reg);
    const result = await promise;

    expect(result.name).toBe("s1");
    expect(result.status).toBe("ready");
    expect(await service.listSessions()).toHaveLength(1);
    expect(events.some(([, event]) => event === "ready")).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      "acpx",
      expect.arrayContaining([
        "--format",
        "json",
        "codex",
        "sessions",
        "new",
        "--name",
        "s1",
      ]),
      expect.objectContaining({ cwd: RESOLVED_ACP_WORKDIR }),
    );
    const args = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(args).not.toContain("--no-terminal");
    const env = spawnMock.mock.calls[0]?.[2]?.env as
      | Record<string, string>
      | undefined;
    expect(env?.PARALLAX_SESSION_ID).toBe(result.sessionId);
  });

  it("pins configured coding git identity over inherited GIT env on CLI spawns", async () => {
    const previousEnv = snapshotEnv(GIT_IDENTITY_ENV_KEYS);
    process.env.GIT_AUTHOR_NAME = "Hostile Author";
    process.env.GIT_AUTHOR_EMAIL = "hostile-author@example.invalid";
    process.env.GIT_COMMITTER_NAME = "Hostile Committer";
    process.env.GIT_COMMITTER_EMAIL = "hostile-committer@example.invalid";
    process.env.ELIZA_CODING_GIT_AUTHOR_NAME = "Configured Author";
    process.env.ELIZA_CODING_GIT_AUTHOR_EMAIL = "author@example.test";
    process.env.ELIZA_CODING_GIT_COMMITTER_NAME = "Configured Committer";
    process.env.ELIZA_CODING_GIT_COMMITTER_EMAIL = "committer@example.test";
    process.env.ELIZA_CONFIG_PATH = join(
      tmpdir(),
      "acp-git-identity-config-does-not-exist.json",
    );
    try {
      const reg = nextProc();
      const service = new AcpService(runtime({ ELIZA_ACP_TRANSPORT: "cli" }));
      await service.start();

      const spawned = service.spawnSession({
        name: "configured-git-identity-cli",
        agentType: "codex",
        workdir: "/tmp/acp-test",
      });
      await waitForSpawn(reg);
      closeOk(reg);
      await spawned;
      await service.stop();

      const env = spawnMock.mock.calls[0]?.[2]?.env as
        | Record<string, string>
        | undefined;
      expect(env).toMatchObject({
        GIT_AUTHOR_NAME: "Configured Author",
        GIT_AUTHOR_EMAIL: "author@example.test",
        GIT_COMMITTER_NAME: "Configured Committer",
        GIT_COMMITTER_EMAIL: "committer@example.test",
      });
    } finally {
      restoreEnv(previousEnv);
    }
  });

  it("writes SKILLS.md into every spawn workspace (shared spawn path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-skills-"));
    try {
      const skillsService = {
        getEligibleSkills: async () => [
          {
            slug: "github",
            name: "GitHub",
            description: "gh CLI usage.",
            content: "# GitHub\n",
          },
        ],
        isSkillEnabled: () => true,
      };
      const reg = nextProc();
      const service = new AcpService(
        runtime({}, { AGENT_SKILLS_SERVICE: skillsService }),
      );
      await service.start();
      const promise = service.spawnSession({
        name: "skills-spawn",
        agentType: "codex",
        workdir: dir,
      });
      await waitForSpawn(reg);
      reg.proc.stdout.emit(
        "data",
        Buffer.from(
          '{"jsonrpc":"2.0","method":"session_started","params":{"sessionId":"skills-spawn"}}\n',
        ),
      );
      closeOk(reg);
      await promise;

      const manifestPath = join(dir, "SKILLS.md");
      expect(existsSync(manifestPath)).toBe(true);
      const manifest = readFileSync(manifestPath, "utf8");
      expect(manifest).toContain("GitHub");
      expect(manifest).toContain("`github`");
      // Broker router not registered here → no broker entry advertised.
      expect(manifest).not.toContain("Parent Eliza Agent");
      // And the on-disk manual has no broker section either.
      expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).not.toContain(
        "Asking the parent Eliza agent to act",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not clobber an existing SKILLS.md in a non-isolated workdir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-skills-existing-"));
    try {
      const existing = "# Repo's own SKILLS.md\nDo not overwrite me.\n";
      await fs.writeFile(join(dir, "SKILLS.md"), existing, "utf8");
      const skillsService = {
        getEligibleSkills: async () => [
          {
            slug: "github",
            name: "GitHub",
            description: "gh CLI usage.",
            content: "# GitHub\n",
          },
        ],
        isSkillEnabled: () => true,
      };
      const reg = nextProc();
      const service = new AcpService(
        runtime({}, { AGENT_SKILLS_SERVICE: skillsService }),
      );
      await service.start();
      // workdir supplied without isolateWorkdir → isolate=false → writes into
      // the real repo root; the pre-existing SKILLS.md must survive.
      const promise = service.spawnSession({
        name: "skills-existing",
        agentType: "codex",
        workdir: dir,
      });
      await waitForSpawn(reg);
      reg.proc.stdout.emit(
        "data",
        Buffer.from(
          '{"jsonrpc":"2.0","method":"session_started","params":{"sessionId":"skills-existing"}}\n',
        ),
      );
      closeOk(reg);
      await promise;

      expect(readFileSync(join(dir, "SKILLS.md"), "utf8")).toBe(existing);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advertises the broker in SKILLS.md + manual when the router is wired", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acp-skills-broker-"));
    try {
      const router = { isActive: () => true };
      const reg = nextProc();
      const service = new AcpService(
        runtime({}, { ACPX_SUB_AGENT_ROUTER: router }),
      );
      await service.start();
      const promise = service.spawnSession({
        name: "broker-spawn",
        agentType: "codex",
        workdir: dir,
      });
      await waitForSpawn(reg);
      reg.proc.stdout.emit(
        "data",
        Buffer.from(
          '{"jsonrpc":"2.0","method":"session_started","params":{"sessionId":"broker-spawn"}}\n',
        ),
      );
      closeOk(reg);
      await promise;

      expect(readFileSync(join(dir, "SKILLS.md"), "utf8")).toContain(
        "Parent Eliza Agent",
      );
      expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain(
        "Asking the parent Eliza agent to act",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors explicit terminal capability opt-out", async () => {
    const reg = nextProc();
    const service = new AcpService(runtime({ ELIZA_ACP_NO_TERMINAL: "true" }));
    await service.start();

    const promise = service.spawnSession({
      name: "no-terminal",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(reg);
    closeOk(reg);
    await promise;

    const args = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(args).toContain("--no-terminal");
  });

  it("uses the native TypeScript transport by default", async () => {
    const service = new AcpService(
      runtime({
        ELIZA_ACP_TRANSPORT: undefined,
        ELIZA_CODEX_ACP_COMMAND: "codex-acp --stdio",
      }),
    );
    await service.start();

    const spawned = await service.spawnSession({
      name: "default-native",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });

    expect(spawned.status).toBe("ready");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(nativeClientMock.instances).toHaveLength(1);
    expect(nativeClientMock.instances[0]?.opts.command).toBe(
      "codex-acp --stdio",
    );
    expect(nativeClientMock.instances[0]?.opts.env?.PARALLAX_SESSION_ID).toBe(
      spawned.sessionId,
    );
  });

  it("pins the default coding git identity over inherited GIT env on native spawns", async () => {
    const previousEnv = snapshotEnv(GIT_IDENTITY_ENV_KEYS);
    process.env.GIT_AUTHOR_NAME = "Hostile Author";
    process.env.GIT_AUTHOR_EMAIL = "hostile-author@example.invalid";
    process.env.GIT_COMMITTER_NAME = "Hostile Committer";
    process.env.GIT_COMMITTER_EMAIL = "hostile-committer@example.invalid";
    delete process.env.ELIZA_CODING_GIT_AUTHOR_NAME;
    delete process.env.ELIZA_CODING_GIT_AUTHOR_EMAIL;
    delete process.env.ELIZA_CODING_GIT_COMMITTER_NAME;
    delete process.env.ELIZA_CODING_GIT_COMMITTER_EMAIL;
    process.env.ELIZA_CONFIG_PATH = join(
      tmpdir(),
      "acp-git-identity-config-does-not-exist.json",
    );
    try {
      const service = new AcpService(
        runtime({
          ELIZA_ACP_TRANSPORT: "native",
          ELIZA_CODEX_ACP_COMMAND: "codex-acp --stdio",
        }),
      );
      await service.start();

      await service.spawnSession({
        name: "default-git-identity-native",
        agentType: "codex",
        workdir: "/tmp/acp-test",
      });
      await service.stop();

      expect(nativeClientMock.instances).toHaveLength(1);
      expect(nativeClientMock.instances[0]?.opts.env).toMatchObject({
        GIT_AUTHOR_NAME: "elizaOS Coding Agent",
        GIT_AUTHOR_EMAIL: "coding-agent.no-reply@elizaos.local",
        GIT_COMMITTER_NAME: "elizaOS Coding Agent",
        GIT_COMMITTER_EMAIL: "coding-agent.no-reply@elizaos.local",
      });
    } finally {
      restoreEnv(previousEnv);
    }
  });

  it("defaults untyped native sessions to the elizaos agent via eliza-code-acp", async () => {
    const service = new AcpService(runtime({ ELIZA_ACP_TRANSPORT: undefined }));
    await service.start();

    const spawned = await service.spawnSession({
      name: "default-codex",
      workdir: "/tmp/acp-test",
    });

    expect(spawned.agentType).toBe("elizaos");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(nativeClientMock.instances).toHaveLength(1);
    // The "elizaos" agent type resolves to the eliza-code ACP server binary
    // (the elizaos CLI has no ACP mode); the spawn command is eliza-code-acp.
    expect(nativeClientMock.instances[0]?.opts.command).toMatch(
      /eliza-code-acp|packages\/examples\/code\/dist\/acp\.js/,
    );
  });

  it("honors explicit elizaos ACP command overrides", async () => {
    const service = new AcpService(
      runtime({
        ELIZA_ACP_TRANSPORT: undefined,
        ELIZA_ELIZAOS_ACP_COMMAND: "custom-eliza-acp --stdio",
      }),
    );
    await service.start();

    const spawned = await service.spawnSession({
      name: "custom-elizaos",
      agentType: "elizaos",
      workdir: "/tmp/acp-test",
    });

    expect(spawned.agentType).toBe("elizaos");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(nativeClientMock.instances).toHaveLength(1);
    expect(nativeClientMock.instances[0]?.opts.command).toBe(
      "custom-eliza-acp --stdio",
    );
  });

  it("supports pi-agent as a configured native default", async () => {
    const service = new AcpService(
      runtime({
        ELIZA_ACP_TRANSPORT: undefined,
        ELIZA_ACP_DEFAULT_AGENT: "pi-agent",
      }),
    );
    await service.start();

    const spawned = await service.spawnSession({
      name: "default-pi-agent",
      workdir: "/tmp/acp-test",
    });

    expect(spawned.agentType).toBe("pi-agent");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(nativeClientMock.instances).toHaveLength(1);
    expect(nativeClientMock.instances[0]?.opts.command).toBe("pi-agent");
  });

  it("still supports the legacy CLI transport when explicitly configured", async () => {
    const reg = nextProc();
    const service = new AcpService(runtime({ ELIZA_ACP_TRANSPORT: "cli" }));
    await service.start();

    const spawned = service.spawnSession({
      name: "explicit-cli",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(reg);
    closeOk(reg);
    await spawned;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(nativeClientMock.instances).toHaveLength(0);
  });

  it("uses configured native commands when explicitly configured", async () => {
    const service = new AcpService(
      runtime({
        ELIZA_ACP_TRANSPORT: "native",
        ELIZA_CODEX_ACP_COMMAND: "codex-acp --stdio",
      }),
    );
    await service.start();

    const result = await service.spawnSession({
      name: "native",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });

    expect(result.status).toBe("ready");
    expect(spawnMock).not.toHaveBeenCalled();
    expect(nativeClientMock.instances).toHaveLength(1);
    expect(nativeClientMock.instances[0]?.opts.command).toBe(
      "codex-acp --stdio",
    );
  });

  it("adds configured Codex ACP sandbox settings to the native command", async () => {
    const service = new AcpService(
      runtime({
        ELIZA_ACP_TRANSPORT: "native",
        ELIZA_CODEX_ACP_COMMAND: "codex-acp --stdio",
        ELIZA_CODEX_ACP_SANDBOX_MODE: "workspace-write",
        ELIZA_CODEX_ACP_APPROVAL_POLICY: "never",
      }),
    );
    await service.start();

    await service.spawnSession({
      name: "codex-sandbox-config",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });

    expect(nativeClientMock.instances).toHaveLength(1);
    expect(nativeClientMock.instances[0]?.opts.command).toBe(
      "codex-acp --stdio -c sandbox_mode=workspace-write -c approval_policy=never",
    );
  });

  it("honors generic Codex sandbox setting aliases", async () => {
    const service = new AcpService(
      runtime({
        ELIZA_ACP_TRANSPORT: "native",
        ELIZA_CODEX_ACP_COMMAND: "codex-acp --stdio",
        ELIZA_CODEX_SANDBOX_MODE: "read-only",
        ELIZA_CODEX_APPROVAL_POLICY: "on-request",
      }),
    );
    await service.start();

    await service.spawnSession({
      name: "codex-sandbox-aliases",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });

    expect(nativeClientMock.instances).toHaveLength(1);
    expect(nativeClientMock.instances[0]?.opts.command).toBe(
      "codex-acp --stdio -c sandbox_mode=read-only -c approval_policy=on-request",
    );
  });

  it("starts Codex ACP with the no-Landlock fallback when the runtime probe is disabled", async () => {
    const rt = runtime({
      ELIZA_ACP_TRANSPORT: "native",
      ELIZA_CODEX_ACP_COMMAND: "codex-acp --stdio",
      ELIZA_CODEX_ACP_LANDLOCK: "0",
    });
    const service = new AcpService(rt);
    await service.start();

    await service.spawnSession({
      name: "codex-no-landlock",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });

    expect(nativeClientMock.instances).toHaveLength(1);
    expect(nativeClientMock.instances[0]?.opts.command).toBe(
      "codex-acp --stdio -c sandbox_mode=danger-full-access -c approval_policy=never",
    );
    const logger = (rt as { logger: { warn: ReturnType<typeof vi.fn> } })
      .logger;
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Landlock unavailable"),
      expect.objectContaining({
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      }),
    );
  });

  it("retries Codex ACP once with a no-Landlock sandbox fallback after the panic", async () => {
    const previousOverride = process.env.ELIZA_CODEX_ACP_LANDLOCK;
    process.env.ELIZA_CODEX_ACP_LANDLOCK = "1";
    try {
      nativeClientMock.startImplementation = async (client) => {
        if (!client.opts.command.includes("sandbox_mode=danger-full-access")) {
          throw new Error(
            "ACP agent exited with code 101: thread 'main' panicked: permission profiles requiring direct runtime enforcement are incompatible with --use-legacy-landlock",
          );
        }
      };
      const rt = runtime({
        ELIZA_ACP_TRANSPORT: "native",
        ELIZA_CODEX_ACP_COMMAND: "codex-acp --stdio",
      });
      const service = new AcpService(rt);
      await service.start();

      const result = await service.spawnSession({
        name: "codex-landlock-retry",
        agentType: "codex",
        workdir: "/tmp/acp-test",
      });

      expect(result.status).toBe("ready");
      expect(nativeClientMock.instances).toHaveLength(2);
      expect(nativeClientMock.instances[0]?.opts.command).toBe(
        "codex-acp --stdio",
      );
      expect(nativeClientMock.instances[1]?.opts.command).toBe(
        "codex-acp --stdio -c sandbox_mode=danger-full-access -c approval_policy=never",
      );
      const logger = (rt as { logger: { warn: ReturnType<typeof vi.fn> } })
        .logger;
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Codex ACP Landlock unavailable"),
        expect.objectContaining({
          sandboxMode: "danger-full-access",
          approvalPolicy: "never",
        }),
      );
    } finally {
      if (previousOverride === undefined) {
        delete process.env.ELIZA_CODEX_ACP_LANDLOCK;
      } else {
        process.env.ELIZA_CODEX_ACP_LANDLOCK = previousOverride;
      }
    }
  });

  it("does not emit task_complete from the session creation command", async () => {
    const reg = nextProc();
    const service = new AcpService(runtime());
    const events: string[] = [];
    const taskCompletePayloads: Array<{ response?: string }> = [];
    service.onSessionEvent((_sid, event, payload) => {
      events.push(event);
      if (event === "task_complete") {
        taskCompletePayloads.push(payload as { response?: string });
      }
    });
    await service.start();

    const promise = service.spawnSession({
      name: "create-only",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(reg);
    reg.proc.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":"create","result":{"stopReason":"end_turn"},"sessionId":"protocol-session"}\n',
      ),
    );
    closeOk(reg);
    await promise;

    expect(events).toContain("ready");
    expect(events).not.toContain("task_complete");
  });

  it("prepares OpenCode ACP environment for Cerebras", async () => {
    const reg = nextProc();
    const service = new AcpService(
      runtime({
        ELIZA_OPENCODE_BASE_URL: "https://api.cerebras.ai/v1",
        ELIZA_OPENCODE_API_KEY: "csk_test",
        ELIZA_OPENCODE_MODEL_POWERFUL: "gpt-oss-120b",
      }),
    );
    await service.start();

    const spawned = service.spawnSession({
      name: "opencode-cerebras",
      agentType: "opencode",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(reg);
    closeOk(reg);
    await spawned;

    const args = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    const agentArgIndex = args?.indexOf("--agent") ?? -1;
    expect(agentArgIndex).toBeGreaterThanOrEqual(0);
    // The shim script lives at `<plugin>/bin/opencode*` and is referenced
    // with platform-native path separators (`\` on Windows, `/` on POSIX).
    // On Windows the spawn target is wrapped in double quotes (paths can
    // contain spaces) and uses the `.cmd` shim, so accept either
    // separator after `plugin-agent-orchestrator`, any extension on the
    // opencode shim, and tolerate surrounding quotes / trailing tokens
    // around the trailing `acp` subcommand.
    const shimArg = args?.[agentArgIndex + 1];
    expect(shimArg).toBeDefined();
    expect(shimArg).toContain("plugin-agent-orchestrator");
    expect(shimArg).toContain("opencode");
    expect(shimArg).toMatch(/\sacp(\s|$)/);
    expect(args).not.toContain("opencode");

    const env = spawnMock.mock.calls[0]?.[2]?.env as
      | Record<string, string>
      | undefined;
    const config = JSON.parse(env?.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<
        string,
        { npm?: string; options?: { baseURL?: string; apiKey?: string } }
      >;
      model?: string;
    };
    expect(env?.OPENCODE_MODEL).toBe("cerebras/gpt-oss-120b");
    expect(env?.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    expect(config.model).toBe("cerebras/gpt-oss-120b");
    expect(config.provider?.cerebras?.options?.baseURL).toBe(
      "https://api.cerebras.ai/v1",
    );
    expect(config.provider?.cerebras?.npm).toBe("@ai-sdk/cerebras");
    expect(config.provider?.cerebras?.options?.apiKey).toBe("csk_test");
  });

  it("keeps BENCHMARK_TASK_AGENT=elizaos as the native default adapter", async () => {
    const reg = nextProc();
    const service = new AcpService(
      runtime({
        BENCHMARK_TASK_AGENT: "elizaos",
        CEREBRAS_API_KEY: "csk_test",
        CEREBRAS_MODEL: "gpt-oss-120b",
      }),
    );
    await service.start();

    const spawned = service.spawnSession({
      name: "benchmark-elizaos",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(reg);
    closeOk(reg);
    const session = await spawned;

    expect(session.agentType).toBe("elizaos");
    const args = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(args).toContain("elizaos");
    expect(args).not.toContain("opencode");

    const env = spawnMock.mock.calls[0]?.[2]?.env as
      | Record<string, string>
      | undefined;
    expect(env?.OPENCODE_MODEL).toBeUndefined();
    expect(env?.OPENAI_MODEL).toBeUndefined();
  });

  it("runs the opt-in native transport through initialize, session creation, prompt, and completion", async () => {
    const service = new AcpService(
      runtime({
        ELIZA_ACP_TRANSPORT: "native",
        ELIZA_CODEX_ACP_COMMAND: "codex-acp --stdio",
      }),
    );
    const events: Array<[string, unknown]> = [];
    service.onSessionEvent((_sid, event, payload) =>
      events.push([event, payload]),
    );
    await service.start();

    const nativeWorkdir = "/tmp/acp-native-test";
    const resolvedNativeWorkdir = path.resolve(nativeWorkdir);
    const spawned = service.spawnSession({
      name: "native-codex",
      agentType: "codex",
      workdir: nativeWorkdir,
    });
    const session = await spawned;
    const client = firstNativeClient();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(client?.opts.command).toBe("codex-acp --stdio");
    expect(client?.opts.cwd).toBe(resolvedNativeWorkdir);
    expect(client?.createSession).toHaveBeenCalledWith(resolvedNativeWorkdir);
    expect(session.status).toBe("ready");
    expect(session.acpxSessionId).toBe("protocol-session");
    expect(events.some(([event]) => event === "ready")).toBe(true);

    client?.prompt.mockImplementationOnce(async () => {
      client.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "protocol-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "native done" },
          },
        },
      });
      client.emit({
        jsonrpc: "2.0",
        id: "prompt",
        result: { stopReason: "end_turn" },
      });
      return { stopReason: "end_turn" };
    });
    const sent = service.sendPrompt(session.sessionId, "hello native");
    const result = await sent;

    expect(client?.prompt).toHaveBeenCalledWith(
      "protocol-session",
      "hello native",
    );
    expect(result.response).toBe("native done");
    expect(result.stopReason).toBe("end_turn");
    expect(events).toEqual(
      expect.arrayContaining([
        ["message", { text: "native done" }],
        [
          "task_complete",
          expect.objectContaining({
            response: "native done",
            stopReason: "end_turn",
          }),
        ],
      ]),
    );
  });

  it("uses an explicit OpenCode ACP command override when configured", async () => {
    const reg = nextProc();
    const service = new AcpService(
      runtime({
        ELIZA_OPENCODE_ACP_COMMAND: "/opt/opencode/bin/opencode acp",
      }),
    );
    await service.start();

    const spawned = service.spawnSession({
      name: "opencode-command",
      agentType: "opencode",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(reg);
    closeOk(reg);
    const { sessionId } = await spawned;

    const args = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    const agentArgIndex = args?.indexOf("--agent") ?? -1;
    expect(agentArgIndex).toBeGreaterThanOrEqual(0);
    expect(args?.[agentArgIndex + 1]).toBe("/opt/opencode/bin/opencode acp");
    expect(args).not.toContain("opencode");

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "write a tiny static page");
    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":"prompt","result":{"stopReason":"end_turn"},"sessionId":"protocol-session"}\n',
      ),
    );
    closeOk(prompt);
    await sent;

    const promptArgs = spawnMock.mock.calls[1]?.[1] as string[] | undefined;
    const promptAgentArgIndex = promptArgs?.indexOf("--agent") ?? -1;
    expect(promptAgentArgIndex).toBeGreaterThanOrEqual(0);
    expect(promptArgs?.[promptAgentArgIndex + 1]).toBe(
      "/opt/opencode/bin/opencode acp",
    );
    expect(promptArgs).not.toContain("opencode");
  });

  it("sendPrompt emits message, tool_running, task_complete and resolves PromptResult", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    const events: string[] = [];
    const taskCompletePayloads: Array<{ response?: string }> = [];
    const toolPayloads: Array<{
      toolCall?: { status?: string; output?: string; title?: string };
    }> = [];
    service.onSessionEvent((_sid, event, payload) => {
      events.push(event);
      if (event === "tool_running") {
        toolPayloads.push(
          payload as { toolCall?: { status?: string; output?: string } },
        );
      }
      if (event === "task_complete") {
        taskCompletePayloads.push(payload as { response?: string });
      }
    });
    await service.start();
    const spawned = service.spawnSession({
      name: "s2",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "do the thing");
    await waitForSpawn(prompt);
    // Real ACP wraps under params.update.{...}; service handles both.
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"',
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `${sessionId}","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}\n`,
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","update":{"sessionUpdate":"tool_call","toolCallId":"t1","status":"in_progress","title":"Running tool"}}}\n`,
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed","title":"Running tool","rawOutput":"{\\"output\\":\\"Filesystem      Size  Used Avail Use% Mounted on\\\\n/dev/root        45G   38G  7.0G  84% /\\",\\"metadata\\":{\\"exitCode\\":0}}"}}}\n`,
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","update":{"sessionUpdate":"tool_call_update","toolCallId":"t2","status":"completed","title":"Read home usage","content":{"type":"text","text":"/home            387G  223G  165G  58% /home"}}}}\n`,
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","id":"req-1","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);

    const result = await sent;
    const promptEnv = spawnMock.mock.calls[1]?.[2]?.env as
      | Record<string, string>
      | undefined;
    expect(promptEnv?.PARALLAX_SESSION_ID).toBe(sessionId);
    expect(result.response).toContain("done");
    expect(result.response).toContain("[tool output: Running tool]");
    expect(result.response).toContain("/dev/root        45G");
    expect(result.response).toContain("[/tool output]");
    expect(result.response).toContain("[tool output: Read home usage]");
    expect(result.response).toContain("/home            387G");
    expect(result.response).not.toContain('"metadata"');
    expect(taskCompletePayloads[0]?.response).toBe(result.response);
    expect(result.stopReason).toBe("end_turn");
    expect(toolPayloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCall: expect.objectContaining({
            status: "in_progress",
            title: "Running tool",
          }),
        }),
        expect.objectContaining({
          toolCall: expect.objectContaining({
            status: "completed",
            title: "Running tool",
            output: expect.stringContaining("/dev/root        45G"),
          }),
        }),
        expect.objectContaining({
          toolCall: expect.objectContaining({
            status: "completed",
            title: "Read home usage",
            output: expect.stringContaining("/home            387G"),
          }),
        }),
      ]),
    );
    // A clean exit with captured output emits exactly one terminal event
    // (`task_complete`); the redundant `stopped` was dropped to avoid
    // double-processing downstream.
    expect(events).toEqual(
      expect.arrayContaining(["message", "tool_running", "task_complete"]),
    );
    expect(events).not.toContain("stopped");
    expect(events.indexOf("message")).toBeLessThan(
      events.indexOf("task_complete"),
    );
  });

  it("flushes raw stdout before advertising stdoutLogPath on task_complete", async () => {
    const priorTrajDir = process.env.ELIZA_TRAJECTORY_DIR;
    const priorRecording = process.env.ELIZA_TRAJECTORY_RECORDING;
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-stdout-"));
    process.env.ELIZA_TRAJECTORY_DIR = tmpDir;
    process.env.ELIZA_TRAJECTORY_RECORDING = "1";
    try {
      const create = nextProc();
      const service = new AcpService(runtime());
      const taskCompletePayloads: Array<{
        response?: string;
        stdoutLogPath?: string;
      }> = [];
      service.onSessionEvent((_sid, event, payload) => {
        if (event === "task_complete") {
          taskCompletePayloads.push(
            payload as { response?: string; stdoutLogPath?: string },
          );
        }
      });
      await service.start();
      const spawned = service.spawnSession({
        name: "stdout-path",
        agentType: "codex",
        workdir: "/tmp/acp-test",
      });
      await waitForSpawn(create);
      closeOk(create);
      const { sessionId } = await spawned;

      const prompt = nextProc();
      const sent = service.sendPrompt(sessionId, "persist stdout");
      await waitForSpawn(prompt);
      const terminalLine = `{"jsonrpc":"2.0","id":"req-1","result":{"stopReason":"end_turn","content":[{"type":"text","text":"stdout persisted"}]},"sessionId":"${sessionId}"}\n`;
      prompt.proc.stdout.emit("data", Buffer.from(terminalLine));
      closeOk(prompt);

      await sent;
      const payload = taskCompletePayloads[0];
      expect(payload?.response).toBe("stdout persisted");
      expect(payload?.stdoutLogPath).toBe(
        path.join(tmpDir, "subagent-stdout", `${sessionId}.ndjson`),
      );
      const raw = await fs.readFile(payload?.stdoutLogPath ?? "", "utf8");
      const records = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { text: string });
      expect(records.map((record) => record.text)).toContain(terminalLine);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
      if (priorTrajDir === undefined) delete process.env.ELIZA_TRAJECTORY_DIR;
      else process.env.ELIZA_TRAJECTORY_DIR = priorTrajDir;
      if (priorRecording === undefined)
        delete process.env.ELIZA_TRAJECTORY_RECORDING;
      else process.env.ELIZA_TRAJECTORY_RECORDING = priorRecording;
    }
  });

  it("native sendPrompt preserves final text returned on the terminal prompt result", async () => {
    const service = new AcpService(runtime({ ELIZA_ACP_TRANSPORT: "native" }));
    const taskCompletePayloads: Array<{ response?: string }> = [];
    service.onSessionEvent((_sid, event, payload) => {
      if (event === "task_complete") {
        taskCompletePayloads.push(payload as { response?: string });
      }
    });
    await service.start();
    const { sessionId } = await service.spawnSession({
      name: "native-final",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    const client = firstNativeClient();
    client.prompt.mockImplementationOnce(async () => {
      client.emit({
        jsonrpc: "2.0",
        id: "prompt",
        sessionId: "protocol-session",
        result: {
          stopReason: "end_turn",
          content: [{ type: "text", text: "final answer" }],
        },
      } as AcpJsonRpcMessage);
      return { stopReason: "end_turn" };
    });

    const result = await service.sendPrompt(sessionId, "answer");

    expect(result.response).toBe("final answer");
    expect(result.finalText).toBe("final answer");
    expect(taskCompletePayloads[0]?.response).toBe("final answer");
    expect((await service.getSession(sessionId))?.status).toBe("ready");
  });

  // Fix #2 (PR #9855): a terminal `stopReason === "error"` that nonetheless
  // captured a real deliverable (the sub-agent edited files / deployed / printed
  // a verified result before its LAST step errored) must NOT be dropped. The
  // event is relayed as `task_complete` so the normal completion path runs, and
  // the durable store is NOT flipped to `errored` (which would show a
  // false-failed task in history while the user actually got the result).
  it("native sendPrompt relays a stopReason=error WITH captured deliverable as task_complete, not error", async () => {
    const service = new AcpService(runtime({ ELIZA_ACP_TRANSPORT: "native" }));
    const events: Array<{ event: string; payload: unknown }> = [];
    service.onSessionEvent((_sid, event, payload) => {
      events.push({ event, payload });
    });
    await service.start();
    const { sessionId } = await service.spawnSession({
      name: "native-error-with-output",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    const client = firstNativeClient();
    client.prompt.mockImplementationOnce(async () => {
      // Terminal result carries real output but ends with stopReason error.
      client.emit({
        jsonrpc: "2.0",
        id: "prompt",
        sessionId: "protocol-session",
        result: {
          stopReason: "error",
          content: [
            { type: "text", text: "Deployed the site to https://x.io" },
          ],
        },
      } as AcpJsonRpcMessage);
      // client.prompt resolves with the same terminal stopReason.
      return { stopReason: "error" };
    });

    const result = await service.sendPrompt(sessionId, "build it");

    const emitted = events.map((e) => e.event);
    // The deliverable rides the completion path, never a user-facing error.
    expect(emitted).toContain("task_complete");
    expect(emitted).not.toContain("error");
    const completePayload = events.find((e) => e.event === "task_complete")
      ?.payload as { response?: string; stopReason?: string } | undefined;
    expect(completePayload?.response).toBe("Deployed the site to https://x.io");
    // The captured deliverable survives on the result.
    expect(result.finalText).toBe("Deployed the site to https://x.io");
    // Durable store is NOT flipped to errored — the work succeeded for the user.
    expect((await service.getSession(sessionId))?.status).not.toBe("errored");
  });

  // The other half of Fix #2: a true failure (stopReason error AND no captured
  // output) still surfaces as a user-facing `error` and marks the store errored.
  it("native sendPrompt surfaces a stopReason=error with EMPTY deliverable as error", async () => {
    const service = new AcpService(runtime({ ELIZA_ACP_TRANSPORT: "native" }));
    const events: string[] = [];
    service.onSessionEvent((_sid, event) => events.push(event));
    await service.start();
    const { sessionId } = await service.spawnSession({
      name: "native-error-empty",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    const client = firstNativeClient();
    client.prompt.mockImplementationOnce(async () => {
      // Terminal result: error with no captured deliverable at all.
      client.emit({
        jsonrpc: "2.0",
        id: "prompt",
        sessionId: "protocol-session",
        result: { stopReason: "error" },
      } as AcpJsonRpcMessage);
      return { stopReason: "error" };
    });

    await service.sendPrompt(sessionId, "build it");

    // No deliverable → genuine failure: error event, errored store status.
    expect(events).toContain("error");
    expect(events).not.toContain("task_complete");
    expect((await service.getSession(sessionId))?.status).toBe("errored");
  });

  it("native sendPrompt re-spaces word-split terminal result text blocks", async () => {
    const service = new AcpService(runtime({ ELIZA_ACP_TRANSPORT: "native" }));
    await service.start();
    const { sessionId } = await service.spawnSession({
      name: "native-wordsplit",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    const client = firstNativeClient();
    client.prompt.mockImplementationOnce(async () => {
      client.emit({
        jsonrpc: "2.0",
        id: "prompt",
        sessionId: "protocol-session",
        result: {
          stopReason: "end_turn",
          content: [
            { type: "text", text: "the change" },
            { type: "text", text: "is" },
            { type: "text", text: "proven and" },
            { type: "text", text: "received" },
            { type: "text", text: "at runtime" },
          ],
        },
      } as AcpJsonRpcMessage);
      return { stopReason: "end_turn" };
    });

    const result = await service.sendPrompt(sessionId, "answer");

    expect(result.response).toBe(
      "the change is proven and received at runtime",
    );
    expect(result.finalText).toBe(
      "the change is proven and received at runtime",
    );
  });

  it("native sendPrompt forwards thought chunks as reasoning without polluting the final answer", async () => {
    const service = new AcpService(runtime({ ELIZA_ACP_TRANSPORT: "native" }));
    const events: Array<{ event: string; data: unknown }> = [];
    service.onSessionEvent((_sid, event, data) => {
      events.push({ event, data });
    });
    await service.start();
    const { sessionId } = await service.spawnSession({
      name: "native-reasoning",
      agentType: "opencode",
      workdir: "/tmp/acp-test",
    });
    const client = firstNativeClient();
    client.prompt.mockImplementationOnce(async () => {
      client.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "protocol-session",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "Check the failing output. " },
          },
        },
      } as AcpJsonRpcMessage);
      client.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "protocol-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "The fix is ready." },
          },
        },
      } as AcpJsonRpcMessage);
      client.emit({
        jsonrpc: "2.0",
        id: "prompt",
        result: { stopReason: "end_turn" },
      } as AcpJsonRpcMessage);
      return { stopReason: "end_turn" };
    });

    const result = await service.sendPrompt(sessionId, "finish");

    expect(result.response).toBe("The fix is ready.");
    expect(result.finalText).toBe("The fix is ready.");
    expect(events).toContainEqual({
      event: "reasoning",
      data: { text: "Check the failing output. " },
    });
    expect(
      events.filter(({ event }) => event === "message").map(({ data }) => data),
    ).toEqual([{ text: "The fix is ready." }]);
  });

  it("native sendPrompt forwards sanitized ACP plan updates", async () => {
    const service = new AcpService(runtime({ ELIZA_ACP_TRANSPORT: "native" }));
    const planPayloads: Array<{ entries?: unknown }> = [];
    service.onSessionEvent((_sid, event, payload) => {
      if (event === "plan") planPayloads.push(payload as { entries?: unknown });
    });
    await service.start();
    const { sessionId } = await service.spawnSession({
      name: "native-plan",
      agentType: "opencode",
      workdir: "/tmp/acp-test",
    });
    const client = firstNativeClient();
    client.prompt.mockImplementationOnce(async () => {
      client.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "protocol-session",
          update: {
            sessionUpdate: "plan",
            entries: [
              {
                content: "Write the file",
                status: "in_progress",
                priority: "medium",
                ignored: "not forwarded",
              },
              {
                content: "Read it back",
                status: "pending",
                priority: "low",
              },
              {
                content: "Defaults apply",
                status: "",
                priority: 1,
              },
              { content: "", status: "pending", priority: "medium" },
              "not an entry",
            ],
          },
        },
      } as AcpJsonRpcMessage);
      client.emit({
        jsonrpc: "2.0",
        id: "prompt",
        result: { stopReason: "end_turn" },
      } as AcpJsonRpcMessage);
      return { stopReason: "end_turn" };
    });

    await service.sendPrompt(sessionId, "go");

    expect(planPayloads).toHaveLength(1);
    expect(planPayloads[0]?.entries).toEqual([
      { content: "Write the file", status: "in_progress", priority: "medium" },
      { content: "Read it back", status: "pending", priority: "low" },
      { content: "Defaults apply", status: "pending", priority: "medium" },
    ]);
  });

  it("native sendPrompt rejects overlapping prompts before swapping event handlers", async () => {
    const service = new AcpService(runtime({ ELIZA_ACP_TRANSPORT: "native" }));
    await service.start();
    const { sessionId } = await service.spawnSession({
      name: "native-overlap",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    const client = firstNativeClient();
    let resolvePrompt: (value: { stopReason: string }) => void = () =>
      undefined;
    client.prompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePrompt = resolve;
        }),
    );

    const first = service.sendPrompt(sessionId, "first");
    await new Promise((resolve) => setImmediate(resolve));

    await expect(service.sendPrompt(sessionId, "second")).rejects.toThrow(
      /already busy/,
    );
    resolvePrompt({ stopReason: "end_turn" });
    await first;
    expect(client.prompt).toHaveBeenCalledTimes(1);
  });

  it("native cancel preserves cancelled status when the prompt later resolves", async () => {
    const service = new AcpService(runtime({ ELIZA_ACP_TRANSPORT: "native" }));
    await service.start();
    const { sessionId } = await service.spawnSession({
      name: "native-cancel",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    const client = firstNativeClient();
    let resolvePrompt: (value: { stopReason: string }) => void = () =>
      undefined;
    client.prompt.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePrompt = resolve;
        }),
    );

    const sent = service.sendPrompt(sessionId, "long running");
    await new Promise((resolve) => setImmediate(resolve));
    await service.cancelSession(sessionId);
    resolvePrompt({ stopReason: "end_turn" });
    const result = await sent;

    expect(client.cancel).toHaveBeenCalledWith("protocol-session");
    expect(result.stopReason).toBe("cancelled");
    expect(result.error).toBeUndefined();
    expect((await service.getSession(sessionId))?.status).toBe("cancelled");
  });

  it("native permission requests emit blocked and login_required events", async () => {
    const service = new AcpService(runtime({ ELIZA_ACP_TRANSPORT: "native" }));
    const events: string[] = [];
    service.onSessionEvent((_sid, event) => events.push(event));
    await service.start();
    await service.spawnSession({
      name: "native-permission",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    const client = firstNativeClient();

    client.emit({
      jsonrpc: "2.0",
      id: "permission",
      method: "session/request_permission",
      params: {
        sessionId: "protocol-session",
        description: "login required to continue",
      },
    } as AcpJsonRpcMessage);

    expect(events).toEqual(
      expect.arrayContaining(["blocked", "login_required"]),
    );
  });

  it("does NOT emit blocked for an auto-approved (non-auth) permission request", async () => {
    // Regression for the phantom-blocked bug: the native transport auto-responds
    // (approves) to this request per the session preset, so surfacing "blocked"
    // is a false signal that derails the planner (re-spawn + user-facing block).
    const service = new AcpService(runtime({ ELIZA_ACP_TRANSPORT: "native" }));
    const events: string[] = [];
    service.onSessionEvent((_sid, event) => events.push(event));
    await service.start();
    await service.spawnSession({
      name: "native-auto-approve",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    const client = firstNativeClient();
    client.approvesPermissionRequest.mockReturnValue(true);

    client.emit({
      jsonrpc: "2.0",
      id: "permission",
      method: "session/request_permission",
      params: {
        sessionId: "protocol-session",
        description: "allow read of file.ts",
        toolCall: { kind: "read" },
      },
    } as AcpJsonRpcMessage);

    expect(events).not.toContain("blocked");
    expect(events).not.toContain("login_required");
  });

  it("still emits blocked when the transport will NOT auto-approve the request", async () => {
    const service = new AcpService(runtime({ ELIZA_ACP_TRANSPORT: "native" }));
    const events: string[] = [];
    service.onSessionEvent((_sid, event) => events.push(event));
    await service.start();
    await service.spawnSession({
      name: "native-denied",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    const client = firstNativeClient();
    client.approvesPermissionRequest.mockReturnValue(false);

    client.emit({
      jsonrpc: "2.0",
      id: "permission",
      method: "session/request_permission",
      params: {
        sessionId: "protocol-session",
        description: "allow execute of rm -rf",
        toolCall: { kind: "execute" },
      },
    } as AcpJsonRpcMessage);

    expect(events).toContain("blocked");
  });

  it("closes one-shot initialTask sessions after completion", async () => {
    const create = nextProc();
    const prompt = nextProc();
    const close = nextProc();
    const service = new AcpService(runtime());
    await service.start();

    const spawned = service.spawnSession({
      name: "one-shot",
      agentType: "codex",
      workdir: "/tmp/acp-test",
      initialTask: "write the app",
      metadata: { keepAliveAfterComplete: false },
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","id":"prompt","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);

    await waitForSpawn(close);
    closeOk(close);

    await waitForSessionStatus(service, sessionId, "stopped");
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it("keeps initialTask sessions open when keepAliveAfterComplete is true", async () => {
    const create = nextProc();
    const prompt = nextProc();
    const service = new AcpService(runtime());
    await service.start();

    const spawned = service.spawnSession({
      name: "keep-alive",
      agentType: "codex",
      workdir: "/tmp/acp-test",
      initialTask: "write the app",
      metadata: { keepAliveAfterComplete: true },
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","id":"prompt","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);

    await waitForSessionStatus(service, sessionId, "ready");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("passes route-prefixed prompts after an end-of-options marker", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    await service.start();
    const spawned = service.spawnSession({
      name: "route-prefixed",
      agentType: "opencode",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const text = "--- Resolved Workspace ---\nDo the task.";
    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, text);
    await waitForSpawn(prompt);

    const args = spawnMock.mock.calls.at(-1)?.[1] as string[] | undefined;
    expect(args?.slice(-2)).toEqual(["--", text]);

    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","id":"req-route","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);
    await sent;
  });

  it("does not treat unclassified text update echoes as prompt output", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    await service.start();
    const spawned = service.spawnSession({
      name: "ignore-echo",
      agentType: "opencode",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    const sent = service.sendPrompt(
      sessionId,
      "build https://example.test/app",
    );
    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","content":{"type":"text","text":"build https://example.test/app"}}}\n`,
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}\n`,
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","id":"req-echo","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);

    const result = await sent;
    expect(result.response).toBe("done");
  });

  it("accepts direct assistant text updates when adapters provide a role", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    await service.start();
    const spawned = service.spawnSession({
      name: "assistant-direct",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "do the thing");
    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","role":"assistant","content":{"type":"text","text":"direct done"}}}\n`,
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","id":"req-direct","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);

    const result = await sent;
    expect(result.response).toBe("direct done");
  });

  it("keys service events by local session id when ACP reports a protocol session id", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    const eventSessionIds: string[] = [];
    const acpSessionIds: Array<string | undefined> = [];
    service.onSessionEvent((sid) => eventSessionIds.push(sid));
    service.onAcpEvent((_event, sid) => acpSessionIds.push(sid));
    await service.start();
    const spawned = service.spawnSession({
      name: "local-id",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "hi");
    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"protocol-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}\n',
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":"req","result":{"sessionId":"protocol-session","stopReason":"end_turn"}}\n',
      ),
    );
    closeOk(prompt);
    await sent;

    expect(eventSessionIds).toContain(sessionId);
    expect(eventSessionIds).not.toContain("protocol-session");
    expect(acpSessionIds).toContain(sessionId);
    expect(acpSessionIds).not.toContain("protocol-session");
    expect((await service.getSession(sessionId))?.acpxSessionId).toBe(
      "protocol-session",
    );
  });

  it("cancelSession sends SIGTERM then SIGKILL after grace", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    await service.start();
    const spawned = service.spawnSession({
      name: "s3",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    void service.sendPrompt(sessionId, "long running").catch(() => undefined);
    await waitForSpawn(prompt);
    void service.cancelSession(sessionId).catch(() => undefined);
    // give cancelSession a tick to call kill
    await new Promise((resolve) => setImmediate(resolve));

    expect(prompt.proc.kill).toHaveBeenCalledWith("SIGTERM");
    prompt.proc.emit("close", 130, "SIGTERM");
  });

  it("preserves cancelled status when cancelling an in-flight prompt", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    const events: string[] = [];
    service.onSessionEvent((_sid, event) => events.push(event));
    await service.start();
    const spawned = service.spawnSession({
      name: "cancel-active",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "long running");
    await waitForSpawn(prompt);
    const cancelled = service.cancelSession(sessionId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(prompt.proc.kill).toHaveBeenCalledWith("SIGTERM");
    prompt.proc.emit("close", 130, "SIGTERM");

    await cancelled;
    const result = await sent;
    expect(result.stopReason).toBe("cancelled");
    expect(result.error).toBeUndefined();
    expect((await service.getSession(sessionId))?.status).toBe("cancelled");
    expect(events).toContain("cancelled");
    expect(events).not.toContain("error");
  });

  it("ignores malformed NDJSON without crashing", async () => {
    const create = nextProc();
    const rt = runtime() as { logger: { warn: ReturnType<typeof vi.fn> } };
    const service = new AcpService(rt as never);
    await service.start();
    const promise = service.spawnSession({
      name: "bad-json",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    create.proc.stdout.emit("data", Buffer.from("not-json\n"));
    closeOk(create);
    await expect(promise).resolves.toMatchObject({ name: "bad-json" });
    expect(rt.logger.warn).toHaveBeenCalled();
  });

  it("handles partial lines across chunk boundaries", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    const events: string[] = [];
    service.onSessionEvent((_sid, event) => events.push(event));
    await service.start();
    const spawned = service.spawnSession({
      name: "partial",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;
    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "hi");
    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hel`,
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `lo"}}}}\n{"jsonrpc":"2.0","id":"req","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);
    const result = await sent;
    expect(result.response).toBe("hello");
    expect(events).toContain("task_complete");
  });

  it("maps exit code 1 with auth stderr to auth error event", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    const errors: unknown[] = [];
    service.onSessionEvent((_sid, event, data) => {
      if (event === "error") errors.push(data);
    });
    await service.start();
    const spawned = service.spawnSession({
      name: "auth",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "hi");
    await waitForSpawn(prompt);
    prompt.proc.stderr.emit(
      "data",
      Buffer.from("401 unauthorized authenticate failed"),
    );
    setImmediate(() => prompt.proc.emit("close", 1, null));
    await sent;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ failureKind: "auth" }),
      ]),
    );
  });

  it("types a Claude injected-token expiry without misclassifying Codex refresh expiry", async () => {
    const service = new AcpService(runtime());
    const classify = (
      service as unknown as {
        authFailureFields(
          text: string,
          agentType?: string,
        ): Record<string, unknown>;
      }
    ).authFailureFields.bind(service);

    expect(classify("oauth token has expired", "claude")).toEqual({
      failureKind: "auth",
      authReason: "token_expired",
    });
    expect(classify("refresh token has expired", "codex")).toEqual({
      failureKind: "auth",
    });
    expect(classify("ordinary compiler failure", "claude")).toEqual({});
  });

  it("honors public env aliases for workspace, approval, and prompt timeout", async () => {
    const create = nextProc();
    const workspaceRoot = "/tmp/acp-workspace-root";
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot);
    const service = new AcpService(
      runtime({
        ELIZA_ACP_WORKSPACE_ROOT: workspaceRoot,
        ELIZA_ACP_DEFAULT_APPROVAL: "read-only",
        ELIZA_ACP_PROMPT_TIMEOUT_MS: "123000",
      }),
    );
    await service.start();

    const spawned = service.spawnSession({
      name: "env-alias",
      agentType: "codex",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;
    // A direct spawnSession with no opts.workdir lands on the configured
    // workspace ROOT, which is now isolated per-session (<root>/task-<id>) so
    // concurrent tasks can't collide — see computeSessionWorkdir.
    const isolatedCwd = path.resolve(
      resolvedWorkspaceRoot,
      `task-${sessionId}`,
    );

    expect(spawnMock).toHaveBeenCalledWith(
      "acpx",
      expect.arrayContaining(["--cwd", isolatedCwd, "--deny-all"]),
      expect.objectContaining({ cwd: isolatedCwd }),
    );

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "hi");
    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","id":"req","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);
    await sent;

    expect(spawnMock).toHaveBeenLastCalledWith(
      "acpx",
      expect.arrayContaining(["--timeout", "123"]),
      expect.objectContaining({ cwd: isolatedCwd }),
    );
  });

  it("reattach after dead pid respawns", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    await service.start();
    const spawned = service.spawnSession({
      name: "reattach",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;
    const session = await service.getSession(sessionId);
    expect(session).toBeTruthy();
    const store = Reflect.get(service, "store") as {
      update: (id: string, patch: unknown) => Promise<void>;
    };
    await store.update(sessionId, { pid: 999999 });

    const respawnProc = nextProc();
    const reattached = service.reattachSession(sessionId);
    await waitForSpawn(respawnProc);
    closeOk(respawnProc);
    const result = await reattached;
    expect(result.sessionId).not.toBe(sessionId);
    expect(result.name).toBe("reattach");
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});

describe("AcpService.runHealthCheck state_lost guards", () => {
  function staleSession(
    over: Partial<import("../../src/services/types.ts").SessionInfo>,
  ) {
    const old = new Date(Date.now() - 10 * 60_000); // well past grace window
    return {
      id: over.id ?? "00000000-0000-0000-0000-0000000000aa",
      name: "hc",
      agentType: "opencode" as const,
      workdir: "/tmp/acp-test",
      status: "ready" as const,
      approvalPreset: "standard" as const,
      createdAt: old,
      lastActivityAt: old,
      acpxSessionId: "ses_doesnotexist_health_check",
      metadata: { roomId: "11111111-2222-3333-4444-555555555555" },
      ...over,
    };
  }

  it("does NOT mark an idle 'ready' session state_lost (a finished session is not a crash)", async () => {
    const service = new AcpService(runtime());
    await service.start();
    const store = Reflect.get(service, "store") as {
      create: (s: unknown) => Promise<void>;
    };
    const id = "00000000-0000-0000-0000-0000000000a1";
    await store.create(staleSession({ id, status: "ready" }));

    await (
      service as unknown as { runHealthCheck: () => Promise<void> }
    ).runHealthCheck();

    const after = await service.getSession(id);
    // The old bug flipped this to "errored"+session_state_lost (the cascade
    // trigger) purely because the .stream.ndjson probe never matched. A ready
    // session must be left alone.
    expect(after?.status).toBe("ready");
  });

  it("still marks a genuinely mid-flight session errored when its state artifact is gone", async () => {
    const service = new AcpService(runtime());
    await service.start();
    const store = Reflect.get(service, "store") as {
      create: (s: unknown) => Promise<void>;
    };
    const id = "00000000-0000-0000-0000-0000000000a2";
    await store.create(staleSession({ id, status: "running" }));

    await (
      service as unknown as { runHealthCheck: () => Promise<void> }
    ).runHealthCheck();

    const after = await service.getSession(id);
    expect(after?.status).toBe("errored");
  });

  it("enforces ELIZA_ACP_MAX_SESSIONS atomically under concurrent spawns", async () => {
    // Native transport: each spawn resolves to an active ("ready") session
    // without the proc-mock dance, so we can fire many in parallel and let the
    // check-and-reserve race. Before the fix, the limit check (list) and the
    // insert (create) were separate awaited ops, so N concurrent spawns could
    // all pass the check before any inserted and overshoot the cap.
    const service = new AcpService(
      runtime({
        ELIZA_ACP_TRANSPORT: undefined,
        ELIZA_ACP_MAX_SESSIONS: "2",
      }),
    );
    await service.start();

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        service.spawnSession({
          name: `concurrent-${i}`,
          workdir: "/tmp/acp-test",
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    // The cap must hold exactly: 2 succeed, the rest reject with the typed
    // SessionCapError so a caller (or the admission queue) branches on `code`
    // instead of string-matching the message.
    expect(fulfilled).toHaveLength(2);
    expect(rejected.length).toBe(4);
    for (const r of rejected) {
      const reason = (r as PromiseRejectedResult).reason as SessionCapError;
      expect(reason).toBeInstanceOf(SessionCapError);
      expect(reason.code).toBe("SESSION_CAP_REACHED");
      expect(reason.slotClass).toBe("worker");
      expect(reason.maxSessions).toBe(2);
    }

    // And the store agrees: only 2 active sessions exist.
    const sessions = await service.listSessions();
    const active = sessions.filter(
      (s) =>
        !["stopped", "errored", "completed", "cancelled"].includes(s.status),
    );
    expect(active).toHaveLength(2);
  });

  it("getCapacity reports free/used slots for both admission pools", async () => {
    const service = new AcpService(
      runtime({
        ELIZA_ACP_TRANSPORT: undefined,
        ELIZA_ACP_MAX_SESSIONS: "2",
        ELIZA_ACP_SYSTEM_SESSION_HEADROOM: "1",
      }),
    );
    await service.start();

    expect(await service.getCapacity()).toEqual({
      maxSessions: 2,
      systemHeadroom: 1,
      activeWorkers: 0,
      activeSystem: 0,
      freeWorkerSlots: 2,
      freeSystemSlots: 1,
    });

    await service.spawnSession({ name: "w1", workdir: "/tmp/acp-test" });
    const cap = await service.getCapacity();
    expect(cap.activeWorkers).toBe(1);
    expect(cap.freeWorkerSlots).toBe(1);
    expect(cap.activeSystem).toBe(0);
    expect(cap.freeSystemSlots).toBe(1);
  });

  it("admits a system spawn on reserved headroom while the worker cap is full (no verifier deadlock)", async () => {
    // Reproduces the #8898 verifier deadlock guard: at a full worker cap the
    // read-only verifier still needs a fresh session while the worker it is
    // verifying holds its slot. A separate `system` pool must let it in.
    const service = new AcpService(
      runtime({
        ELIZA_ACP_TRANSPORT: undefined,
        ELIZA_ACP_MAX_SESSIONS: "1",
        ELIZA_ACP_SYSTEM_SESSION_HEADROOM: "1",
      }),
    );
    await service.start();

    // Fill the single worker slot.
    await service.spawnSession({ name: "worker", workdir: "/tmp/acp-test" });

    // A second worker is rejected — the worker pool is full.
    await expect(
      service.spawnSession({ name: "worker-2", workdir: "/tmp/acp-test" }),
    ).rejects.toMatchObject({
      code: "SESSION_CAP_REACHED",
      slotClass: "worker",
    });

    // But a system spawn is admitted despite the full worker pool: it draws on
    // the reserved headroom, so validation never deadlocks behind its worker.
    const verifier = await service.spawnSession({
      name: "verifier",
      slotClass: "system",
      workdir: "/tmp/acp-test",
    });
    expect(verifier.sessionId).toBeTruthy();

    // The system pool has its own cap: a second system spawn is rejected.
    await expect(
      service.spawnSession({
        name: "verifier-2",
        slotClass: "system",
        workdir: "/tmp/acp-test",
      }),
    ).rejects.toMatchObject({
      code: "SESSION_CAP_REACHED",
      slotClass: "system",
    });

    const cap = await service.getCapacity();
    expect(cap).toMatchObject({
      activeWorkers: 1,
      activeSystem: 1,
      freeWorkerSlots: 0,
      freeSystemSlots: 0,
    });
  });

  it("frees a worker slot for a new spawn once a session reaches a terminal status", async () => {
    const service = new AcpService(
      runtime({
        ELIZA_ACP_TRANSPORT: undefined,
        ELIZA_ACP_MAX_SESSIONS: "1",
      }),
    );
    await service.start();

    const first = await service.spawnSession({
      name: "w1",
      workdir: "/tmp/acp-test",
    });
    // Cap is full: the next worker is rejected.
    await expect(
      service.spawnSession({ name: "w2", workdir: "/tmp/acp-test" }),
    ).rejects.toBeInstanceOf(SessionCapError);

    // Terminate the first session; its slot must free.
    await service.stopSession(first.sessionId);
    expect((await service.getCapacity()).freeWorkerSlots).toBe(1);

    // Now a fresh worker is admitted deterministically.
    const third = await service.spawnSession({
      name: "w3",
      workdir: "/tmp/acp-test",
    });
    expect(third.sessionId).toBeTruthy();
    expect((await service.getCapacity()).activeWorkers).toBe(1);
  });

  it("rejects a concurrent prompt for the same native session (TOCTOU #11028)", async () => {
    const service = new AcpService(runtime({ ELIZA_ACP_TRANSPORT: undefined }));
    await service.start();
    const spawned = await service.spawnSession({
      name: "busy-guard",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    // Hold the first prompt in-flight so the session stays claimed while the
    // second call races it.
    let release: (() => void) | undefined;
    firstNativeClient().prompt = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ stopReason: "end_turn" });
        }),
    );
    const p1 = service.sendPrompt(spawned.sessionId, "first");
    // NO tick between the two sendPrompt calls: the race the fix closes is a
    // same-tick check-then-claim, and inserting even a 10ms sleep here made the
    // test pass on the PRE-fix code (the first prompt's claim landed during the
    // sleep). Issuing both in the same microtask is what reproduces the TOCTOU.
    // Before the fix, the busy marker was only set deep inside sendNativePrompt,
    // so this concurrent prompt slipped through and ran on the same session.
    await expect(
      service.sendPrompt(spawned.sessionId, "second"),
    ).rejects.toThrow(/busy/i);
    release?.();
    await p1;
  });
});
