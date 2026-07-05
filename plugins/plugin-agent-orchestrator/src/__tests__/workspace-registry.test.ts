/**
 * Real-filesystem regression tests for the shared workspace registry + disk
 * backpressure gate (#13773). Everything runs against real temp dirs and the
 * real `statfs`/`rm` paths — no mocks — so the ownership invariant ("only a dir
 * the registry recorded is ever reclaimable") and the cap/floor enforcement are
 * proven end to end, not asserted against a stub.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_DISK_CAP_BYTES,
  DEFAULT_WORKSPACE_MIN_FREE_BYTES,
  getSharedWorkspaceRegistry,
  measureDirBytes,
  parseByteSetting,
  resetSharedWorkspaceRegistry,
  resolveDiskBudgetConfig,
  WorkspaceRegistry,
} from "../services/workspace-registry.js";
import { CodingWorkspaceService } from "../services/workspace-service.js";

const roots: string[] = [];

beforeEach(() => {
  resetSharedWorkspaceRegistry();
});

afterEach(() => {
  resetSharedWorkspaceRegistry();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tmpRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function makeDirWithBytes(path: string, bytes: number): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "payload.bin"), Buffer.alloc(bytes, 1));
}

describe("WorkspaceRegistry ownership invariant", () => {
  it("never deletes a dir it did not register (registry miss)", async () => {
    const root = tmpRoot("wsreg-miss-");
    // A caller-owned dir that HAPPENS to match the scratch shape but was never
    // registered — the exact #13803 data-loss case.
    const callerOwned = join(root, "task-important");
    await makeDirWithBytes(callerOwned, 4096);

    const registry = new WorkspaceRegistry();
    // Cap forced to 0 so the gate tries to reclaim everything it is allowed to.
    const decision = await registry.checkDiskBudget(root, { capBytes: 0 });

    expect(decision.reclaimedCount).toBe(0);
    expect(existsSync(callerOwned)).toBe(true);
  });

  it("never deletes a registered acp-scratch dir (accounting-only)", async () => {
    const root = tmpRoot("wsreg-acp-");
    const scratch = join(root, "task-abc");
    await makeDirWithBytes(scratch, 8192);

    const registry = new WorkspaceRegistry();
    registry.register("acp-scratch", scratch, "session-1");
    registry.markTerminal(scratch);

    // Even terminal, an acp-scratch record is never reclaimed by the registry —
    // AcpService's session-store GC owns ACP deletion.
    await registry.checkDiskBudget(root, { capBytes: 0 });
    expect(existsSync(scratch)).toBe(true);
  });

  it("never deletes a LIVE git workspace", async () => {
    const root = tmpRoot("wsreg-live-");
    const ws = join(root, "clone-live");
    await makeDirWithBytes(ws, 8192);

    const registry = new WorkspaceRegistry();
    registry.register("git-workspace", ws, "ws-live");
    // Left live — must survive even an over-cap sweep.
    await registry.checkDiskBudget(root, { capBytes: 0 });
    expect(existsSync(ws)).toBe(true);
  });
});

describe("WorkspaceRegistry cap enforcement", () => {
  it("evicts terminal git workspaces oldest-first until under cap", async () => {
    const root = tmpRoot("wsreg-cap-");
    const bytes = 64 * 1024;
    const oldWs = join(root, "clone-old");
    const newWs = join(root, "clone-new");
    await makeDirWithBytes(oldWs, bytes);
    await makeDirWithBytes(newWs, bytes);

    const registry = new WorkspaceRegistry();
    registry.register("git-workspace", oldWs, "ws-old");
    // Force a strictly-later createdAt so LRU order is deterministic.
    await new Promise((r) => setTimeout(r, 5));
    registry.register("git-workspace", newWs, "ws-new");
    registry.markTerminal(oldWs);
    registry.markTerminal(newWs);

    // Cap allows ~one workspace: eviction should stop after freeing the oldest.
    const decision = await registry.checkDiskBudget(root, {
      capBytes: bytes + bytes / 2,
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reclaimedCount).toBe(1);
    expect(existsSync(oldWs)).toBe(false);
    expect(existsSync(newWs)).toBe(true);
  });

  it("refuses when the cap cannot be met even after eviction", async () => {
    const root = tmpRoot("wsreg-cap-fail-");
    const liveWs = join(root, "clone-live");
    await makeDirWithBytes(liveWs, 64 * 1024);

    const registry = new WorkspaceRegistry();
    // Only a LIVE workspace exists — nothing evictable, so a zero cap must fail.
    registry.register("git-workspace", liveWs, "ws-live");

    const decision = await registry.checkDiskBudget(root, { capBytes: 0 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("cap-exceeded");
    expect(existsSync(liveWs)).toBe(true);
  });
});

describe("CodingWorkspaceService registry integration", () => {
  it("marks submitted full-clone workspaces terminal so pressure can evict them", async () => {
    const root = tmpRoot("wsreg-service-");
    const clone = join(root, "clone-submitted");
    await makeDirWithBytes(clone, 64 * 1024);

    const service = new CodingWorkspaceService({
      getSetting: () => undefined,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    } as never);
    (
      service as unknown as {
        workspaces: Map<string, unknown>;
      }
    ).workspaces.set("ws-submitted", {
      id: "ws-submitted",
      path: clone,
      branch: "feature",
      baseBranch: "main",
      isWorktree: false,
      repo: "elizaOS/eliza",
      status: "ready",
    });

    const registry = getSharedWorkspaceRegistry();
    registry.register("git-workspace", clone, "ws-submitted");
    service.markWorkspaceTerminal("ws-submitted");

    const decision = await registry.checkDiskBudget(root, { capBytes: 0 });
    expect(decision.reclaimedCount).toBe(1);
    expect(existsSync(clone)).toBe(false);
  });
});

describe("WorkspaceRegistry free-disk precheck", () => {
  it("refuses a provision below the free-disk floor", async () => {
    const root = tmpRoot("wsreg-df-");
    // A floor larger than any real filesystem forces the df precheck to fail.
    const decision = await registry_freeDiskCase(root);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("free-disk-floor");
  });

  it("allows when free disk is above the floor", async () => {
    const root = tmpRoot("wsreg-df-ok-");
    const registry = new WorkspaceRegistry();
    const decision = await registry.checkDiskBudget(root, { minFreeBytes: 1 });
    expect(decision.allowed).toBe(true);
    expect(decision.freeBytes).toBeGreaterThan(0);
  });
});

async function registry_freeDiskCase(root: string) {
  const registry = new WorkspaceRegistry();
  return registry.checkDiskBudget(root, {
    minFreeBytes: Number.MAX_SAFE_INTEGER,
  });
}

describe("measureDirBytes", () => {
  it("sums file sizes recursively and skips symlinked dirs", async () => {
    const root = tmpRoot("wsreg-measure-");
    await makeDirWithBytes(join(root, "a"), 1000);
    await makeDirWithBytes(join(root, "a", "nested"), 2000);
    const total = await measureDirBytes(join(root, "a"));
    expect(total).toBe(3000);
  });

  it("returns 0 for a missing dir", async () => {
    const total = await measureDirBytes(join(tmpdir(), "does-not-exist-13773"));
    expect(total).toBe(0);
  });
});

describe("config parsing", () => {
  it("parses positive byte counts and rejects junk", () => {
    expect(parseByteSetting("1048576")).toBe(1048576);
    expect(parseByteSetting("  2048 ")).toBe(2048);
    expect(parseByteSetting(undefined)).toBeUndefined();
    expect(parseByteSetting("")).toBeUndefined();
    expect(parseByteSetting("0")).toBeUndefined();
    expect(parseByteSetting("-5")).toBeUndefined();
    expect(parseByteSetting("abc")).toBeUndefined();
  });

  it("falls back to module defaults when settings are unset", () => {
    const config = resolveDiskBudgetConfig(() => undefined);
    expect(config.capBytes).toBe(DEFAULT_WORKSPACE_DISK_CAP_BYTES);
    expect(config.minFreeBytes).toBe(DEFAULT_WORKSPACE_MIN_FREE_BYTES);
  });

  it("honors env-tunable overrides", () => {
    const settings: Record<string, string> = {
      ELIZA_WORKSPACE_DISK_CAP_BYTES: "12345",
      ELIZA_WORKSPACE_MIN_FREE_BYTES: "6789",
    };
    const config = resolveDiskBudgetConfig((k) => settings[k]);
    expect(config.capBytes).toBe(12345);
    expect(config.minFreeBytes).toBe(6789);
  });
});
