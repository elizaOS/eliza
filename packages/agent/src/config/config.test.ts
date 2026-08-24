/**
 * Tests the eliza.json runtime config loader and writer in `config.ts`: the
 * merge precedence (persisted overlay over base, bind-mount snapshot
 * authoritative over both), retired-plugin migration, skills.json hydration,
 * the vault-sentinel guard that keeps unresolved secrets out of process.env,
 * and `saveElizaConfig`'s atomic temp+rename write with its 0600 and
 * secret-stripping contracts. Deterministic: every path is isolated in a fresh
 * temp state dir through the documented ELIZA_STATE_DIR / ELIZA_CONFIG_PATH /
 * ELIZA_PERSIST_CONFIG_PATH knobs, and the rename seam is used only to observe
 * atomicity, never to fake success.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __setConfigRenameSyncForTests,
  configFileExists,
  loadElizaConfig,
  saveElizaConfig,
} from "./config.ts";

type Config = Record<string, unknown>;

const OVERLAY_FILENAME = "eliza.config-overlay.json";

let root: string;
let stateDir: string;
let configPath: string;
let persistPath: string;

/** process.env keys touched by a test; restored verbatim afterwards. */
const envBackup = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!envBackup.has(key)) envBackup.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function writeJson(file: string, value: Config): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf-8");
}

function readJson(file: string): Config {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as Config;
}

/** Recursively asserts no `$include` directive survived serialization. */
function expectNoIncludeDirectives(value: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) expectNoIncludeDirectives(entry);
    return;
  }
  if (value !== null && typeof value === "object") {
    expect(Object.keys(value)).not.toContain("$include");
    for (const nested of Object.values(value)) {
      expectNoIncludeDirectives(nested);
    }
  }
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-config-test-"));
  stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  configPath = path.join(stateDir, "eliza.json");
  persistPath = path.join(stateDir, "eliza.persisted.json");
  setEnv("ELIZA_STATE_DIR", stateDir);
  setEnv("ELIZA_CONFIG_PATH", configPath);
  setEnv("ELIZA_PERSIST_CONFIG_PATH", undefined);
});

afterEach(() => {
  __setConfigRenameSyncForTests(null);
  for (const [key, value] of envBackup) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envBackup.clear();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("saveElizaConfig", () => {
  it("writes atomically through a unique temp file renamed onto the target", () => {
    const renames: Record<string, string> = {};
    const realRename = fs.renameSync.bind(fs);
    __setConfigRenameSyncForTests((from, to) => {
      renames[String(from)] = String(to);
      realRename(from, to);
    });

    saveElizaConfig({ logging: { level: "warn" } } as never);

    const entries = Object.entries(renames);
    expect(entries).toHaveLength(1);
    const [from, to] = entries[0];
    expect(path.dirname(from)).toBe(path.dirname(configPath));
    expect(path.basename(from)).toMatch(/^eliza\.json\.tmp\.\d+\.[0-9a-f-]+$/);
    expect(to).toBe(configPath);
    expect(readJson(configPath)).toEqual({ logging: { level: "warn" } });
  });

  it("enforces owner-only 0600 permissions on the written file", () => {
    saveElizaConfig({ logging: { level: "error" } } as never);
    const mode = fs.statSync(configPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("strips $include directives recursively from the serialized file", () => {
    saveElizaConfig({
      $include: ["extra.json"],
      plugins: { entries: { keep: {} }, $include: ["plugins.json"] },
      nested: { deep: [{ $include: "list.json" }] },
    } as never);

    expectNoIncludeDirectives(readJson(configPath));
    expect(loadElizaConfig().plugins).toEqual({ entries: { keep: {} } });
  });

  it.each(["1", "true", "on", "yes", "TRUE", " Yes "])(
    "strips wallet private keys from top-level env and nested vars when config env sets ELIZA_WALLET_OS_STORE=%s",
    (flag) => {
      saveElizaConfig({
        env: {
          ELIZA_WALLET_OS_STORE: flag,
          EVM_PRIVATE_KEY: "0xdeadbeef",
          SOLANA_PRIVATE_KEY: "sol-secret",
          KEEP_ME: "visible",
          vars: {
            EVM_PRIVATE_KEY: "0xnested",
            SOLANA_PRIVATE_KEY: "sol-nested",
            KEEP_VARS: "kept",
          },
        },
      } as never);

      const written = readJson(configPath) as {
        env: Record<string, unknown>;
      };
      expect(written.env.EVM_PRIVATE_KEY).toBeUndefined();
      expect(written.env.SOLANA_PRIVATE_KEY).toBeUndefined();
      expect(written.env.KEEP_ME).toBe("visible");
      const vars = written.env.vars as Record<string, unknown>;
      expect(vars.EVM_PRIVATE_KEY).toBeUndefined();
      expect(vars.SOLANA_PRIVATE_KEY).toBeUndefined();
      expect(vars.KEEP_VARS).toBe("kept");
    },
  );

  it("keeps wallet private keys when the OS keystore is not enabled", () => {
    saveElizaConfig({
      env: {
        EVM_PRIVATE_KEY: "0xdeadbeef",
        SOLANA_PRIVATE_KEY: "sol-secret",
      },
    } as never);

    const written = readJson(configPath) as { env: Record<string, string> };
    expect(written.env.EVM_PRIVATE_KEY).toBe("0xdeadbeef");
    expect(written.env.SOLANA_PRIVATE_KEY).toBe("sol-secret");
  });

  it("falls back to the bind-mount overlay when the base file cannot be renamed", () => {
    const realRename = fs.renameSync.bind(fs);
    const overlayTarget = path.join(stateDir, OVERLAY_FILENAME);
    __setConfigRenameSyncForTests((_from, to) => {
      if (String(to) === configPath) {
        const error = new Error("EBUSY: device or resource busy");
        (error as NodeJS.ErrnoException).code = "EBUSY";
        throw error;
      }
      realRename(_from, to);
    });

    saveElizaConfig({ marker: "survived-ebusy" } as never);

    expect(fs.existsSync(configPath)).toBe(false);
    expect(readJson(overlayTarget)).toEqual({
      marker: "survived-ebusy",
    });
  });
});

describe("loadElizaConfig", () => {
  it("returns the default logging level and auto-creates an empty skills manifest on a fresh state dir", () => {
    const loaded = loadElizaConfig();
    expect(loaded.logging).toEqual({ level: "error" });

    const skillsManifest = JSON.parse(
      fs.readFileSync(path.join(stateDir, "skills.json"), "utf-8"),
    ) as { extraDirs?: string[] };
    expect(skillsManifest.extraDirs).toEqual([]);
  });

  it("merges the persisted overlay over the base file key by key", () => {
    writeJson(configPath, {
      agent: { name: "base-name" },
      settings: { theme: "dark", kept: true },
    });
    writeJson(persistPath, {
      settings: { theme: "light" },
    });
    setEnv("ELIZA_PERSIST_CONFIG_PATH", persistPath);

    const loaded = loadElizaConfig();
    expect((loaded as { agent?: unknown }).agent).toEqual({
      name: "base-name",
    });
    expect((loaded as { settings?: unknown }).settings).toEqual({
      theme: "light",
      kept: true,
    });
  });

  it("replaces arrays wholesale instead of merging element-wise", () => {
    writeJson(configPath, { plugins: { allow: ["a", "b"] } });
    writeJson(persistPath, { plugins: { allow: ["c"] } });
    setEnv("ELIZA_PERSIST_CONFIG_PATH", persistPath);

    const loaded = loadElizaConfig() as {
      plugins: { allow: string[] };
    };
    expect(loaded.plugins.allow).toEqual(["c"]);
  });

  it("treats the bind-mount overlay snapshot as authoritative, preserving deletions", () => {
    writeJson(configPath, {
      logging: { level: "debug" },
      removedByOverlay: true,
    });
    writeJson(path.join(stateDir, OVERLAY_FILENAME), {
      logging: { level: "error" },
    });

    const loaded = loadElizaConfig() as Record<string, unknown>;
    expect(loaded.logging).toEqual({ level: "error" });
    expect(loaded.removedByOverlay).toBeUndefined();
  });

  it("ignores the bind-mount overlay when an explicit persistence path is configured", () => {
    writeJson(configPath, { source: "base", shared: "from-base" });
    writeJson(persistPath, { added: "persisted" });
    writeJson(path.join(stateDir, OVERLAY_FILENAME), {
      overlayOnly: true,
    });
    setEnv("ELIZA_PERSIST_CONFIG_PATH", persistPath);

    const loaded = loadElizaConfig() as Record<string, unknown>;
    expect(loaded.source).toBe("base");
    expect(loaded.added).toBe("persisted");
    expect(loaded.overlayOnly).toBeUndefined();
    expect(loaded.shared).toBe("from-base");
  });

  it("migrates retired plugin ids out of entries and the allow list", () => {
    writeJson(configPath, {
      plugins: {
        entries: {
          "@elizaos/plugin-simple-views": {},
          "keep/me": {},
        },
        allow: [
          "@elizaos/plugin-simple-views",
          "@elizaos/plugin-notes",
          "keep/me",
        ],
      },
    });

    const loaded = loadElizaConfig() as {
      plugins: { entries: Record<string, unknown>; allow: string[] };
    };
    expect(Object.keys(loaded.plugins.entries)).toEqual(["keep/me"]);
    expect(loaded.plugins.allow).toEqual(["@elizaos/plugin-notes", "keep/me"]);
  });

  it("hydrates plain config env vars into process.env but skips unresolved vault sentinels", () => {
    setEnv("ELIZA_TESTCFG_PLAIN", "pre-existing");
    setEnv("ELIZA_TESTCFG_VAULTED", "real-secret-guard");

    saveElizaConfig({
      env: {
        ELIZA_TESTCFG_FROMSAVE: "saved-value",
      },
    } as never);

    const loaded = loadElizaConfig();
    const loadedEnv = (loaded as { env: Record<string, unknown> }).env;
    loadedEnv.ELIZA_TESTCFG_PLAIN = "fresh-value";
    loadedEnv.ELIZA_TESTCFG_VAULTED = "vault://ELIZA_TESTCFG_KEY";
    saveElizaConfig(loaded as never);

    loadElizaConfig();

    expect(process.env.ELIZA_TESTCFG_PLAIN).toBe("fresh-value");
    expect(process.env.ELIZA_TESTCFG_VAULTED).toBe("real-secret-guard");
    expect(process.env.ELIZA_TESTCFG_FROMSAVE).toBe("saved-value");
  });

  it("aliases DISCORD_BOT_TOKEN onto DISCORD_API_TOKEN from persisted config.env", () => {
    setEnv("DISCORD_API_TOKEN", undefined);
    setEnv("DISCORD_BOT_TOKEN", "bot-token-value");
    fs.writeFileSync(
      path.join(stateDir, "config.env"),
      "DISCORD_BOT_TOKEN=bot-token-value\n",
      "utf-8",
    );

    loadElizaConfig();

    expect(process.env.DISCORD_API_TOKEN).toBe("bot-token-value");
    expect(process.env.DISCORD_BOT_TOKEN).toBe("bot-token-value");
  });

  it("dedupes and resolves skills.json extraDirs into the merged config", () => {
    const dirA = path.join(root, "skills-a");
    const dirB = path.join(root, "skills-b");
    writeJson(configPath, {
      skills: { load: { extraDirs: [dirA] } },
    });
    fs.writeFileSync(
      path.join(stateDir, "skills.json"),
      JSON.stringify({ extraDirs: [dirA, dirB] }),
      "utf-8",
    );

    const loaded = loadElizaConfig() as {
      skills: { load: { extraDirs: string[] } };
    };
    expect(loaded.skills.load.extraDirs).toEqual([dirA, dirB]);
  });
});

describe("configFileExists", () => {
  it("is false before any config is written", () => {
    expect(configFileExists()).toBe(false);
  });

  it("detects the canonical file", () => {
    writeJson(configPath, {});
    expect(configFileExists()).toBe(true);
  });

  it("detects the explicit persistence file", () => {
    writeJson(persistPath, {});
    setEnv("ELIZA_PERSIST_CONFIG_PATH", persistPath);
    expect(configFileExists()).toBe(true);
  });

  it("detects the bind-mount overlay alone", () => {
    writeJson(path.join(stateDir, OVERLAY_FILENAME), {});
    expect(configFileExists()).toBe(true);
  });
});
