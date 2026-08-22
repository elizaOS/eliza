/**
 * `refreshRegistry` clears the caches and then delegates to
 * `getRegistryPlugins`, which returns any load that is already in flight. That
 * load carries a pre-refresh snapshot, so a force-refresh must not adopt it —
 * nor let it stamp a fresh TTL over the refreshed result afterwards.
 *
 * The registry caches are module-level, so every case re-imports the module
 * through `vi.resetModules()`.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let stateDir: string;
let fetchImpl: () => Promise<Map<string, unknown>>;
let fetchCalls = 0;

vi.mock("../config/paths.ts", () => ({
  resolveStateDir: () => stateDir,
}));

vi.mock("../config/config.ts", () => ({
  loadElizaConfig: () => ({}),
  saveElizaConfig: () => {},
}));

vi.mock("./registry-client-local.ts", () => ({
  applyLocalWorkspaceApps: async () => {},
  applyNodeModulePlugins: async () => {},
}));

vi.mock("./registry-client-network.ts", () => ({
  fetchRegistrySnapshot: async () => {
    fetchCalls += 1;
    return {
      sourceUrl: "https://plugins.eliza.app/generated-registry.json",
      etag: '"fixture"',
      plugins: await fetchImpl(),
      notModified: false,
    };
  },
  isExpectedRegistryNetworkFallback: () => true,
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const plugin = (name: string) => ({
  name,
  gitRepo: `fixture/${name}`,
  gitUrl: `https://github.com/fixture/${name}.git`,
  directory: null,
  description: "fixture",
  homepage: null,
  topics: [],
  stars: 0,
  language: "TypeScript",
  npm: { package: name, v0Version: null, v1Version: null, v2Version: "1.0.0" },
  git: { v0Branch: null, v1Branch: null, v2Branch: "main" },
  supports: { v0: false, v1: false, v2: true },
});
const PAYLOAD_A = () => new Map([["plugin-a", plugin("plugin-a")]]);
const PAYLOAD_B = () => new Map([["plugin-b", plugin("plugin-b")]]);

async function loadModule() {
  vi.resetModules();
  return import("./registry-client.ts");
}

beforeEach(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "registry-refresh-"));
  fetchCalls = 0;
  fetchImpl = async () => PAYLOAD_A();
});

afterEach(async () => {
  await fsp.rm(stateDir, { recursive: true, force: true });
});

describe("refreshRegistry", () => {
  it("does not adopt a load that started before the refresh", async () => {
    fetchImpl = async () => {
      await sleep(200);
      return PAYLOAD_A();
    };
    const { getRegistryPlugins, refreshRegistry } = await loadModule();

    const inFlight = getRegistryPlugins();
    await sleep(20);
    fetchImpl = async () => PAYLOAD_B();

    const refreshed = await refreshRegistry();
    expect([...refreshed.keys()]).toEqual(["plugin-b"]);

    // The refreshed snapshot must also survive the older load completing.
    expect([...(await getRegistryPlugins()).keys()]).toEqual(["plugin-b"]);
    await inFlight;
    expect([...(await getRegistryPlugins()).keys()]).toEqual(["plugin-b"]);
  });

  it("still refetches when no load is in flight", async () => {
    const { refreshRegistry } = await loadModule();

    const refreshed = await refreshRegistry();

    expect([...refreshed.keys()]).toEqual(["plugin-a"]);
    expect(fetchCalls).toBe(1);
  });

  it("still shares one load between concurrent callers", async () => {
    fetchImpl = async () => {
      await sleep(50);
      return PAYLOAD_A();
    };
    const { getRegistryPlugins } = await loadModule();

    const [first, second, third] = await Promise.all([
      getRegistryPlugins(),
      getRegistryPlugins(),
      getRegistryPlugins(),
    ]);

    expect(fetchCalls).toBe(1);
    expect(first).toBe(second);
    expect(second).toBe(third);
  });

  it("still serves a fresh file cache without a network call", async () => {
    await fsp.mkdir(path.join(stateDir, "cache"), { recursive: true });
    await fsp.writeFile(
      path.join(stateDir, "cache", "registry.json"),
      JSON.stringify({
        fetchedAt: Date.now(),
        sourceUrl: "https://plugins.eliza.app/generated-registry.json",
        etag: '"fixture"',
        plugins: [["plugin-file", plugin("plugin-file")]],
      }),
    );
    const { getRegistryPlugins } = await loadModule();

    expect([...(await getRegistryPlugins()).keys()]).toEqual(["plugin-file"]);
    expect(fetchCalls).toBe(0);
  });
});
