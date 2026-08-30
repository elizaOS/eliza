/** Regression coverage for config persistence when eliza.json is a file bind mount. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __setConfigRenameSyncForTests,
  loadElizaConfig,
  saveElizaConfig,
} from "./config.ts";
import {
  createDevCloudConfigAuthorityView,
  resetDevCloudEnvAuthorityForTests,
} from "./dev-cloud-env-authority.ts";

const originalEnv = { ...process.env };
let root = "";
let configPath = "";
let realConfigPath = "";
let stateDir = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-config-bind-"));
  configPath = path.join(root, "cfg", "eliza.json");
  stateDir = path.join(root, "state");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({ plugins: { entries: { original: { enabled: true } } } }, null, 2)}\n`,
  );
  realConfigPath = fs.realpathSync(configPath);
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_STATE_DIR = stateDir;
  delete process.env.ELIZA_PERSIST_CONFIG_PATH;
});

afterEach(() => {
  vi.restoreAllMocks();
  __setConfigRenameSyncForTests(null);
  process.env = { ...originalEnv };
  resetDevCloudEnvAuthorityForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("saveElizaConfig bind-mount fallback", () => {
  it("keeps launcher-owned staging env ahead of persisted Cloud env", () => {
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          env: {
            ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
            ELIZAOS_CLOUD_API_KEY: "persisted-production-key",
            ELIZAOS_CLOUD_EMBEDDING_URL:
              "https://api.eliza.app/api/v1/embeddings",
            ELIZA_CLOUD_WRITE_BASE_URL: "https://api.eliza.app/api/v1",
            SMALL_MODEL: "persisted-direct-model",
            ELIZA_DEV_SOURCE: "persisted-marker-must-not-win",
            vars: {
              ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
              ELIZAOS_CLOUD_API_KEY: "persisted-production-key",
              ELIZA_DEV_CLOUD_ENV_AUTHORITY: "production",
              UNRELATED_DEV_SETTING: "preserved",
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-default";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.eliza.app/api/v1";
    process.env.ELIZAOS_CLOUD_API_KEY = "";
    process.env.ELIZAOS_CLOUD_EMBEDDING_URL = "";
    process.env.ELIZA_CLOUD_WRITE_BASE_URL = "";
    delete process.env.SMALL_MODEL;

    const config = loadElizaConfig();

    expect(process.env.ELIZAOS_CLOUD_BASE_URL).toBe(
      "https://api-staging.eliza.app/api/v1",
    );
    expect(process.env.ELIZAOS_CLOUD_API_KEY).toBe("");
    expect(process.env.ELIZAOS_CLOUD_EMBEDDING_URL).toBe("");
    expect(process.env.ELIZA_CLOUD_WRITE_BASE_URL).toBe("");
    expect(process.env.SMALL_MODEL).toBe("persisted-direct-model");
    expect(process.env.ELIZA_DEV_SOURCE).toBe("1");
    expect(process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY).toBe("staging-default");
    expect(process.env.UNRELATED_DEV_SETTING).toBe("preserved");
    // Loading remains lossless; only the ephemeral runtime view is sanitized.
    expect(config.env?.vars?.ELIZAOS_CLOUD_API_KEY).toBe(
      "persisted-production-key",
    );
  });

  it("refuses to persist the ephemeral dev Cloud runtime view", () => {
    const persistedBefore = fs.readFileSync(configPath, "utf8");
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-default";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.eliza.app/api/v1";
    const view = createDevCloudConfigAuthorityView(loadElizaConfig());

    expect(() => saveElizaConfig(view)).toThrow(/ephemeral.*authority view/i);
    expect(fs.readFileSync(configPath, "utf8")).toBe(persistedBefore);
  });

  it("retires the former aggregate view plugin without removing canonical views", () => {
    fs.writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          plugins: {
            entries: {
              "simple-views": { enabled: true },
              notes: { enabled: true },
              calendar: { enabled: true },
            },
            allow: [
              "simple-views",
              "@elizaos/plugin-simple-views",
              "notes",
              "calendar",
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    const config = loadElizaConfig();
    expect(config.plugins?.entries).toEqual({
      notes: { enabled: true },
      calendar: { enabled: true },
    });
    expect(config.plugins?.allow).toEqual(["notes", "calendar"]);

    saveElizaConfig(config);
    const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(persisted.plugins.entries).toEqual({
      notes: { enabled: true },
      calendar: { enabled: true },
    });
    expect(persisted.plugins.allow).toEqual(["notes", "calendar"]);
  });

  it("commits a durable state overlay when rename onto the config returns EBUSY", () => {
    const realRename = fs.renameSync.bind(fs);
    __setConfigRenameSyncForTests((from, to) => {
      if (String(to) === realConfigPath) {
        const error = new Error("resource busy") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      return realRename(from, to);
    });

    saveElizaConfig({
      plugins: {
        entries: {
          original: { enabled: true },
          simpleViews: { enabled: true },
        },
      },
    } as never);

    const overlayPath = path.join(stateDir, "eliza.config-overlay.json");
    expect(fs.existsSync(overlayPath)).toBe(true);
    expect(fs.statSync(overlayPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(configPath, "utf8")).not.toContain("simpleViews");
    expect(loadElizaConfig().plugins?.entries?.simpleViews?.enabled).toBe(true);

    // Once selected, the overlay remains the write target. A stale overlay can
    // never override a later canonical write after restart.
    saveElizaConfig({
      plugins: { entries: { simpleViews: { enabled: false } } },
    } as never);
    expect(loadElizaConfig().plugins?.entries?.simpleViews?.enabled).toBe(
      false,
    );
  });

  it("keeps settings deleted from the full overlay absent after restart", () => {
    const realRename = fs.renameSync.bind(fs);
    __setConfigRenameSyncForTests((from, to) => {
      if (String(to) === realConfigPath) {
        const error = new Error("resource busy") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      return realRename(from, to);
    });

    const config = loadElizaConfig();
    expect(config.plugins?.entries?.original?.enabled).toBe(true);
    if (config.plugins?.entries) {
      delete config.plugins.entries.original;
      config.plugins.entries.simpleViews = { enabled: true };
    }
    saveElizaConfig(config);

    expect(
      fs.existsSync(path.join(stateDir, "eliza.config-overlay.json")),
    ).toBe(true);
    const reloaded = loadElizaConfig();
    expect(reloaded.plugins?.entries?.original).toBeUndefined();
    expect(reloaded.plugins?.entries?.simpleViews?.enabled).toBe(true);
  });

  it("throws when both the bind-mounted target and durable overlay fail", () => {
    __setConfigRenameSyncForTests((_from, to) => {
      const error = new Error("write refused") as NodeJS.ErrnoException;
      error.code = String(to) === realConfigPath ? "EBUSY" : "EACCES";
      throw error;
    });

    expect(() =>
      saveElizaConfig({ plugins: { entries: {} } } as never),
    ).toThrow("state overlay persistence failed");
    expect(
      fs.existsSync(path.join(stateDir, "eliza.config-overlay.json")),
    ).toBe(false);
  });

  it("keeps an explicit persistence path authoritative over a stale overlay", () => {
    const overlayPath = path.join(stateDir, "eliza.config-overlay.json");
    const persistPath = path.join(root, "persist", "eliza.json");
    fs.writeFileSync(
      overlayPath,
      `${JSON.stringify({ plugins: { entries: { stale: { enabled: true } } } })}\n`,
      { mode: 0o600 },
    );
    process.env.ELIZA_PERSIST_CONFIG_PATH = persistPath;

    saveElizaConfig({
      plugins: { entries: { current: { enabled: true } } },
    } as never);

    expect(fs.existsSync(persistPath)).toBe(true);
    expect(fs.statSync(persistPath).mode & 0o777).toBe(0o600);
    expect(loadElizaConfig().plugins?.entries).toEqual({
      original: { enabled: true },
      current: { enabled: true },
    });
    expect(fs.readFileSync(overlayPath, "utf8")).toContain('"stale"');
  });

  it("sanitizes include directives and wallet keys in the overlay", () => {
    const realRename = fs.renameSync.bind(fs);
    __setConfigRenameSyncForTests((from, to) => {
      if (String(to) === realConfigPath) {
        const error = new Error("resource busy") as NodeJS.ErrnoException;
        error.code = "EBUSY";
        throw error;
      }
      return realRename(from, to);
    });

    saveElizaConfig({
      $include: "secrets.json",
      env: {
        ELIZA_WALLET_OS_STORE: "true",
        EVM_PRIVATE_KEY: "secret",
        SOLANA_PRIVATE_KEY: "secret",
      },
    } as never);

    const persisted = fs.readFileSync(
      path.join(stateDir, "eliza.config-overlay.json"),
      "utf8",
    );
    expect(persisted).not.toContain("$include");
    expect(persisted).not.toContain("PRIVATE_KEY");
    expect(persisted).not.toContain("secret");
  });
});
