/**
 * Shared workspace registry + disk-backpressure primitives (#13773).
 * Pure/deterministic: real registry state, real statfs against the OS tmpdir.
 */

import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  _resetWorkspaceRegistry,
  checkDiskBudget,
  DEFAULT_MIN_FREE_DISK_BYTES,
  DEFAULT_WORKSPACE_MAX_ENTRIES,
  freeDiskBytes,
  liveWorkspacePaths,
  markWorkspaceTerminated,
  registeredWorkspaces,
  registerWorkspace,
  unregisterWorkspace,
} from "../../src/services/workspace-registry.js";

afterEach(() => _resetWorkspaceRegistry());

describe("workspace registry membership", () => {
  it("registers, keys by resolved path, and is idempotent", () => {
    registerWorkspace("/tmp/eliza-acp/task-a", "sess-a", "acp-scratch");
    registerWorkspace("/tmp/eliza-acp/task-a", "sess-a", "acp-scratch");
    expect(registeredWorkspaces()).toHaveLength(1);
    expect(registeredWorkspaces()[0].path).toBe(
      path.resolve("/tmp/eliza-acp/task-a"),
    );
    expect(registeredWorkspaces()[0].ownerId).toBe("sess-a");
  });

  it("unregister drops the entry", () => {
    registerWorkspace("/tmp/eliza-acp/task-a", "sess-a", "acp-scratch");
    unregisterWorkspace("/tmp/eliza-acp/task-a");
    expect(registeredWorkspaces()).toHaveLength(0);
  });

  it("live set excludes terminated owners but keeps the entry", () => {
    registerWorkspace("/tmp/eliza-acp/task-a", "sess-a", "acp-scratch");
    registerWorkspace("/tmp/eliza-acp/task-b", "sess-b", "acp-scratch");
    markWorkspaceTerminated("/tmp/eliza-acp/task-a");
    const live = liveWorkspacePaths();
    expect(live.has(path.resolve("/tmp/eliza-acp/task-b"))).toBe(true);
    expect(live.has(path.resolve("/tmp/eliza-acp/task-a"))).toBe(false);
    // Entry survives so GC can still see it as a reclaim candidate.
    expect(registeredWorkspaces()).toHaveLength(2);
  });
});

describe("disk backpressure", () => {
  it("freeDiskBytes returns a positive number for a real dir", async () => {
    const free = await freeDiskBytes(os.tmpdir());
    expect(free).not.toBeNull();
    expect(free as number).toBeGreaterThan(0);
  });

  it("passes when under cap and disk floor is satisfiable", async () => {
    const verdict = await checkDiskBudget(os.tmpdir(), {
      minFreeDiskBytes: 1, // any real tmpdir has ≥ 1 byte free
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.overCap).toBe(false);
  });

  it("refuses (overCap) once the workspace count reaches the cap", async () => {
    for (let i = 0; i < DEFAULT_WORKSPACE_MAX_ENTRIES; i++) {
      registerWorkspace(`/tmp/eliza-acp/task-${i}`, `sess-${i}`, "acp-scratch");
    }
    const verdict = await checkDiskBudget(os.tmpdir(), { minFreeDiskBytes: 1 });
    expect(verdict.ok).toBe(false);
    expect(verdict.overCap).toBe(true);
    expect(verdict.reason).toContain("cap");
  });

  it("returns terminated entries oldest-first as eviction candidates", async () => {
    registerWorkspace("/tmp/eliza-acp/task-old", "old", "acp-scratch");
    // Force a distinct createdAt ordering.
    await new Promise((r) => setTimeout(r, 2));
    registerWorkspace("/tmp/eliza-acp/task-new", "new", "acp-scratch");
    markWorkspaceTerminated("/tmp/eliza-acp/task-new");
    markWorkspaceTerminated("/tmp/eliza-acp/task-old");
    const verdict = await checkDiskBudget(os.tmpdir(), { minFreeDiskBytes: 1 });
    expect(verdict.evictable.map((e) => e.ownerId)).toEqual(["old", "new"]);
  });

  it("refuses when the free-disk floor is unreachably high", async () => {
    const verdict = await checkDiskBudget(os.tmpdir(), {
      minFreeDiskBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.overCap).toBe(false);
    expect(verdict.reason).toContain("free disk");
  });

  it("does not block when free-disk reading is unavailable (null)", async () => {
    // A non-existent path makes statfs fail → null → treated as "unknown, allow".
    const verdict = await checkDiskBudget(
      path.join(os.tmpdir(), "definitely-not-here-xyz-13773"),
      { minFreeDiskBytes: DEFAULT_MIN_FREE_DISK_BYTES },
    );
    expect(verdict.ok).toBe(true);
  });
});
