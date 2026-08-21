/**
 * Verifies the agent host's `ensurePrivateDir` (W1-020): state directories
 * holding the PGlite DB, `config.env`, and `secret-salt` must be created
 * owner-only (0700), with the mode healed on directories left world-readable
 * by older installs. Real temp directories; POSIX-only.
 */
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePrivateDir } from "./paths.ts";

describe.skipIf(process.platform === "win32")("ensurePrivateDir", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "eliza-privdir-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  const modeOf = (dir: string) => statSync(dir).mode & 0o777;

  it("creates a new state dir with mode 0700", () => {
    const dir = path.join(workDir, "state");
    ensurePrivateDir(dir);
    expect(modeOf(dir)).toBe(0o700);
  });

  it("heals a world-readable directory from an older install", () => {
    const dir = path.join(workDir, "legacy-state");
    ensurePrivateDir(dir);
    chmodSync(dir, 0o755);

    ensurePrivateDir(dir);
    expect(modeOf(dir)).toBe(0o700);
  });
});
