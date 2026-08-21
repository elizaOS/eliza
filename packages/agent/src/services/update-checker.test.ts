/**
 * The persisted update cache stores `lastCheckAt` and `lastCheckVersion`. Both
 * config-mutating channel changes clear those fields, but `resolveChannel` also
 * honours `ELIZA_UPDATE_CHANNEL`, which writes nothing — so the cache has to
 * record which channel produced it or it will be served under another one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ElizaConfig } from "../config/types.eliza.ts";

const state: { config: ElizaConfig; saved: ElizaConfig | null } = {
  config: {} as ElizaConfig,
  saved: null,
};

vi.mock("../config/config.ts", () => ({
  loadElizaConfig: () => state.config,
  saveElizaConfig: (next: ElizaConfig) => {
    state.saved = next;
  },
}));

vi.mock("../runtime/version.ts", () => ({ VERSION: "2.0.0" }));

import { checkForUpdate } from "./update-checker.ts";

const DIST_TAGS = {
  latest: "9.9.9",
  beta: "9.9.9-beta.1",
  nightly: "9.9.9-nightly.1",
};

let fetchCalls = 0;
const originalFetch = globalThis.fetch;
const originalChannelEnv = process.env.ELIZA_UPDATE_CHANNEL;

beforeEach(() => {
  fetchCalls = 0;
  state.saved = null;
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
  if (originalChannelEnv === undefined) {
    delete process.env.ELIZA_UPDATE_CHANNEL;
  } else {
    process.env.ELIZA_UPDATE_CHANNEL = originalChannelEnv;
  }
});

function freshStableCache(): ElizaConfig {
  return {
    update: {
      channel: "stable",
      lastCheckAt: new Date().toISOString(),
      lastCheckVersion: "9.9.9",
      lastCheckChannel: "stable",
    },
  } as ElizaConfig;
}

describe("checkForUpdate release-channel cache", () => {
  it("does not serve a stable cache under ELIZA_UPDATE_CHANNEL=beta", async () => {
    state.config = freshStableCache();
    process.env.ELIZA_UPDATE_CHANNEL = "beta";

    const result = await checkForUpdate();

    expect(result.channel).toBe("beta");
    expect(result.distTag).toBe("beta");
    // The bug returns the stable dist-tag's version under channel "beta".
    expect(result.latestVersion).toBe("9.9.9-beta.1");
    expect(result.cached).toBe(false);
    expect(fetchCalls).toBe(1);
  });

  it("still serves a fresh cache for the channel that produced it", async () => {
    state.config = freshStableCache();
    delete process.env.ELIZA_UPDATE_CHANNEL;

    const result = await checkForUpdate();

    expect(result.channel).toBe("stable");
    expect(result.latestVersion).toBe("9.9.9");
    expect(result.cached).toBe(true);
    expect(fetchCalls).toBe(0);
  });

  it("records the channel a live check was made for", async () => {
    state.config = { update: { channel: "beta" } } as ElizaConfig;
    delete process.env.ELIZA_UPDATE_CHANNEL;

    const result = await checkForUpdate();

    expect(result.cached).toBe(false);
    expect(result.latestVersion).toBe("9.9.9-beta.1");
    expect(state.saved?.update?.lastCheckChannel).toBe("beta");
    expect(state.saved?.update?.lastCheckVersion).toBe("9.9.9-beta.1");
  });
});
