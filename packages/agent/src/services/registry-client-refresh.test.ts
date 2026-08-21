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
  fetchFromNetwork: async () => {
    fetchCalls += 1;
    return fetchImpl();
  },
  isExpectedRegistryNetworkFallback: () => true,
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PAYLOAD_A = () => new Map([["plugin-a", { name: "plugin-a" }]]);
const PAYLOAD_B = () => new Map([["plugin-b", { name: "plugin-b" }]]);

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
  vi.restoreAllMocks();
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
        plugins: [["plugin-file", { name: "plugin-file" }]],
      }),
    );
    const { getRegistryPlugins } = await loadModule();

    expect([...(await getRegistryPlugins()).keys()]).toEqual(["plugin-file"]);
    expect(fetchCalls).toBe(0);
  });

  it.each(["EACCES", "EROFS"] as const)(
    "rejects a %s cache removal failure with a typed error",
    async (code) => {
      const cause = Object.assign(new Error(`unlink failed: ${code}`), {
        code,
      });
      vi.spyOn(fsp, "unlink").mockRejectedValueOnce(cause);
      const registry = await loadModule();

      const error = await registry.refreshRegistry().catch((caught) => caught);

      expect(error).toBeInstanceOf(registry.RegistryCacheInvalidationError);
      expect(error).toMatchObject({
        name: "RegistryCacheInvalidationError",
        code: "REGISTRY_CACHE_INVALIDATION_FAILED",
        cause,
      });
      expect(fetchCalls).toBe(0);
    },
  );

  it("does not abandon an in-flight load when cache removal fails", async () => {
    let releaseFetch: (() => void) | undefined;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    fetchImpl = async () => {
      await fetchGate;
      return PAYLOAD_A();
    };
    const registry = await loadModule();
    const first = registry.getRegistryPlugins();
    while (fetchCalls === 0) await sleep(1);

    const cause = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    vi.spyOn(fsp, "unlink").mockRejectedValueOnce(cause);
    const refresh = registry.refreshRegistry().catch((caught) => caught);
    await sleep(10);
    const second = registry.getRegistryPlugins();
    // `getRegistryPlugins` checks the file tier before the shared network slot.
    // Keep the first fetch gated until the second caller has reached that slot.
    await sleep(50);
    releaseFetch?.();

    const [firstResult, secondResult, refreshError] = await Promise.all([
      first,
      second,
      refresh,
    ]);
    expect(refreshError).toBeInstanceOf(
      registry.RegistryCacheInvalidationError,
    );
    expect(fetchCalls).toBe(1);
    expect(secondResult).toBe(firstResult);
  });

  it("does not publish a file-cache read that began before refresh", async () => {
    const cachePath = path.join(stateDir, "cache", "registry.json");
    const staleCache = JSON.stringify({
      fetchedAt: Date.now(),
      plugins: [...PAYLOAD_A().entries()],
    });
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(cachePath, staleCache);

    let signalReadStarted: (() => void) | undefined;
    const readStarted = new Promise<void>((resolve) => {
      signalReadStarted = resolve;
    });
    let releaseRead: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    vi.spyOn(fsp, "readFile").mockImplementationOnce(async () => {
      signalReadStarted?.();
      await readGate;
      return staleCache;
    });
    fetchImpl = async () => PAYLOAD_B();
    const registry = await loadModule();

    const staleCaller = registry.getRegistryPlugins();
    await readStarted;
    const refreshed = await registry.refreshRegistry();
    expect([...refreshed.keys()]).toEqual(["plugin-b"]);

    releaseRead?.();
    expect([...(await staleCaller).keys()]).toEqual(["plugin-a"]);
    expect([...(await registry.getRegistryPlugins()).keys()]).toEqual([
      "plugin-b",
    ]);
  });
});
