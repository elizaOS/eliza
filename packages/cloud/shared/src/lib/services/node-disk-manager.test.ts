/**
 * Tests for the node disk clean manager. Mirrors the orphan-reconciler test
 * style: the pure decisions (`parseDfUsedPercent`, `decideDiskAction`,
 * `diskHealthVerdict`, `buildReclaimCommand`) are exercised exhaustively with no
 * I/O, and `cleanupNodeDisks` is driven through fake `DiskNode`s so the only
 * mocked boundary is the SSH node-exec (`readDiskUsage` / `reclaim`).
 *
 * The invariants pinned here:
 *   - below the prune threshold → SKIP (never prune)
 *   - at/above threshold but inside the cooldown → SKIP (no prune-every-tick)
 *   - at/above threshold and cooled down → PRUNE, and the cooldown is armed
 *   - a node whose df read fails is SKIPPED (never reclaimed off a misread)
 *   - non-healthy nodes are never touched
 *   - disk-aware health: critical only at/above the unhealthy mark; a null
 *     (failed) read is `ok` so disk never owns reachability
 *   - the reclaim command omits `--volumes` and clears containerd ingest
 */

import { describe, expect, mock, test } from "bun:test";
import {
  buildReclaimCommand,
  buildStaleAgentImagePruneCommand,
  cleanupNodeDisks,
  type DiskNode,
  type DiskUsage,
  decideDiskAction,
  diskHealthVerdict,
  parseDfUsedPercent,
} from "./node-disk-manager";

// ---------------------------------------------------------------------------
// parseDfUsedPercent
// ---------------------------------------------------------------------------

describe("parseDfUsedPercent", () => {
  test("reads the Capacity column from a standard df -P output", () => {
    const out = [
      "Filesystem     1024-blocks      Used  Available Capacity Mounted on",
      "/dev/sda1        164006240 142000000   13606240      92% /",
    ].join("\n");
    expect(parseDfUsedPercent(out)).toBe(92);
  });

  test("ignores [stderr]-prefixed lines from the SSH client", () => {
    const out = [
      "[stderr] df: /var/lib/docker: some warning",
      "Filesystem     1024-blocks  Used Available Capacity Mounted on",
      "overlay         100000000 80000000  20000000      80% /var/lib/docker",
    ].join("\n");
    expect(parseDfUsedPercent(out)).toBe(80);
  });

  test("returns null when no percentage field is present", () => {
    expect(parseDfUsedPercent("no df output here")).toBeNull();
    expect(parseDfUsedPercent("")).toBeNull();
  });

  test("rejects an out-of-range percent", () => {
    // A malformed line with a >100 number followed by % should not parse to it.
    expect(parseDfUsedPercent("Filesystem ... 250% /")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// decideDiskAction (the prune decision)
// ---------------------------------------------------------------------------

describe("decideDiskAction", () => {
  const base = {
    pruneThresholdPct: 80,
    cooldownMs: 30 * 60_000,
    now: 1_000_000,
  };

  test("below the threshold → skip_below_threshold (never prune)", () => {
    const action = decideDiskAction({ ...base, usedPercent: 79, lastPrunedAt: null });
    expect(action.kind).toBe("skip_below_threshold");
  });

  test("at the threshold and never pruned → prune", () => {
    const action = decideDiskAction({ ...base, usedPercent: 80, lastPrunedAt: null });
    expect(action.kind).toBe("prune");
  });

  test("above the threshold but inside cooldown → skip_cooldown", () => {
    const action = decideDiskAction({
      ...base,
      usedPercent: 95,
      lastPrunedAt: base.now - 60_000, // pruned 1 min ago, cooldown is 30 min
    });
    expect(action.kind).toBe("skip_cooldown");
  });

  test("above the threshold and cooldown elapsed → prune", () => {
    const action = decideDiskAction({
      ...base,
      usedPercent: 95,
      lastPrunedAt: base.now - (base.cooldownMs + 1), // cooldown just elapsed
    });
    expect(action.kind).toBe("prune");
  });
});

// ---------------------------------------------------------------------------
// diskHealthVerdict (the disk-aware health verdict)
// ---------------------------------------------------------------------------

describe("diskHealthVerdict", () => {
  test("below the unhealthy mark → ok", () => {
    expect(diskHealthVerdict(91, 92)).toBe("ok");
  });

  test("at/above the unhealthy mark → critical", () => {
    expect(diskHealthVerdict(92, 92)).toBe("critical");
    expect(diskHealthVerdict(99, 92)).toBe("critical");
  });

  test("a failed df read (null) is ok — disk never owns reachability", () => {
    expect(diskHealthVerdict(null, 92)).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// buildReclaimCommand (the reclamation shell command)
// ---------------------------------------------------------------------------

describe("buildReclaimCommand", () => {
  const cmd = buildReclaimCommand();

  test("prunes the docker system WITHOUT --volumes (agent volumes preserved)", () => {
    expect(cmd).toContain("docker system prune -af");
    expect(cmd).not.toContain("--volumes");
  });

  test("clears stuck containerd ingest (the actual failed-pull junk)", () => {
    expect(cmd).toContain("io.containerd.content.v1.content/ingest");
    expect(cmd).toContain("-delete");
  });

  test("prunes the buildkit cache too", () => {
    expect(cmd).toContain("docker builder prune -af");
  });
});

describe("buildStaleAgentImagePruneCommand", () => {
  const cmd = buildStaleAgentImagePruneCommand({
    repository: "ghcr.io/elizaos/eliza",
    keepNewest: 2,
    maxAgeHours: 168,
  });

  test("targets only the configured managed-agent image repository", () => {
    expect(cmd).toContain("repo='ghcr.io/elizaos/eliza'");
    expect(cmd).toContain('docker image ls "$repo"');
    expect(cmd).not.toContain("docker image prune");
    expect(cmd).not.toContain("--volumes");
  });

  test("preserves active image IDs and newest rollback refs", () => {
    expect(cmd).toContain("docker ps -a --format '{{.Image}}'");
    expect(cmd).toContain("grep -qxF");
    expect(cmd).toContain("keep_newest=2");
    expect(cmd).toContain("max_age_hours=168");
  });

  test("requires an explicit repository", () => {
    expect(() =>
      buildStaleAgentImagePruneCommand({
        repository: " ",
        keepNewest: 2,
        maxAgeHours: 168,
      }),
    ).toThrow("repository is required");
  });
});

// ---------------------------------------------------------------------------
// cleanupNodeDisks (orchestration over the mocked node-exec boundary)
// ---------------------------------------------------------------------------

/** Build a fake DiskNode whose df reads and reclaim are mocked. */
function fakeNode(
  overrides: Partial<DiskNode> & {
    usage?: DiskUsage | null;
    afterUsage?: DiskUsage | null;
    reclaimThrows?: boolean;
    stalePruneThrows?: boolean;
  } = {},
): DiskNode {
  // Distinguish "explicitly null" (df read failed) from "not provided" — `??`
  // would coerce an intentional null back to the default.
  const usage = "usage" in overrides ? overrides.usage : { usedPercent: 85 };
  const afterUsage = "afterUsage" in overrides ? overrides.afterUsage : { usedPercent: 40 };
  const readDiskUsage = mock(async () => usage ?? null);
  const reclaim = mock(async () => {
    if (overrides.reclaimThrows) throw new Error("reclaim failed over ssh");
    return afterUsage ?? null;
  });
  const pruneStaleAgentImages = mock(async () => {
    if (overrides.stalePruneThrows) throw new Error("stale image prune failed over ssh");
  });
  return {
    node_id: overrides.node_id ?? "node-a",
    hostname: overrides.hostname ?? "10.0.0.1",
    status: overrides.status ?? "healthy",
    readDiskUsage,
    reclaim,
    pruneStaleAgentImages,
  };
}

const cfg = (
  now: number,
  cooldown = new Map<string, number>(),
  staleCooldown = new Map<string, number>(),
) => ({
  pruneThresholdPct: 80,
  cooldownMs: 30 * 60_000,
  now: () => now,
  lastPrunedAt: cooldown,
  staleAgentImagePrune: {
    repository: "ghcr.io/elizaos/eliza",
    keepNewest: 2,
    maxAgeHours: 168,
    intervalMs: 24 * 60 * 60_000,
    lastPrunedAt: staleCooldown,
  },
});

describe("cleanupNodeDisks", () => {
  test("prunes a healthy node above the threshold and reports reclaimed space", async () => {
    const node = fakeNode({ usage: { usedPercent: 90 }, afterUsage: { usedPercent: 45 } });
    const report = await cleanupNodeDisks([node], cfg(1_000_000));

    expect(node.reclaim).toHaveBeenCalledTimes(1);
    expect(node.pruneStaleAgentImages).toHaveBeenCalledTimes(1);
    expect(report.pruned).toBe(1);
    expect(report.staleAgentImagePruned).toBe(1);
    expect(report.nodesScanned).toBe(1);
    expect(report.details[0]).toMatchObject({
      action: "prune",
      staleAgentImageAction: "prune",
      usedPercentBefore: 90,
      usedPercentAfter: 45,
      reclaimedPercent: 45,
    });
  });

  test("does NOT prune a node below the threshold", async () => {
    const node = fakeNode({ usage: { usedPercent: 50 } });
    const report = await cleanupNodeDisks([node], cfg(1_000_000));

    expect(node.reclaim).not.toHaveBeenCalled();
    expect(node.pruneStaleAgentImages).toHaveBeenCalledTimes(1);
    expect(report.pruned).toBe(0);
    expect(report.staleAgentImagePruned).toBe(1);
    expect(report.details[0]?.action).toBe("skip_below_threshold");
  });

  test("skips stale agent image prune inside its interval", async () => {
    const now = 5_000_000;
    const staleCooldown = new Map<string, number>([["node-a", now - 60_000]]);
    const node = fakeNode({ node_id: "node-a", usage: { usedPercent: 50 } });
    const report = await cleanupNodeDisks([node], cfg(now, new Map(), staleCooldown));

    expect(node.pruneStaleAgentImages).not.toHaveBeenCalled();
    expect(report.staleAgentImagePruned).toBe(0);
    expect(report.details[0]?.staleAgentImageAction).toBe("skip_interval");
  });

  test("continues to emergency reclaim when stale agent image prune fails", async () => {
    const node = fakeNode({
      usage: { usedPercent: 90 },
      stalePruneThrows: true,
    });
    const report = await cleanupNodeDisks([node], cfg(1_000_000));

    expect(node.pruneStaleAgentImages).toHaveBeenCalledTimes(1);
    expect(node.reclaim).toHaveBeenCalledTimes(1);
    expect(report.staleAgentImagePruneFailed).toBe(1);
    expect(report.pruned).toBe(1);
    expect(report.details[0]?.staleAgentImageAction).toBe("failed");
  });

  test("respects the cooldown: a node pruned recently is skipped even above threshold", async () => {
    const now = 5_000_000;
    const cooldown = new Map<string, number>([["node-a", now - 60_000]]); // pruned 1 min ago
    const node = fakeNode({ node_id: "node-a", usage: { usedPercent: 95 } });
    const report = await cleanupNodeDisks([node], cfg(now, cooldown));

    expect(node.reclaim).not.toHaveBeenCalled();
    expect(report.pruned).toBe(0);
    expect(report.details[0]?.action).toBe("skip_cooldown");
  });

  test("arms the cooldown after a prune so the next tick skips it", async () => {
    const cooldown = new Map<string, number>();
    const now = 9_000_000;
    const node = fakeNode({ node_id: "node-a", usage: { usedPercent: 90 } });

    await cleanupNodeDisks([node], cfg(now, cooldown));
    expect(cooldown.get("node-a")).toBe(now);

    // Second tick, still above threshold, but now inside the cooldown window.
    const node2 = fakeNode({ node_id: "node-a", usage: { usedPercent: 90 } });
    const report2 = await cleanupNodeDisks([node2], cfg(now + 1_000, cooldown));
    expect(node2.reclaim).not.toHaveBeenCalled();
    expect(report2.details[0]?.action).toBe("skip_cooldown");
  });

  test("skips a node whose df read failed (never reclaim off a misread)", async () => {
    const node = fakeNode({ usage: null });
    const report = await cleanupNodeDisks([node], cfg(1_000_000));

    expect(node.reclaim).not.toHaveBeenCalled();
    expect(report.nodesSkipped).toBe(1);
    expect(report.nodesScanned).toBe(0);
    expect(report.details[0]?.action).toBe("read_failed");
  });

  test("never touches a non-healthy node", async () => {
    const node = fakeNode({ status: "degraded", usage: { usedPercent: 99 } });
    const report = await cleanupNodeDisks([node], cfg(1_000_000));

    expect(node.readDiskUsage).not.toHaveBeenCalled();
    expect(node.reclaim).not.toHaveBeenCalled();
    expect(report.nodesSkipped).toBe(1);
  });

  test("counts a reclaim that throws as pruneFailed and continues", async () => {
    const bad = fakeNode({ node_id: "bad", usage: { usedPercent: 90 }, reclaimThrows: true });
    const good = fakeNode({ node_id: "good", usage: { usedPercent: 90 } });
    const report = await cleanupNodeDisks([bad, good], cfg(1_000_000));

    expect(report.pruneFailed).toBe(1);
    expect(report.pruned).toBe(1);
  });
});
