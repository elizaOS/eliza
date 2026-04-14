import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __testing, persistConfigEnv, readConfigEnv } from "./config-env.js";

const { BAK_SUFFIX, CONFIG_ENV_FILENAME } = __testing;

async function mkTmpStateDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "milady-config-env-"));
}

describe("persistConfigEnv", () => {
  let stateDir: string;
  let filePath: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    stateDir = await mkTmpStateDir();
    filePath = path.join(stateDir, CONFIG_ENV_FILENAME);
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    vi.restoreAllMocks();
  });

  it("writes a new key to a fresh file and updates process.env", async () => {
    await persistConfigEnv("ENABLE_EVM_PLUGIN", "1", { stateDir });

    const raw = await fs.readFile(filePath, "utf8");
    expect(raw).toContain("ENABLE_EVM_PLUGIN=1");
    expect(process.env.ENABLE_EVM_PLUGIN).toBe("1");
  });

  it("updates an existing key in place without duplicating", async () => {
    await persistConfigEnv("WALLET_SOURCE_EVM", "local", { stateDir });
    await persistConfigEnv("WALLET_SOURCE_EVM", "cloud", { stateDir });

    const raw = await fs.readFile(filePath, "utf8");
    const matches = raw.match(/^WALLET_SOURCE_EVM=/gm) ?? [];
    expect(matches.length).toBe(1);
    expect(raw).toContain("WALLET_SOURCE_EVM=cloud");
    expect(process.env.WALLET_SOURCE_EVM).toBe("cloud");
  });

  it("preserves unrelated entries, comments, and blank lines", async () => {
    const preamble = `${[
      "# managed by milady",
      "",
      "EXISTING_A=one",
      "# another comment",
      "EXISTING_B=two",
      "",
    ].join("\n")}\n`;
    await fs.writeFile(filePath, preamble, "utf8");

    await persistConfigEnv("EXISTING_A", "updated", { stateDir });
    await persistConfigEnv("NEW_KEY", "fresh", { stateDir });

    const raw = await fs.readFile(filePath, "utf8");
    expect(raw).toContain("# managed by milady");
    expect(raw).toContain("# another comment");
    expect(raw).toContain("EXISTING_A=updated");
    expect(raw).toContain("EXISTING_B=two");
    expect(raw).toContain("NEW_KEY=fresh");
  });

  it("rejects invalid key shapes", async () => {
    await expect(
      persistConfigEnv("lowercase", "x", { stateDir }),
    ).rejects.toThrow(/invalid key/);
    await expect(
      persistConfigEnv("1STARTS_WITH_DIGIT", "x", { stateDir }),
    ).rejects.toThrow(/invalid key/);
    await expect(
      persistConfigEnv("HAS-DASH", "x", { stateDir }),
    ).rejects.toThrow(/invalid key/);
  });

  it("rejects hijack-vector keys", async () => {
    for (const key of [
      "NODE_OPTIONS",
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "PATH",
      "HOME",
      "SHELL",
      "NODE_PATH",
      "HTTPS_PROXY",
      "NODE_TLS_REJECT_UNAUTHORIZED",
    ]) {
      await expect(
        persistConfigEnv(key, "hacked", { stateDir }),
      ).rejects.toThrow(/hijack vector/);
    }
  });

  it("treats empty value as delete and removes from process.env", async () => {
    await persistConfigEnv("TO_REMOVE", "present", { stateDir });
    expect(process.env.TO_REMOVE).toBe("present");

    await persistConfigEnv("TO_REMOVE", "", { stateDir });
    const raw = await fs.readFile(filePath, "utf8");
    expect(raw).not.toContain("TO_REMOVE");
    expect(process.env.TO_REMOVE).toBeUndefined();
  });

  it("serialises concurrent writes so last-write-wins is deterministic", async () => {
    const writes = Array.from({ length: 25 }, (_, i) =>
      persistConfigEnv("COUNTER", String(i), { stateDir }),
    );
    await Promise.all(writes);

    const raw = await fs.readFile(filePath, "utf8");
    const matches = raw.match(/^COUNTER=/gm) ?? [];
    expect(matches.length).toBe(1);
    expect(raw).toContain("COUNTER=24");
  });

  it("writes .bak pre-image that remains recoverable on rename failure", async () => {
    await persistConfigEnv("A", "one", { stateDir });
    const preImage = await fs.readFile(filePath, "utf8");

    const renameSpy = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(new Error("simulated crash mid-rename"));

    await expect(persistConfigEnv("A", "two", { stateDir })).rejects.toThrow(
      /simulated crash/,
    );

    // Live file untouched; .bak holds the pre-image.
    const liveAfter = await fs.readFile(filePath, "utf8");
    expect(liveAfter).toBe(preImage);

    const bak = await fs.readFile(`${filePath}${BAK_SUFFIX}`, "utf8");
    expect(bak).toBe(preImage);

    renameSpy.mockRestore();
  });

  it("round-trips values with quotes and spaces via readConfigEnv", async () => {
    await persistConfigEnv("QUOTED", 'has "quotes" and spaces', { stateDir });
    const read = await readConfigEnv(stateDir);
    expect(read.QUOTED).toBe('has "quotes" and spaces');
  });
});

describe("readConfigEnv", () => {
  it("returns empty record when file is missing", async () => {
    const stateDir = await mkTmpStateDir();
    try {
      const result = await readConfigEnv(stateDir);
      expect(result).toEqual({});
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("skips malformed lines and honours last-definition-wins", async () => {
    const stateDir = await mkTmpStateDir();
    const filePath = path.join(stateDir, CONFIG_ENV_FILENAME);
    try {
      await fs.writeFile(
        filePath,
        `${[
          "# comment",
          "",
          "NOT_A_KV_LINE",
          "A=first",
          "A=second",
          "B=plain",
          "lower=ignored",
        ].join("\n")}\n`,
        "utf8",
      );
      const result = await readConfigEnv(stateDir);
      expect(result.A).toBe("second");
      expect(result.B).toBe("plain");
      expect(result.lower).toBeUndefined();
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
