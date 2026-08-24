/**
 * Covers the eliza.json config load/save pipeline end to end against a real
 * temporary filesystem: base/persisted/overlay resolution and their precedence,
 * deletion-preserving authoritative overlays, retired-plugin migration, env
 * hydration into process.env (vault sentinels skipped, aliases mirrored),
 * skills.json bootstrap/folding, include stripping, wallet-key stripping under
 * the OS-keystore gate, atomic temp+rename writes with 0600 enforcement,
 * symlinked targets, and configFileExists(). Deterministic — every test runs
 * in its own mkdtemp sandbox with process.env snapshotted and restored.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  __setConfigRenameSyncForTests,
  configFileExists,
  loadElizaConfig,
  saveElizaConfig,
} from "./config.ts";

type AnyConfig = Record<string, unknown>;

function asObject(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

let root = "";
const ENV_KEYS = [
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_NAMESPACE",
  "ELIZA_SETTINGS_DEBUG",
  "TESTCFG_PROBE",
  "TESTCFG_VAULT",
  "DISCORD_API_TOKEN",
  "DISCORD_BOT_TOKEN",
];
let savedEnv: Array<[string, string | undefined]> = [];

function stateDir(): string {
  return path.join(root, "state");
}

function canonicalPath(): string {
  return path.join(stateDir(), "eliza.json");
}

function overlayPath(): string {
  return path.join(stateDir(), "eliza.config-overlay.json");
}

function persistedEnvPath(): string {
  return path.join(stateDir(), "config.env");
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf-8");
}

function readJson(file: string): AnyConfig {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as AnyConfig;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-config-test-"));
  savedEnv = ENV_KEYS.map((key) => [key, process.env[key]]);
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.ELIZA_STATE_DIR = stateDir();
});

afterEach(() => {
  __setConfigRenameSyncForTests(null);
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("loadElizaConfig", () => {
  it("returns the logging default and bootstraps skills.json when nothing exists", () => {
    const config = loadElizaConfig();

    expect(config).toEqual({ logging: { level: "error" } });
    const skills = readJson(path.join(stateDir(), "skills.json"));
    expect(skills).toEqual({ extraDirs: [] });
  });

  it("parses JSON5 with comments and defaults a missing logging level", () => {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(
      canonicalPath(),
      "{\n  // eliza config\n  name: 'probe-agent',\n}",
      "utf-8",
    );

    const config = loadElizaConfig() as AnyConfig;

    expect(config.name).toBe("probe-agent");
    expect(config.logging).toEqual({ level: "error" });
  });

  it("deep-merges the persisted file over a distinct base path", () => {
    process.env.ELIZA_CONFIG_PATH = path.join(root, "base.json");
    process.env.ELIZA_PERSIST_CONFIG_PATH = path.join(root, "persist.json");
    writeJson(process.env.ELIZA_CONFIG_PATH, {
      name: "base-name",
      tags: ["a"],
      plugins: { entries: { alpha: { enabled: false } }, allow: ["alpha"] },
    });
    writeJson(process.env.ELIZA_PERSIST_CONFIG_PATH, {
      tags: ["b"],
      plugins: { entries: { alpha: { enabled: true } } },
    });

    const config = loadElizaConfig() as AnyConfig;

    expect(config.name).toBe("base-name");
    expect(config.tags).toEqual(["b"]);
    expect(config.plugins).toEqual({
      entries: { alpha: { enabled: true } },
      allow: ["alpha"],
    });
  });

  it("treats an existing bind-mount overlay as authoritative, preserving deletions", () => {
    writeJson(canonicalPath(), { keepMe: true, removedByOverlay: true });
    writeJson(overlayPath(), { keepMe: true });

    const config = loadElizaConfig() as AnyConfig;

    expect(config.keepMe).toBe(true);
    expect(config.removedByOverlay).toBeUndefined();
  });

  it("ignores a stale overlay when an explicit persist path is configured", () => {
    process.env.ELIZA_PERSIST_CONFIG_PATH = path.join(root, "persist.json");
    writeJson(canonicalPath(), { fromBase: true });
    writeJson(overlayPath(), { onlyInStaleOverlay: true });
    writeJson(process.env.ELIZA_PERSIST_CONFIG_PATH, { fromPersist: true });

    const config = loadElizaConfig() as AnyConfig;

    expect(config.fromBase).toBe(true);
    expect(config.fromPersist).toBe(true);
    expect(config.onlyInStaleOverlay).toBeUndefined();
  });

  it("migrates retired plugin references out of entries and allow", () => {
    writeJson(canonicalPath(), {
      plugins: {
        entries: {
          "simple-views": { enabled: true },
          "@elizaos/plugin-simple-views": { enabled: true },
          "keep-me": { enabled: true },
        },
        allow: ["simple-views", "@elizaos/plugin-simple-views", "keep-me"],
      },
    });

    const config = loadElizaConfig() as AnyConfig;

    expect(Object.keys(asObject(asObject(config.plugins).entries))).toEqual([
      "keep-me",
    ]);
    expect(asObject(config.plugins).allow).toEqual(["keep-me"]);
  });

  it("lets saved config env values overwrite stale shell values", () => {
    process.env.TESTCFG_PROBE = "stale-shell";
    writeJson(canonicalPath(), {
      env: { vars: { TESTCFG_PROBE: "from-config" } },
    });

    loadElizaConfig();

    expect(process.env.TESTCFG_PROBE).toBe("from-config");
  });

  it("never applies unresolved vault sentinels to process.env", () => {
    writeJson(canonicalPath(), {
      env: { vars: { TESTCFG_VAULT: "vault://MYKEY" } },
    });

    loadElizaConfig();

    expect(process.env.TESTCFG_VAULT).toBeUndefined();
  });

  it("applies the persisted config.env store last, over config-file values", () => {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(
      persistedEnvPath(),
      "TESTCFG_PROBE=from-persisted-env\n",
      "utf-8",
    );
    writeJson(canonicalPath(), {
      env: { vars: { TESTCFG_PROBE: "from-config" } },
    });

    loadElizaConfig();

    expect(process.env.TESTCFG_PROBE).toBe("from-persisted-env");
  });

  it("mirrors whichever Discord token alias is present onto the other", () => {
    process.env.DISCORD_BOT_TOKEN = "token-123";
    delete process.env.DISCORD_API_TOKEN;

    loadElizaConfig();

    expect(process.env.DISCORD_API_TOKEN).toBe("token-123");
    expect(process.env.DISCORD_BOT_TOKEN).toBe("token-123");
  });

  it("folds skills.json extraDirs into the config without duplicates", () => {
    const dirOne = path.join(root, "skills-one");
    const dirTwo = path.join(root, "skills-two");
    writeJson(canonicalPath(), {
      skills: { load: { extraDirs: [dirTwo] } },
    });
    writeJson(path.join(stateDir(), "skills.json"), {
      extraDirs: [dirTwo, dirOne, dirOne],
    });

    const config = loadElizaConfig() as AnyConfig;

    expect(asObject(asObject(config.skills).load).extraDirs).toEqual([
      dirTwo,
      dirOne,
    ]);
  });
});

describe("saveElizaConfig", () => {
  it("writes pretty JSON ending in a newline with 0600 permissions", () => {
    saveElizaConfig({ name: "saved" } as AnyConfig);

    const written = readJson(canonicalPath());
    expect(written.name).toBe("saved");
    const raw = fs.readFileSync(canonicalPath(), "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    const mode = fs.statSync(canonicalPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("strips $include directives recursively", () => {
    const config = {
      name: "with-includes",
      nested: { $include: "./other.json", keep: true },
      list: [{ $include: "./a.json", keep: 1 }],
    } as AnyConfig;

    saveElizaConfig(config);

    const written = readJson(canonicalPath());
    expect(written.nested).toEqual({ keep: true });
    expect(written.list).toEqual([{ keep: 1 }]);
    expect(JSON.stringify(written)).not.toContain("$include");
  });

  it("keeps wallet private keys by default and strips them under the OS keystore", () => {
    const withKeys = {
      env: {
        EVM_PRIVATE_KEY: "0xabc",
        SOLANA_PRIVATE_KEY: "sol-secret",
        vars: { SOLANA_PRIVATE_KEY: "sol-secret", KEEP_ME: "yes" },
      },
    } as AnyConfig;

    saveElizaConfig(withKeys);
    const defaultEnv = asObject(asObject(readJson(canonicalPath())).env);
    expect(defaultEnv.EVM_PRIVATE_KEY).toBe("0xabc");
    expect(defaultEnv.SOLANA_PRIVATE_KEY).toBe("sol-secret");

    const osStore = {
      env: {
        ELIZA_WALLET_OS_STORE: "true",
        EVM_PRIVATE_KEY: "0xabc",
        SOLANA_PRIVATE_KEY: "sol-secret",
        vars: { SOLANA_PRIVATE_KEY: "sol-secret", KEEP_ME: "yes" },
      },
    } as AnyConfig;
    saveElizaConfig(osStore);
    const strippedEnv = asObject(asObject(readJson(canonicalPath())).env);
    const strippedVars = asObject(strippedEnv.vars);
    expect(strippedEnv.EVM_PRIVATE_KEY).toBeUndefined();
    expect(strippedEnv.SOLANA_PRIVATE_KEY).toBeUndefined();
    expect(strippedVars.SOLANA_PRIVATE_KEY).toBeUndefined();
    expect(strippedVars.KEEP_ME).toBe("yes");
  });

  it("commits through a uniquely named temp file via rename", () => {
    const renames: Array<{ from: string; to: string }> = [];
    __setConfigRenameSyncForTests((from, to) => {
      renames.push({ from: String(from), to: String(to) });
      fs.renameSync(from, to);
    });

    saveElizaConfig({ name: "atomic" } as AnyConfig);

    expect(renames).toHaveLength(1);
    expect(path.basename(renames[0].from)).toMatch(
      /^eliza\.json\.tmp\.\d+\.[0-9a-f-]+$/,
    );
    expect(renames[0].to).toBe(canonicalPath());
    expect(readJson(canonicalPath()).name).toBe("atomic");
  });

  it("rethrows rename failures and leaves no temp file behind", () => {
    writeJson(canonicalPath(), { name: "original" });
    __setConfigRenameSyncForTests(() => {
      throw Object.assign(new Error("boom"), { code: "EBOOM" });
    });

    expect(() => saveElizaConfig({ name: "updated" } as AnyConfig)).toThrow(
      "boom",
    );

    __setConfigRenameSyncForTests(null);
    const leftovers = fs
      .readdirSync(stateDir())
      .filter((entry) => entry.includes(".tmp."));
    expect(leftovers).toEqual([]);
    expect(readJson(canonicalPath()).name).toBe("original");
  });

  it("updates a symlinked config through the link instead of replacing it", () => {
    const realFile = path.join(root, "real-eliza.json");
    fs.writeFileSync(realFile, "{}\n", "utf-8");
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.symlinkSync(realFile, canonicalPath());

    saveElizaConfig({ name: "through-link" } as AnyConfig);

    expect(fs.lstatSync(canonicalPath()).isSymbolicLink()).toBe(true);
    expect(readJson(realFile).name).toBe("through-link");
  });

  it("persists to the existing overlay instead of the canonical file", () => {
    writeJson(overlayPath(), { previous: true });

    saveElizaConfig({ name: "overlay-write" } as AnyConfig);

    expect(readJson(overlayPath()).name).toBe("overlay-write");
    expect(fs.existsSync(canonicalPath())).toBe(false);

    const loaded = loadElizaConfig() as AnyConfig;
    expect(loaded.name).toBe("overlay-write");
  });
});

describe("configFileExists", () => {
  it("reports false with nothing on disk", () => {
    expect(configFileExists()).toBe(false);
  });

  it("reports true for a canonical file", () => {
    writeJson(canonicalPath(), {});
    expect(configFileExists()).toBe(true);
  });

  it("reports true for a persist-only configuration", () => {
    process.env.ELIZA_PERSIST_CONFIG_PATH = path.join(root, "persist.json");
    writeJson(process.env.ELIZA_PERSIST_CONFIG_PATH, {});
    expect(configFileExists()).toBe(true);
  });

  it("reports true for an overlay-only configuration", () => {
    writeJson(overlayPath(), {});
    expect(configFileExists()).toBe(true);
  });
});
