/**
 * The cloud plugin's config.env writer is the process-wide canonical writer
 * (re-exported by `@elizaos/agent/api/config-env`). It must enforce the core
 * spawn-env denylist and owner-only state-dir hardening, and serialise
 * concurrent writes so no update is lost.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistConfigEnv, readConfigEnv } from "./config-env";

// fsync-per-write is slow on a loaded CI host; the assertions are not timing-based.
const FS_TIMEOUT_MS = 60_000;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "elizacloud-config-env-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("plugin-elizacloud persistConfigEnv", () => {
  it("rejects keys on the core spawn-env denylist", async () => {
    const stateDir = path.join(root, "state");
    // BASH_ENV / PYTHONPATH are core spawn-env hijack vectors that the local
    // BLOCKED_CONFIG_ENV_KEYS set does not list.
    for (const key of ["BASH_ENV", "PYTHONPATH", "GIT_SSH_COMMAND"]) {
      await expect(persistConfigEnv(key, "x", { stateDir })).rejects.toThrow(
        /hijack vector/,
      );
      expect(process.env[key] === "x").toBe(false);
    }
    await expect(fs.stat(path.join(stateDir, "config.env"))).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "creates and heals the state dir to 0700",
    async () => {
      const created = path.join(root, "fresh");
      await persistConfigEnv("ELIZA_TEST_CONFIG_ENV_A", "one", {
        stateDir: created,
      });
      expect((await fs.stat(created)).mode & 0o777).toBe(0o700);

      const legacy = path.join(root, "legacy");
      await fs.mkdir(legacy, { mode: 0o755 });
      await fs.chmod(legacy, 0o755);
      await persistConfigEnv("ELIZA_TEST_CONFIG_ENV_A", "two", {
        stateDir: legacy,
      });
      expect((await fs.stat(legacy)).mode & 0o777).toBe(0o700);
      expect(
        (await fs.stat(path.join(legacy, "config.env"))).mode & 0o777,
      ).toBe(0o600);
      delete process.env.ELIZA_TEST_CONFIG_ENV_A;
    },
    FS_TIMEOUT_MS,
  );

  it("serialises concurrent writes without losing updates", async () => {
    const stateDir = path.join(root, "race");
    const keys = Array.from(
      { length: 12 },
      (_, i) => `ELIZA_TEST_CONFIG_ENV_RACE_${i}`,
    );
    await Promise.all(
      keys.map((key, i) => persistConfigEnv(key, `v${i}`, { stateDir })),
    );
    const onDisk = await readConfigEnv(stateDir);
    for (const [i, key] of keys.entries()) {
      expect(onDisk[key]).toBe(`v${i}`);
      delete process.env[key];
    }
  }, FS_TIMEOUT_MS);
});
