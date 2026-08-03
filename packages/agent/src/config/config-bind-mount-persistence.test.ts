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
  fs.rmSync(root, { recursive: true, force: true });
});

describe("saveElizaConfig bind-mount fallback", () => {
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
