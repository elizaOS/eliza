/**
 * The cloud plugin's config.env writer is the process-wide canonical writer
 * shared by agent and cloud writers. It must enforce the core
 * spawn-env denylist and owner-only state-dir hardening, and serialise
 * concurrent writes so no update is lost.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { persistConfigEnv, readConfigEnv, readConfigEnvSync } from "./config-env";

// fsync-per-write is slow on a loaded CI host; the assertions are not timing-based.
const FS_TIMEOUT_MS = 60_000;

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "elizacloud-config-env-"));
});

afterEach(async () => {
  delete process.env.ELIZA_TEST_CONFIG_ENV_ROUNDTRIP;
  delete process.env.ELIZA_TEST_CONFIG_ENV_DUPLICATE;
  await fs.rm(root, { recursive: true, force: true });
});

describe("plugin-elizacloud persistConfigEnv", () => {
  it(
    "round-trips literal escapes alongside quotes and line breaks",
    async () => {
      const key = "ELIZA_TEST_CONFIG_ENV_ROUNDTRIP";
      const value = 'C:\\new\\records\\path "quoted"\nnext\rline\\n';
      await persistConfigEnv(key, value, { stateDir: root });
      expect((await readConfigEnv(root))[key]).toBe(value);
      expect(readConfigEnvSync(root)[key]).toBe(value);
    },
    FS_TIMEOUT_MS
  );

  it(
    "deletes every definition without reviving an older value",
    async () => {
      const key = "ELIZA_TEST_CONFIG_ENV_DUPLICATE";
      await fs.writeFile(
        path.join(root, "config.env"),
        `# preserve this comment\n${key}=old\nOTHER_SETTING=keep\n${key}=current\n`
      );
      await persistConfigEnv(key, "", { stateDir: root });
      expect(await readConfigEnv(root)).toEqual({ OTHER_SETTING: "keep" });
      expect(readConfigEnvSync(root)).toEqual({ OTHER_SETTING: "keep" });
      expect(await fs.readFile(path.join(root, "config.env"), "utf8")).toBe(
        "# preserve this comment\nOTHER_SETTING=keep\n"
      );
    },
    FS_TIMEOUT_MS
  );

  it.skipIf(process.platform === "win32")(
    "hardens existing temporary and backup files before writing",
    async () => {
      const file = path.join(root, "config.env");
      await fs.writeFile(file, "OTHER_SETTING=old\n");
      for (const suffix of [".tmp", ".bak"]) {
        await fs.writeFile(`${file}${suffix}`, "old", { mode: 0o644 });
        await fs.chmod(`${file}${suffix}`, 0o644);
      }
      await persistConfigEnv("ELIZA_TEST_CONFIG_ENV_ROUNDTRIP", "new", { stateDir: root });
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(`${file}.bak`)).mode & 0o777).toBe(0o600);
    },
    FS_TIMEOUT_MS
  );

  it("rejects keys on the core spawn-env denylist", async () => {
    const stateDir = path.join(root, "state");
    // BASH_ENV / PYTHONPATH are core spawn-env hijack vectors that the local
    // BLOCKED_CONFIG_ENV_KEYS set does not list.
    for (const key of ["BASH_ENV", "PYTHONPATH", "GIT_SSH_COMMAND"]) {
      await expect(persistConfigEnv(key, "x", { stateDir })).rejects.toThrow(/hijack vector/);
      expect(process.env[key] === "x").toBe(false);
    }
    await expect(fs.stat(path.join(stateDir, "config.env"))).rejects.toThrow();
  });

  it(
    "preserves measured process authority and disk contents when config attempts a write or clear",
    async () => {
      const file = path.join(root, "config.env");
      const contents = "ORDINARY_SETTING=preserved\n";
      await fs.writeFile(file, contents);
      for (const prefix of [
        "ELIZA_TEE_",
        "ELIZA_DSTACK_",
        "ELIZA_CONFIDENTIAL_",
        "ELIZA_PROTECTED_",
      ]) {
        const key = `${prefix}TEST_CONFIG_ENV_BOUNDARY`;
        const previous = process.env[key];
        process.env[key] = "measured";
        try {
          for (const value of ["replacement", ""]) {
            await expect(persistConfigEnv(key, value, { stateDir: root })).rejects.toMatchObject({
              code: "CONFIG_ENV_PROCESS_ONLY_KEY",
            });
            expect(process.env[key]).toBe("measured");
            expect(await fs.readFile(file, "utf8")).toBe(contents);
            expect(await fs.readdir(root)).toEqual(["config.env"]);
          }
        } finally {
          if (previous === undefined) delete process.env[key];
          else process.env[key] = previous;
        }
      }
    },
    FS_TIMEOUT_MS
  );

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
      expect((await fs.stat(path.join(legacy, "config.env"))).mode & 0o777).toBe(0o600);
      delete process.env.ELIZA_TEST_CONFIG_ENV_A;
    },
    FS_TIMEOUT_MS
  );

  it(
    "serialises concurrent writes without losing updates",
    async () => {
      const stateDir = path.join(root, "race");
      const keys = Array.from({ length: 12 }, (_, i) => `ELIZA_TEST_CONFIG_ENV_RACE_${i}`);
      await Promise.all(keys.map((key, i) => persistConfigEnv(key, `v${i}`, { stateDir })));
      const onDisk = await readConfigEnv(stateDir);
      for (const [i, key] of keys.entries()) {
        expect(onDisk[key]).toBe(`v${i}`);
        delete process.env[key];
      }
    },
    FS_TIMEOUT_MS
  );
});
