/**
 * Verifies AcpService scratch-dir lifecycle: teardown reclaim + startup GC (#13773).
 * Drives the real closeSession/deleteSession/stopSession/start code paths against
 * an InMemory session store and real dirs on a private TMPDIR; no live model.
 */
import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { InMemorySessionStore } from "../../src/services/session-store.js";
import type { SessionInfo, SessionStatus } from "../../src/services/types.js";

// DEFAULT_WORKDIR_ROOT is `join(tmpdir(), "eliza-acp")`, computed once at module
// load. Point TMPDIR at a private per-run dir BEFORE importing acp-service so the
// scratch root the service GCs is fully isolated from real state on this host,
// then dynamic-import the module against that root.
const TEST_TMPDIR = join(
  tmpdir(),
  `acp-scratch-gc-${process.pid}-${Date.now()}`,
);
let ROOT: string;
let AcpService: typeof import("../../src/services/acp-service.js").AcpService;
let isOwnedScratchDir: typeof import("../../src/services/acp-service.js").isOwnedScratchDir;

beforeAll(async () => {
  process.env.TMPDIR = TEST_TMPDIR;
  await mkdir(TEST_TMPDIR, { recursive: true });
  const mod = await import("../../src/services/acp-service.js");
  AcpService = mod.AcpService;
  isOwnedScratchDir = mod.isOwnedScratchDir;
  ROOT = join(TEST_TMPDIR, "eliza-acp");
}, 30_000);

afterAll(async () => {
  await rm(TEST_TMPDIR, { recursive: true, force: true });
});

beforeEach(async () => {
  await mkdir(ROOT, { recursive: true });
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

function runtime(settings: Record<string, string | undefined> = {}) {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getSetting: vi.fn((key: string) => settings[key]),
    reportError: vi.fn(),
    services: new Map<string, unknown[]>(),
  } as never;
}

function makeService(
  store: InMemorySessionStore,
  settings: Record<string, string | undefined> = {},
): InstanceType<typeof AcpService> {
  return new AcpService(runtime(settings), { store });
}

function session(
  id: string,
  workdir: string,
  status: SessionStatus = "running",
): SessionInfo {
  const now = new Date();
  return {
    id,
    name: id,
    agentType: "elizaos",
    workdir,
    status,
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
  };
}

async function makeDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "scratch.txt"), "work product");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function backdate(path: string, ageMs: number): Promise<void> {
  const past = new Date(Date.now() - ageMs);
  await utimes(path, past, past);
}

// Access the private startup-GC method by its real name — this drives the
// actual implementation, not a stand-in.
function gc(service: InstanceType<typeof AcpService>): Promise<void> {
  return (
    service as unknown as { gcOrphanedScratchDirs(): Promise<void> }
  ).gcOrphanedScratchDirs();
}

describe("isOwnedScratchDir", () => {
  it("owns only task-* dirs directly under the eliza-acp scratch root", () => {
    expect(isOwnedScratchDir(join(ROOT, "task-abc"))).toBe(true);
    // base root itself (isolate=false landed on the shared root)
    expect(isOwnedScratchDir(ROOT)).toBe(false);
    // a sibling, non-task-prefixed dir under the root (e.g. a shared clone)
    expect(isOwnedScratchDir(join(ROOT, "shared-clone"))).toBe(false);
    // a nested grandchild is not a direct child
    expect(isOwnedScratchDir(join(ROOT, "task-abc", "src"))).toBe(false);
    // an explicit / self-checkout workdir outside the scratch root
    expect(isOwnedScratchDir(join(TEST_TMPDIR, "user-repo"))).toBe(false);
    expect(isOwnedScratchDir(process.cwd())).toBe(false);
  });
});

describe("teardown reclaims the owned scratch dir", () => {
  it("closeSession removes the task-<id> dir it created", async () => {
    const store = new InMemorySessionStore();
    const id = "close-1";
    const workdir = join(ROOT, `task-${id}`);
    await makeDir(workdir);
    await store.create(session(id, workdir));
    const service = makeService(store);

    await service.closeSession(id);

    expect(await exists(workdir)).toBe(false);
  });

  it("deleteSession removes the task-<id> dir it created", async () => {
    const store = new InMemorySessionStore();
    const id = "delete-1";
    const workdir = join(ROOT, `task-${id}`);
    await makeDir(workdir);
    await store.create(session(id, workdir));
    const service = makeService(store);

    await service.deleteSession(id);

    expect(await exists(workdir)).toBe(false);
    expect(await store.get(id)).toBeNull();
  });

  it("deleteSession still removes the owned task dir when the best-effort close fails", async () => {
    const store = new InMemorySessionStore();
    const id = "delete-close-fails";
    const workdir = join(ROOT, `task-${id}`);
    await makeDir(workdir);
    await store.create(session(id, workdir));
    const service = makeService(store, { ELIZA_ACP_TRANSPORT: "cli" });
    vi.spyOn(
      service as unknown as {
        runAcpx: InstanceType<typeof AcpService>["runAcpx"];
      },
      "runAcpx",
    ).mockRejectedValueOnce(new Error("simulated close failure"));

    await service.deleteSession(id);

    expect(await exists(workdir)).toBe(false);
    expect(await store.get(id)).toBeNull();
  });

  it("stopSession removes the task-<id> dir it created", async () => {
    const store = new InMemorySessionStore();
    const id = "stop-1";
    const workdir = join(ROOT, `task-${id}`);
    await makeDir(workdir);
    await store.create(session(id, workdir));
    const service = makeService(store);

    await service.stopSession(id);

    expect(await exists(workdir)).toBe(false);
  });

  it("never removes a user-supplied workdir the service does not own", async () => {
    const store = new InMemorySessionStore();
    // An opt-in / route / self-checkout workdir outside the scratch root.
    const userWorkdir = join(TEST_TMPDIR, "user-workspace-keepme");
    await makeDir(userWorkdir);
    await store.create(session("user-1", userWorkdir));
    // A dir INSIDE the scratch root but not a task-* dir (e.g. a shared clone).
    const sharedClone = join(ROOT, "shared-clone");
    await makeDir(sharedClone);
    await store.create(session("shared-1", sharedClone));
    const service = makeService(store);

    await service.closeSession("user-1");
    await service.deleteSession("shared-1");

    expect(await exists(userWorkdir)).toBe(true);
    expect(await exists(sharedClone)).toBe(true);
  });
});

describe("startup GC reclaims orphaned scratch dirs", () => {
  it("reclaims a dir whose session is terminal in the store", async () => {
    const store = new InMemorySessionStore();
    const id = "term-1";
    const workdir = join(ROOT, `task-${id}`);
    await makeDir(workdir);
    await store.create(session(id, workdir, "errored"));
    const service = makeService(store);

    await gc(service);

    expect(await exists(workdir)).toBe(false);
  });

  it("keeps a dir with a live (non-terminal) session", async () => {
    const store = new InMemorySessionStore();
    const liveId = "live-1";
    const liveDir = join(ROOT, `task-${liveId}`);
    await makeDir(liveDir);
    await store.create(session(liveId, liveDir, "running"));

    const deadId = "dead-1";
    const deadDir = join(ROOT, `task-${deadId}`);
    await makeDir(deadDir);
    await store.create(session(deadId, deadDir, "stopped"));

    const service = makeService(store);
    await gc(service);

    expect(await exists(liveDir)).toBe(true);
    expect(await exists(deadDir)).toBe(false);
  });

  it("reclaims an untracked stale dir but keeps a fresh untracked dir", async () => {
    const store = new InMemorySessionStore();
    // No sessions at all: both dirs are untracked (crashed before store.create,
    // or a co-tenant's). Age-gate: only the stale one is reclaimed.
    const staleDir = join(ROOT, "task-orphan-stale");
    await makeDir(staleDir);
    await backdate(staleDir, 25 * 60 * 60_000); // 25h — past the 24h floor

    const freshDir = join(ROOT, "task-orphan-fresh");
    await makeDir(freshDir);

    const service = makeService(store);
    await gc(service);

    expect(await exists(staleDir)).toBe(false);
    expect(await exists(freshDir)).toBe(true);
  });

  it("honors ELIZA_ACP_SCRATCH_GC_MAX_AGE_MS for the untracked age gate", async () => {
    const store = new InMemorySessionStore();
    const dir = join(ROOT, "task-orphan-config");
    await makeDir(dir);
    await backdate(dir, 5_000); // 5s old
    const service = makeService(store, {
      ELIZA_ACP_SCRATCH_GC_MAX_AGE_MS: "1000", // 1s floor
    });

    await gc(service);

    expect(await exists(dir)).toBe(false);
  });

  it("start() reclaims a task dir orphaned by a SIGKILL mid-run", async () => {
    // Simulate a crash: a session left 'running' in the store with its scratch
    // dir on disk and no live subprocess. On restart, reconcile marks it
    // terminal and the startup GC reclaims the dir.
    const store = new InMemorySessionStore();
    const id = "kill-1";
    const workdir = join(ROOT, `task-${id}`);
    await makeDir(workdir);
    await store.create(session(id, workdir, "running"));
    const service = makeService(store);

    await service.start();
    try {
      expect(await exists(workdir)).toBe(false);
    } finally {
      await service.stop();
    }
  });
});
