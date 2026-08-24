/**
 * Covers the eliza.json persistence boundary: layered loading (canonical
 * file, persisted overlay, bind-mount snapshot), $include resolution,
 * legacy/retired-plugin migration, skills.json folding, process-env
 * hydration rules, Discord token aliasing, Solana public-key aliasing, and
 * the atomic-save contract (temp+rename, 0600, include stripping, wallet-key
 * stripping, EBUSY overlay fallback, symlink-safe writes).
 *
 * The harness is real: every case drives a throwaway state directory on the
 * actual filesystem through the exported load/save/exists API — no mocked fs.
 * The one injected seam is `__setConfigRenameSyncForTests`, which the module
 * exposes precisely so filesystem-failure branches can be exercised
 * deterministically.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __setConfigRenameSyncForTests,
  configFileExists,
  type ElizaConfig,
  loadElizaConfig,
  saveElizaConfig,
} from "./config.ts";

/** Free-form view for asserting keys outside the typed ElizaConfig surface. */
type RawConfig = Record<string, unknown>;

function asConfig(value: object): ElizaConfig {
  return value as unknown as ElizaConfig;
}

function loadRaw(): RawConfig {
  return loadElizaConfig() as unknown as RawConfig;
}

let stateDir: string;
let savedProcessEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  savedProcessEnv = { ...process.env };
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-config-test-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  for (const key of [
    "ELIZA_CONFIG_PATH",
    "ELIZA_PERSIST_CONFIG_PATH",
    "ELIZA_NAMESPACE",
    "XDG_STATE_HOME",
  ]) {
    delete process.env[key];
  }
});

afterEach(() => {
  __setConfigRenameSyncForTests(null);
  fs.rmSync(stateDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in savedProcessEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedProcessEnv);
});

function basePath(): string {
  return path.join(stateDir, "eliza.json");
}

function writeStateFile(name: string, content: string | object): void {
  const raw = typeof content === "string" ? content : JSON.stringify(content);
  fs.writeFileSync(path.join(stateDir, name), raw, "utf-8");
}

function readStateJson(name: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(stateDir, name), "utf-8"));
}

describe("loadElizaConfig", () => {
  it("returns defaults and scaffolds an empty skills.json on a fresh state dir", () => {
    expect(loadElizaConfig()).toEqual({ logging: { level: "error" } });
    expect(readStateJson("skills.json")).toEqual({ extraDirs: [] });
  });

  it("reads a JSON5 base config with comments and trailing commas", () => {
    writeStateFile(
      "eliza.json",
      `{
        // agent settings
        "agents": { "defaults": { "contextTokens": 4096, }, },
      }`,
    );
    expect(loadElizaConfig()).toEqual({
      agents: { defaults: { contextTokens: 4096 } },
      logging: { level: "error" },
    });
  });

  it("deep-merges the persisted overlay over the canonical file, replacing arrays wholesale", () => {
    writeStateFile("eliza.json", {
      server: { host: "127.0.0.1", port: 3000 },
      tags: ["a", "b"],
      keepMe: true,
    });
    writeStateFile(".config-persist.json", {
      server: { port: 4000 },
      tags: ["c"],
    });

    process.env.ELIZA_PERSIST_CONFIG_PATH = path.join(
      stateDir,
      ".config-persist.json",
    );
    const loaded = loadRaw();
    expect(loaded.server).toEqual({ host: "127.0.0.1", port: 4000 });
    expect(loaded.tags).toEqual(["c"]);
    expect(loaded.keepMe).toBe(true);
  });

  it("ignores the bind-mount overlay when an explicit persist path is configured", () => {
    writeStateFile("eliza.json", { source: "base" });
    writeStateFile("eliza.config-overlay.json", { source: "overlay" });
    const persistPath = path.join(stateDir, "custom-persist.json");
    writeStateFile("custom-persist.json", { source: "persist" });
    process.env.ELIZA_PERSIST_CONFIG_PATH = persistPath;

    const loaded = loadRaw();
    expect(loaded.source).toBe("persist");
  });

  it("treats the bind-mount overlay as an authoritative snapshot over the canonical file", () => {
    writeStateFile("eliza.json", { droppedByOverlay: true });
    writeStateFile("eliza.config-overlay.json", { source: "overlay" });

    const loaded = loadRaw();
    expect(loaded.droppedByOverlay).toBeUndefined();
    expect(loaded.source).toBe("overlay");
  });

  it("deletes the legacy root connection shape while migrating", () => {
    writeStateFile("eliza.json", {
      connection: { mode: "cloud" },
      untouched: true,
    });
    const loaded = loadRaw();
    expect("connection" in loaded).toBe(false);
    expect(loaded.untouched).toBe(true);
  });

  it("strips retired plugin ids from plugins.entries and plugins.allow", () => {
    writeStateFile("eliza.json", {
      plugins: {
        entries: {
          "simple-views": { enabled: true },
          "@elizaos/plugin-simple-views": { enabled: true },
          "@elizaos/plugin-survivor": { enabled: true },
        },
        allow: [
          "simple-views",
          "@elizaos/plugin-simple-views",
          "@elizaos/plugin-survivor",
        ],
      },
    });
    const loaded = loadElizaConfig();
    expect(Object.keys(loaded.plugins?.entries ?? {})).toEqual([
      "@elizaos/plugin-survivor",
    ]);
    expect(loaded.plugins?.allow).toEqual(["@elizaos/plugin-survivor"]);
  });

  it("resolves a single-file $include directive on load", () => {
    writeStateFile("included-part.json", { included: { value: 42 } });
    writeStateFile("eliza.json", {
      $include: "./included-part.json",
      own: "value",
    });
    const loaded = loadRaw();
    expect(loaded.included).toEqual({ value: 42 });
    expect(loaded.own).toBe("value");
  });

  it("folds skills.json extraDirs in expanded and deduplicated, preserving order", () => {
    writeStateFile("skills.json", {
      extraDirs: ["/tmp/skills-a", "/tmp/skills-a", "~/skills-b"],
    });
    const loaded = loadElizaConfig();
    const extraDirs = loaded.skills?.load?.extraDirs ?? [];
    expect(extraDirs).toEqual([
      "/tmp/skills-a",
      expect.stringContaining("skills-b"),
    ]);
    expect(extraDirs[1]).not.toContain("~");
  });

  it("hydrates config env entries into process.env with config winning over the shell", () => {
    process.env.CONFIG_TEST_SCALAR = "from-shell";
    process.env.CONFIG_TEST_SENTINEL = "real-value";
    writeStateFile("eliza.json", {
      env: {
        CONFIG_TEST_TOPLEVEL: "top-level-value",
        CONFIG_TEST_SENTINEL: "vault://CONFIG_TEST_SECRET",
        vars: { CONFIG_TEST_SCALAR: "from-config" },
      },
    });
    loadElizaConfig();
    expect(process.env.CONFIG_TEST_TOPLEVEL).toBe("top-level-value");
    expect(process.env.CONFIG_TEST_SCALAR).toBe("from-config");
    // Unresolved vault sentinels must never clobber live plaintext.
    expect(process.env.CONFIG_TEST_SENTINEL).toBe("real-value");
  });

  it("applies persisted config.env entries to process.env", () => {
    writeStateFile("config.env", "CONFIG_ENV_TEST_KEY=from-file\n");
    loadElizaConfig();
    expect(process.env.CONFIG_ENV_TEST_KEY).toBe("from-file");
  });

  it("aliases the Discord token across API/BOT names with the API value winning", () => {
    process.env.DISCORD_API_TOKEN = "api-token";
    loadElizaConfig();
    expect(process.env.DISCORD_BOT_TOKEN).toBe("api-token");

    delete process.env.DISCORD_API_TOKEN;
    process.env.DISCORD_BOT_TOKEN = "bot-token";
    loadElizaConfig();
    expect(process.env.DISCORD_API_TOKEN).toBe("bot-token");

    process.env.DISCORD_API_TOKEN = "api-wins";
    process.env.DISCORD_BOT_TOKEN = "stale-bot";
    loadElizaConfig();
    expect(process.env.DISCORD_API_TOKEN).toBe("api-wins");
    expect(process.env.DISCORD_BOT_TOKEN).toBe("api-wins");
  });

  it("derives the Solana public-key aliases from a configured private key", () => {
    writeStateFile("eliza.json", {
      env: {
        vars: {
          // A real 32-byte ed25519 seed, base58-encoded.
          SOLANA_PRIVATE_KEY: "CeHfPo6PbTjoDGFVrpUv3CWth5wqFAD5wPjqphvHJZqU",
        },
      },
    });
    loadElizaConfig();
    const pub = process.env.SOLANA_PUBLIC_KEY;
    expect(pub).toBeTruthy();
    expect(pub).not.toBe("CeHfPo6PbTjoDGFVrpUv3CWth5wqFAD5wPjqphvHJZqU");
    expect(process.env.WALLET_PUBLIC_KEY).toBe(pub);
  });

  it("leaves the Solana aliases unset when the configured key is a placeholder", () => {
    writeStateFile("eliza.json", {
      env: { vars: { SOLANA_PRIVATE_KEY: "CHANGEME" } },
    });
    loadElizaConfig();
    expect(process.env.SOLANA_PUBLIC_KEY).toBeUndefined();
    expect(process.env.WALLET_PUBLIC_KEY).toBeUndefined();
  });

  it("fails fast instead of returning defaults when the base file is corrupt", () => {
    writeStateFile("eliza.json", "{ this is not json ]");
    expect(() => loadElizaConfig()).toThrow();
  });
});

describe("saveElizaConfig", () => {
  it("round-trips a config through save and load unchanged", () => {
    const config = {
      logging: { level: "info" },
      agents: { defaults: { contextTokens: 8192 } },
      plugins: { allow: ["@elizaos/plugin-x"] },
    };
    saveElizaConfig(asConfig(structuredClone(config)));
    expect(loadElizaConfig()).toEqual(config);
  });

  it("strips $include directives recursively from the written file", () => {
    saveElizaConfig(
      asConfig({
        logging: { level: "error" },
        $include: "./base.json",
        nested: { $include: "./other.json", b: 1 },
        list: [{ $include: "./third.json", c: 2 }],
      }),
    );
    const written = readStateJson("eliza.json");
    expect(JSON.stringify(written)).not.toContain("$include");
    expect(written.nested).toEqual({ b: 1 });
    expect(written.list).toEqual([{ c: 2 }]);
  });

  it("writes atomically through a uniquely named temp file with a trailing newline and 0600 perms", () => {
    const renames: Array<[fs.PathLike, fs.PathLike]> = [];
    const realRename = fs.renameSync.bind(fs);
    __setConfigRenameSyncForTests((from, to) => {
      renames.push([from, to]);
      realRename(from, to);
    });
    try {
      saveElizaConfig({ logging: { level: "error" } });
    } finally {
      __setConfigRenameSyncForTests(null);
    }

    expect(renames).toHaveLength(1);
    const [from, to] = renames[0];
    expect(String(to)).toBe(basePath());
    expect(path.basename(String(from))).toMatch(
      new RegExp(`^eliza\\.json\\.tmp\\.${process.pid}\\.`),
    );

    const stat = fs.statSync(basePath());
    expect(stat.mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(basePath(), "utf-8").endsWith("\n")).toBe(true);
  });

  it("leaves the previous config intact and cleans up the temp file when the write fails", () => {
    saveElizaConfig(
      asConfig({ logging: { level: "error" }, versionMarker: 1 }),
    );
    __setConfigRenameSyncForTests(() => {
      throw new Error("disk went away");
    });
    expect(() =>
      saveElizaConfig(
        asConfig({ logging: { level: "error" }, versionMarker: 2 }),
      ),
    ).toThrow("disk went away");

    expect(readStateJson("eliza.json").versionMarker).toBe(1);
    const leftovers = fs
      .readdirSync(stateDir)
      .filter((name) => name.includes(".tmp."));
    expect(leftovers).toEqual([]);
  });

  it("falls back to the state-dir overlay when the canonical file cannot be renamed (EBUSY)", () => {
    writeStateFile("eliza.json", { versionMarker: "original" });
    // macOS /tmp is itself a symlink, so the module writes through the
    // realpath of the canonical file — match that here.
    const canonicalReal = fs.realpathSync(basePath());
    __setConfigRenameSyncForTests((from, to) => {
      if (String(to) === canonicalReal) {
        const error = new Error(
          "Device or resource busy",
        ) as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      fs.renameSync(from, to);
    });

    saveElizaConfig(
      asConfig({
        logging: { level: "error" },
        versionMarker: "overlay",
      }),
    );

    expect(readStateJson("eliza.json").versionMarker).toBe("original");
    expect(readStateJson("eliza.config-overlay.json").versionMarker).toBe(
      "overlay",
    );
    // The overlay snapshot is what the next load serves.
    expect(loadRaw().versionMarker).toBe("overlay");
  });

  it("updates a symlinked config through its realpath instead of replacing the link", () => {
    const target = path.join(stateDir, "real-eliza.json");
    fs.writeFileSync(target, JSON.stringify({ previous: true }), "utf-8");
    fs.symlinkSync(target, basePath());

    saveElizaConfig(
      asConfig({ logging: { level: "error" }, viaSymlink: true }),
    );

    expect(fs.lstatSync(basePath()).isSymbolicLink()).toBe(true);
    expect(JSON.parse(fs.readFileSync(target, "utf-8")).viaSymlink).toBe(true);
  });

  it("strips wallet private keys from env and env.vars when the OS keystore flag is set", () => {
    saveElizaConfig({
      logging: { level: "error" },
      env: {
        ELIZA_WALLET_OS_STORE: "on",
        EVM_PRIVATE_KEY: "0x-secret",
        SOLANA_PRIVATE_KEY: "sol-secret",
        vars: {
          EVM_PRIVATE_KEY: "0x-nested",
          SOLANA_PRIVATE_KEY: "sol-nested",
          KEEP_ME: "kept",
        },
      },
    });
    const env = readStateJson("eliza.json").env as Record<string, unknown>;
    const vars = env.vars as Record<string, unknown>;
    expect(env.EVM_PRIVATE_KEY).toBeUndefined();
    expect(env.SOLANA_PRIVATE_KEY).toBeUndefined();
    expect(vars.EVM_PRIVATE_KEY).toBeUndefined();
    expect(vars.SOLANA_PRIVATE_KEY).toBeUndefined();
    expect(vars.KEEP_ME).toBe("kept");
  });

  it("keeps wallet private keys on disk when the OS keystore flag is absent", () => {
    saveElizaConfig({
      logging: { level: "error" },
      env: { SOLANA_PRIVATE_KEY: "sol-secret" },
    });
    const written = readStateJson("eliza.json") as {
      env: Record<string, string>;
    };
    expect(written.env.SOLANA_PRIVATE_KEY).toBe("sol-secret");
  });

  it("applies retired-plugin migration during save, not just load", () => {
    saveElizaConfig({
      logging: { level: "error" },
      plugins: {
        entries: { "simple-views": {}, "@elizaos/plugin-survivor": {} },
        allow: ["simple-views", "@elizaos/plugin-survivor"],
      },
    });
    const written = readStateJson("eliza.json") as {
      plugins: { entries: Record<string, unknown>; allow: string[] };
    };
    expect(Object.keys(written.plugins.entries)).toEqual([
      "@elizaos/plugin-survivor",
    ]);
    expect(written.plugins.allow).toEqual(["@elizaos/plugin-survivor"]);
  });
});

describe("configFileExists", () => {
  it("reports false on a fresh state directory", () => {
    expect(configFileExists()).toBe(false);
  });

  it("reports true when the canonical config exists", () => {
    writeStateFile("eliza.json", {});
    expect(configFileExists()).toBe(true);
  });

  it("reports true when only the explicit persist-path config exists", () => {
    process.env.ELIZA_PERSIST_CONFIG_PATH = path.join(
      stateDir,
      "custom-persist.json",
    );
    writeStateFile("custom-persist.json", {});
    expect(configFileExists()).toBe(true);
  });

  it("reports true when only the bind-mount overlay exists", () => {
    writeStateFile("eliza.config-overlay.json", {});
    expect(configFileExists()).toBe(true);
  });
});
