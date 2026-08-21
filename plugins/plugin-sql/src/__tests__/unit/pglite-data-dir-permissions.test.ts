/**
 * Verifies `ensurePrivateDir` (W1-020): the PGlite memory DB directory must be
 * created owner-only (0700) and directories left world-readable by older
 * installs must be healed on boot, since the tree holds full agent history
 * and connector ciphertext while PGlite's own files stay 0644. Real temp
 * directories on the local filesystem; POSIX-only (mode bits are not
 * enforceable on Windows).
 */
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePrivateDir } from "../../pglite/manager";

describe.skipIf(process.platform === "win32")("ensurePrivateDir", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "pglite-privdir-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const modeOf = (dir: string) => statSync(dir).mode & 0o777;

  it("creates a new data dir with mode 0700", () => {
    const dataDir = path.join(workDir, "fresh-db");
    ensurePrivateDir(dataDir);
    expect(modeOf(dataDir)).toBe(0o700);
  });

  it("creates missing parents and leaves the data dir owner-only", () => {
    const dataDir = path.join(workDir, "nested", "db");
    ensurePrivateDir(dataDir);
    expect(modeOf(dataDir)).toBe(0o700);
  });

  it("heals a world-readable directory from an older install", () => {
    const dataDir = path.join(workDir, "legacy-db");
    ensurePrivateDir(dataDir);
    chmodSync(dataDir, 0o755);
    expect(modeOf(dataDir)).toBe(0o755);

    ensurePrivateDir(dataDir);
    expect(modeOf(dataDir)).toBe(0o700);
  });
});
