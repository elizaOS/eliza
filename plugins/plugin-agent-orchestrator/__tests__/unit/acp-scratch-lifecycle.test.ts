/**
 * ACP scratch-dir disk lifecycle regression tests (#13773 — the 3.6TB-class
 * leak). Drives the real AcpService over a mocked native transport (no live
 * subprocess) against a real on-disk scratch root, asserting: terminal events
 * delete the per-session dir, a SIGKILL-mid-teardown leak is reclaimed by
 * startup GC, and neither teardown nor GC ever touches a live session's dir or
 * anything outside the resolved root.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type NativeOptions = { onEvent?: (event: unknown, sid?: string) => void };
type MockNativeClient = {
  start: ReturnType<typeof vi.fn>;
  createSession: ReturnType<typeof vi.fn>;
  prompt: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  closeSession: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  approvesPermissionRequest: ReturnType<typeof vi.fn>;
  setEventHandler: (h: unknown) => void;
  setTimeoutMs: (ms: number | undefined) => void;
};

const nativeInstances: MockNativeClient[] = [];

vi.mock("../../src/services/acp-native-transport.js", () => ({
  NativeAcpClient: class {
    constructor(_opts: NativeOptions) {
      nativeInstances.push(this as unknown as MockNativeClient);
    }
    start = vi.fn(async () => undefined);
    createSession = vi.fn(async () => ({
      sessionId: "proto-session",
      agentSessionId: "agent-session",
    }));
    prompt = vi.fn(async () => ({ stopReason: "end_turn" }));
    cancel = vi.fn(async () => undefined);
    closeSession = vi.fn(async () => undefined);
    close = vi.fn(async () => undefined);
    approvesPermissionRequest = vi.fn(() => true);
    setEventHandler = vi.fn();
    setTimeoutMs = vi.fn();
  },
}));

// git is unavailable in this harness — make baseline/diff capture degrade
// instead of hanging on the promisified execFile.
vi.mock("node:child_process", () => ({
  exec: vi.fn(),
  execFile: vi.fn(
    (
      _f: string,
      _a: string[],
      opts: unknown,
      cb?: (e: Error | null, o: string, s: string) => void,
    ) => {
      const callback = typeof opts === "function" ? opts : cb;
      if (typeof callback === "function")
        callback(new Error("git unavailable"), "", "");
    },
  ),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 1, stdout: "", stderr: "" })),
  spawn: vi.fn(),
}));

import { AcpService } from "../../src/services/acp-service.js";
import { _resetWorkspaceRegistry } from "../../src/services/workspace-registry.js";

let scratchRoot: string;

function runtime(extra: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    ELIZA_ACP_TRANSPORT: "native",
    ELIZA_WORKSPACE_DIR: scratchRoot,
    ...extra,
  };
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getSetting: vi.fn((k: string) => values[k]),
    reportError: vi.fn(),
    services: new Map<string, unknown[]>(),
  } as never;
}

beforeEach(() => {
  nativeInstances.length = 0;
  _resetWorkspaceRegistry();
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "acp-scratch-"));
});

afterEach(() => {
  _resetWorkspaceRegistry();
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

/** task-* subdirs that actually exist under the scratch root. */
function leakedTaskDirs(): string[] {
  if (!fs.existsSync(scratchRoot)) return [];
  return fs
    .readdirSync(scratchRoot)
    .filter((n) => n.startsWith("task-"))
    .filter((n) => fs.statSync(path.join(scratchRoot, n)).isDirectory());
}

describe("ACP scratch-dir lifecycle", () => {
  it("spawn/close of N sessions leaves zero leaked scratch dirs", async () => {
    const service = new AcpService(runtime());
    await service.start();

    const N = 5;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const spawned = await service.spawnSession({
        name: `task-${i}`,
        agentType: "codex",
      });
      ids.push(spawned.sessionId);
    }
    // Each isolated spawn created its own task-<id> dir.
    expect(leakedTaskDirs()).toHaveLength(N);

    for (const id of ids) await service.closeSession(id);

    expect(leakedTaskDirs()).toHaveLength(0);
    await service.stop();
  });

  it("deleteSession removes the scratch dir even without a prior close", async () => {
    const service = new AcpService(runtime());
    await service.start();
    const spawned = await service.spawnSession({
      name: "to-delete",
      agentType: "codex",
    });
    expect(leakedTaskDirs()).toHaveLength(1);
    await service.deleteSession(spawned.sessionId);
    expect(leakedTaskDirs()).toHaveLength(0);
    await service.stop();
  });

  it("startup GC reclaims an orphaned dir left by a kill-mid-teardown", async () => {
    // Simulate a process that spawned a session, wrote its scratch dir, then was
    // SIGKILLed before closeSession could remove it AND before its store row
    // survived — i.e. a bare aged task-* dir with no live owner.
    const orphan = path.join(scratchRoot, "task-orphaned-abc");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "junk.txt"), "leaked bytes");
    // Backdate it past the TTL so GC treats it as reclaimable.
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(orphan, old, old);
    expect(fs.existsSync(orphan)).toBe(true);

    // start() runs gcOrphanedScratchDirs — with an empty store + empty registry
    // the orphan has no live owner and is older than TTL, so it is reclaimed.
    const service = new AcpService(runtime());
    await service.start();

    expect(fs.existsSync(orphan)).toBe(false);
    await service.stop();
  });

  it("GC never touches a live session's dir or a young orphan", async () => {
    const service = new AcpService(runtime());
    await service.start();

    // A genuinely live, running session.
    const live = await service.spawnSession({
      name: "live",
      agentType: "codex",
    });
    const liveDir = path.join(scratchRoot, `task-${live.sessionId}`);
    fs.utimesSync(
      liveDir,
      new Date(Date.now() - 48 * 60 * 60 * 1000),
      new Date(Date.now() - 48 * 60 * 60 * 1000),
    );

    // A recent orphan (younger than TTL) — must be kept.
    const young = path.join(scratchRoot, "task-young-orphan");
    fs.mkdirSync(young, { recursive: true });

    // Force a GC pass via the private method.
    await (
      service as unknown as { gcOrphanedScratchDirs: () => Promise<void> }
    ).gcOrphanedScratchDirs();

    // Live session's dir survives despite being aged (it is in the live set).
    expect(fs.existsSync(liveDir)).toBe(true);
    // Young orphan survives (under TTL).
    expect(fs.existsSync(young)).toBe(true);
    await service.stop();
  });

  it("never deletes a caller-provided cwd (non-isolated) dir on close", async () => {
    const service = new AcpService(runtime());
    await service.start();
    // A real repo checkout the caller passed verbatim (isolate=false).
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "acp-repo-"));
    fs.writeFileSync(path.join(repo, "keep.txt"), "important");
    try {
      const spawned = await service.spawnSession({
        name: "self-checkout",
        agentType: "codex",
        workdir: repo,
        isolateWorkdir: false,
      });
      await service.closeSession(spawned.sessionId);
      // The caller's dir and its contents are untouched.
      expect(fs.existsSync(path.join(repo, "keep.txt"))).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
    await service.stop();
  });
});
