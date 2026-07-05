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
    const oldOrphan = join(root, "task-old-orphan");
    const tracked = join(root, "task-tracked");
    const fresh = join(root, "task-fresh");
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
      makeSession("tracked", tracked, {
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
});
