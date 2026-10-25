import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { AcpService, computeSessionWorkdir } from "../services/acp-service.js";
import { InMemorySessionStore } from "../services/session-store.js";
import type { SessionInfo } from "../services/types.js";

type ScratchLifecycleShim = {
  removeOwnedScratchWorkdir(session: SessionInfo): Promise<void>;
  cleanOrphanedScratchWorkdirs(): Promise<void>;
};

function makeRuntime(settings: Record<string, string> = {}): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-00000013773a",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    reportError() {},
    getSetting: (key: string) => settings[key],
  } as never;
}

function makeSession(
  id: string,
  workdir: string,
  metadata?: Record<string, unknown>,
): SessionInfo {
  const now = new Date();
  return {
    id,
    name: id,
    agentType: "codex",
    workdir,
    status: "running",
    approvalPreset: "on-request",
    createdAt: now,
    lastActivityAt: now,
    metadata,
  };
}

describe("ACP scratch workspace lifecycle", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes only metadata-owned isolated task workdirs", async () => {
    const root = mkdtempSync(join(tmpdir(), "acp-scratch-owned-"));
    roots.push(root);
    const owned = computeSessionWorkdir(root, "owned", true);
    const unowned = join(root, "manual");
    await mkdir(owned, { recursive: true });
    await mkdir(unowned, { recursive: true });
    const service = new AcpService(makeRuntime(), {
      store: new InMemorySessionStore(),
    });
    const shim = service as unknown as ScratchLifecycleShim;

    await shim.removeOwnedScratchWorkdir(
      makeSession("owned", owned, {
        isolatedWorkdir: true,
        workdirRoot: root,
      }),
    );
    await shim.removeOwnedScratchWorkdir(makeSession("manual", unowned));

    expect(existsSync(owned)).toBe(false);
    expect(existsSync(unowned)).toBe(true);
  });

  it("garbage-collects old untracked task dirs but keeps tracked and fresh dirs", async () => {
    const root = mkdtempSync(join(tmpdir(), "acp-scratch-gc-"));
    roots.push(root);
    const store = new InMemorySessionStore();
    const service = new AcpService(
      makeRuntime({ ELIZA_ACP_WORKSPACE_ROOT: root }),
      {
        store,
      },
    );
    const shim = service as unknown as ScratchLifecycleShim;
    // Real scratch dirs are always `task-<randomUUID()>`; only that shape may
    // ever be reclaimed.
    const trackedId = "11111111-2222-4333-8444-555555555555";
    const oldOrphan = join(root, "task-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
    const tracked = join(root, `task-${trackedId}`);
    const fresh = join(root, "task-99999999-8888-4777-8666-555555555544");
    const manual = join(root, "manual-old");
    await Promise.all([
      mkdir(oldOrphan, { recursive: true }),
      mkdir(tracked, { recursive: true }),
      mkdir(fresh, { recursive: true }),
      mkdir(manual, { recursive: true }),
    ]);
    const oldDate = new Date(Date.now() - 48 * 60 * 60_000);
    await Promise.all([
      utimes(oldOrphan, oldDate, oldDate),
      utimes(manual, oldDate, oldDate),
    ]);
    await store.create(
      makeSession(trackedId, tracked, {
        isolatedWorkdir: true,
        workdirRoot: root,
      }),
    );

    await shim.cleanOrphanedScratchWorkdirs();

    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(tracked)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(manual)).toBe(true);
  });

  it("never reclaims human-named task-* dirs or non-isolated sessions' real workdirs under a workspace root", async () => {
    // The false-positive class from #13895: workspace roots double as scratch
    // roots, so a user repo named `task-master` (48h idle) and a real repo a
    // NON-isolated terminal session ran inside must both survive boot GC.
    const root = mkdtempSync(join(tmpdir(), "acp-scratch-guard-"));
    roots.push(root);
    const store = new InMemorySessionStore();
    const service = new AcpService(makeRuntime({ ELIZA_WORKSPACE_DIR: root }), {
      store,
    });
    const shim = service as unknown as ScratchLifecycleShim;
    const humanRepo = join(root, "task-master");
    const untrackedUuidNamedRepo = join(
      root,
      "task-dddddddd-5555-4666-8777-eeeeeeeeeeee",
    );
    const nonIsolatedId = "aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb";
    const nonIsolatedRepo = join(root, `task-${nonIsolatedId}`);
    const ownedId = "cccccccc-4444-4555-8666-dddddddddddd";
    const ownedScratch = join(root, `task-${ownedId}`);
    await Promise.all([
      mkdir(humanRepo, { recursive: true }),
      mkdir(untrackedUuidNamedRepo, { recursive: true }),
      mkdir(nonIsolatedRepo, { recursive: true }),
      mkdir(ownedScratch, { recursive: true }),
    ]);
    const oldDate = new Date(Date.now() - 48 * 60 * 60_000);
    await Promise.all([
      utimes(humanRepo, oldDate, oldDate),
      utimes(untrackedUuidNamedRepo, oldDate, oldDate),
    ]);
    const nonIsolated = makeSession(nonIsolatedId, nonIsolatedRepo, {
      isolatedWorkdir: false,
    });
    nonIsolated.status = "stopped";
    await store.create(nonIsolated);
    const owned = makeSession(ownedId, ownedScratch, {
      isolatedWorkdir: true,
      workdirRoot: root,
    });
    owned.status = "stopped";
    await store.create(owned);

    await shim.cleanOrphanedScratchWorkdirs();

    // Human-named repo: filtered out by the UUID-shape match despite age.
    expect(existsSync(humanRepo)).toBe(true);
    // UUID-shaped but untracked under a user root: name alone is not ownership.
    expect(existsSync(untrackedUuidNamedRepo)).toBe(true);
    // Terminal but NOT isolation-owned: the ownership gate keeps it.
    expect(existsSync(nonIsolatedRepo)).toBe(true);
    // Terminal AND isolation-owned: reclaimed regardless of age.
    expect(existsSync(ownedScratch)).toBe(false);
  });
});
