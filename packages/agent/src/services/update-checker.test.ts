/**
 * The persisted update cache stores `lastCheckAt` and `lastCheckVersion`. Both
 * config-mutating channel changes clear those fields, but `resolveChannel` also
 * honours `ELIZA_UPDATE_CHANNEL`, which writes nothing — so the cache has to
 * record which channel produced it or it will be served under another one.
 *
 * Deterministic: real config reads/writes are isolated in a temp state dir and
 * the npm registry response is supplied by a fetch stub; no module mocks.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadElizaConfig, saveElizaConfig } from "../config/config.ts";
import type { ElizaConfig } from "../config/types.eliza.ts";
import { VERSION } from "../runtime/version.ts";
import { checkForUpdate } from "./update-checker.ts";

const DIST_TAGS = {
  latest: "9999.9.9",
  beta: "9999.9.9-beta.1",
  nightly: "9999.9.9-nightly.1",
};

let fetchCalls = 0;
let tempStateDir: string;
const originalFetch = globalThis.fetch;
const originalEnv = {
  ELIZA_CONFIG_PATH: process.env.ELIZA_CONFIG_PATH,
  ELIZA_PERSIST_CONFIG_PATH: process.env.ELIZA_PERSIST_CONFIG_PATH,
  ELIZA_STATE_DIR: process.env.ELIZA_STATE_DIR,
  ELIZA_UPDATE_CHANNEL: process.env.ELIZA_UPDATE_CHANNEL,
};

function restoreEnv(
  key: keyof typeof originalEnv,
  value: string | undefined,
): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  fetchCalls = 0;
  tempStateDir = mkdtempSync(join(tmpdir(), "eliza-update-checker-"));
  const configPath = join(tempStateDir, "eliza.json");
  process.env.ELIZA_STATE_DIR = tempStateDir;
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
  delete process.env.ELIZA_UPDATE_CHANNEL;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return {
      ok: true,
      json: async () => ({ "dist-tags": DIST_TAGS }),
    };
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    restoreEnv(key as keyof typeof originalEnv, value);
  }
  rmSync(tempStateDir, { recursive: true, force: true });
});

function freshStableCache(): ElizaConfig {
  return {
    update: {
      channel: "stable",
      lastCheckAt: new Date().toISOString(),
      lastCheckVersion: DIST_TAGS.latest,
      lastCheckChannel: "stable",
    },
  } as ElizaConfig;
}

describe("checkForUpdate release-channel cache", () => {
  it("does not serve a stable cache under ELIZA_UPDATE_CHANNEL=beta", async () => {
    saveElizaConfig(freshStableCache());
    process.env.ELIZA_UPDATE_CHANNEL = "beta";

    const result = await checkForUpdate();

    expect(result.currentVersion).toBe(VERSION);
    expect(result.channel).toBe("beta");
    expect(result.distTag).toBe("beta");
    // The bug returns the stable dist-tag's version under channel "beta".
    expect(result.latestVersion).toBe(DIST_TAGS.beta);
    expect(result.cached).toBe(false);
    expect(fetchCalls).toBe(1);
  });

  it("still serves a fresh cache for the channel that produced it", async () => {
    saveElizaConfig(freshStableCache());

    const result = await checkForUpdate();

    expect(result.channel).toBe("stable");
    expect(result.latestVersion).toBe(DIST_TAGS.latest);
    expect(result.cached).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  it("records the channel a live check was made for", async () => {
    saveElizaConfig({ update: { channel: "beta" } } as ElizaConfig);

    const result = await checkForUpdate();
    const saved = loadElizaConfig();

    expect(result.cached).toBe(false);
    expect(result.latestVersion).toBe(DIST_TAGS.beta);
    expect(saved.update?.lastCheckChannel).toBe("beta");
    expect(saved.update?.lastCheckVersion).toBe(DIST_TAGS.beta);
  });
});
