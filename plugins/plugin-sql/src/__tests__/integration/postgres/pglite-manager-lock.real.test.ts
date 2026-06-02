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

  it("honors a confirmed-live lock regardless of how old its createdAt is", async () => {
    // A long-running agent (days/weeks of uptime) holds a lock recording its
    // own live PID with an ancient createdAt. Single-writer safety must win:
    // a confirmed-alive PID is honored unconditionally, so a second manager is
    // rejected rather than reclaiming the lock and opening a dual-writer window.
    // (The staleness window only applies to UNCONFIRMABLE liveness — EPERM /
    // non-ESRCH — never to a PID we can positively confirm is running.)
    const dataDir = mkdtempSync(path.join(tmpdir(), "eliza-pglite-lock-"));
    tempDirs.push(dataDir);

    const ancientCreatedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(
      lockPathFor(dataDir),
      `${JSON.stringify({ pid: process.pid, createdAt: ancientCreatedAt, dataDir })}\n`
    );

    let error: unknown;
    try {
      new PGliteClientManager({ dataDir });
    } catch (err) {
      error = err;
    }
    expect((error as { code?: string }).code).toBe(PGLITE_ERROR_CODES.ACTIVE_LOCK);
    // The live lock must be left intact, not reclaimed.
    expect(existsSync(lockPathFor(dataDir))).toBe(true);
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
