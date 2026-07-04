/**
 * Verifies scanAndUnlinkOlderThan.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  scanAndUnlinkOlderThan,
  scanAndUnlinkOlderThanDetailed,
} from "../../src/services/acp-service.js";

// Covers the shared filesystem-age GC helper extracted from cleanStaleLocks
// and cleanReverseOrphanedAcpxFiles. Direct unit tests because the call
// sites are gated behind multi-second timeouts and a live acpx state dir;
// drilling through AcpService would require mocking out the runtime, signals,
// and stat-clock — much heavier than what the helper actually does.

const ROOT = join(tmpdir(), `acp-scan-test-${process.pid}-${Date.now()}`);

async function touchOld(path: string, ageMs: number): Promise<void> {
  await writeFile(path, "");
  const past = new Date(Date.now() - ageMs);
  await utimes(path, past, past);
}

beforeEach(async () => {
  await mkdir(ROOT, { recursive: true });
});

afterEach(async () => {
  await rm(ROOT, { recursive: true, force: true });
});

describe("scanAndUnlinkOlderThan", () => {
  it("returns 0 when the directory does not exist (best-effort)", async () => {
    const cleaned = await scanAndUnlinkOlderThan(
      join(ROOT, "missing"),
      () => true,
      1_000,
    );
    expect(cleaned).toBe(0);
  });

  it("returns 0 when nothing matches the predicate", async () => {
    await writeFile(join(ROOT, "keep.txt"), "");
    const cleaned = await scanAndUnlinkOlderThan(
      ROOT,
      (name) => name.endsWith(".lock"),
      0,
    );
    expect(cleaned).toBe(0);
    // file untouched
    await expect(stat(join(ROOT, "keep.txt"))).resolves.toBeDefined();
  });

  it("deletes matching files older than the threshold and leaves younger ones", async () => {
    await touchOld(join(ROOT, "old-1.lock"), 30 * 60_000); // 30 min old
    await touchOld(join(ROOT, "old-2.lock"), 30 * 60_000);
    await writeFile(join(ROOT, "fresh.lock"), ""); // just now
    await writeFile(join(ROOT, "old-but-wrong-ext.txt"), ""); // skipped by predicate

    const detailed = await scanAndUnlinkOlderThanDetailed(
      ROOT,
      (name) => name.endsWith(".lock"),
      10 * 60_000, // 10 min threshold
    );
    expect(detailed.deleted).toBe(2);
    expect(detailed.lingering).toBe(1);

    // old files gone
    await expect(stat(join(ROOT, "old-1.lock"))).rejects.toBeDefined();
    await expect(stat(join(ROOT, "old-2.lock"))).rejects.toBeDefined();
    // fresh + non-matching survived
    await expect(stat(join(ROOT, "fresh.lock"))).resolves.toBeDefined();
    await expect(
      stat(join(ROOT, "old-but-wrong-ext.txt")),
    ).resolves.toBeDefined();
  });

  it("survives stat/unlink races (file vanishes mid-scan)", async () => {
    // Simulate: a matching entry returned from readdir gets deleted before
    // we stat it. The helper should not crash, just count zero deletions.
    await touchOld(join(ROOT, "old-vanish.lock"), 30 * 60_000);
    // Race: delete it ourselves before the scan completes. The scan is
    // already async-batched via Promise.allSettled, so this is timing-fuzzy
    // — what matters is that scan() doesn't throw.
    const scanPromise = scanAndUnlinkOlderThan(
      ROOT,
      (name) => name.endsWith(".lock"),
      0,
    );
    await rm(join(ROOT, "old-vanish.lock"), { force: true });
    await expect(scanPromise).resolves.toBeGreaterThanOrEqual(0);
  });
});
