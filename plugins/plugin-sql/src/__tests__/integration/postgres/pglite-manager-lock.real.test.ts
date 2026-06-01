import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PGLITE_ERROR_CODES } from "../../../pglite/errors";
import { PGliteClientManager } from "../../../pglite/manager";

const lockPathFor = (dataDir: string) => path.join(dataDir, "eliza-pglite.lock");

describe("PGliteClientManager file lock", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a second manager for the same file-backed data dir", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "eliza-pglite-lock-"));
    tempDirs.push(dataDir);

    const first = new PGliteClientManager({ dataDir });
    try {
      let error: unknown;
      try {
        new PGliteClientManager({ dataDir });
      } catch (err) {
        error = err;
      }

      expect((error as { code?: string }).code).toBe(PGLITE_ERROR_CODES.ACTIVE_LOCK);
    } finally {
      await first.close();
    }

    const second = new PGliteClientManager({ dataDir });
    await second.close();
  });

  it("reclaims a stale lock whose recorded createdAt is older than the staleness window", async () => {
    // Simulate a hard crash that left a lock recording THIS process's PID
    // (the PID-reuse worst case) but an ancient createdAt. The liveness probe
    // sees the PID alive, so without staleness checking it would falsely brick
    // boot. The createdAt window must let a fresh manager reclaim it.
    const dataDir = mkdtempSync(path.join(tmpdir(), "eliza-pglite-lock-"));
    tempDirs.push(dataDir);

    const ancientCreatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      lockPathFor(dataDir),
      `${JSON.stringify({ pid: process.pid, createdAt: ancientCreatedAt, dataDir })}\n`
    );

    const manager = new PGliteClientManager({ dataDir });
    await manager.close();
  });

  it("reclaims a lock owned by a non-running PID", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "eliza-pglite-lock-"));
    tempDirs.push(dataDir);

    // PID that cannot exist on Linux/macOS (above the configured pid_max).
    writeFileSync(
      lockPathFor(dataDir),
      `${JSON.stringify({
        pid: 2_147_483_646,
        createdAt: new Date().toISOString(),
        dataDir,
      })}\n`
    );

    const manager = new PGliteClientManager({ dataDir });
    await manager.close();
    expect(existsSync(lockPathFor(dataDir))).toBe(false);
  });
});
