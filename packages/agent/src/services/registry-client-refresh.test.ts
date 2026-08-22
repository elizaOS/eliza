/**
 * `refreshRegistry` clears the caches and then delegates to
 * `getRegistryPlugins`, which returns any load that is already in flight. That
 * load carries a pre-refresh snapshot, so a force-refresh must not adopt it —
 * nor let it stamp a fresh TTL over the refreshed result afterwards.
 *
 * The registry caches are module-level, so every case re-imports the module
 * through `vi.resetModules()`. The listing-route case uses the real refresh
 * function so cache teardown failures are covered at the HTTP boundary too.
 */

import fsp from "node:fs/promises";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleRegistryRoutes,
  type RegistryRouteContext,
} from "../api/registry-routes.ts";

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
const PAYLOAD_A = () =>
  new Map([["plugin-a", { name: "plugin-a", npm: { v2Version: null } }]]);
const PAYLOAD_B = () =>
  new Map([["plugin-b", { name: "plugin-b", npm: { v2Version: null } }]]);

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
    "still returns fresh network data when cache removal fails with %s",
    async (code) => {
      const cachePath = path.join(stateDir, "cache", "registry.json");
      await fsp.mkdir(path.dirname(cachePath), { recursive: true });
      await fsp.writeFile(
        cachePath,
        JSON.stringify({
          fetchedAt: Date.now(),
          plugins: [...PAYLOAD_A().entries()],
        }),
      );
      fetchImpl = async () => PAYLOAD_B();
      const cause = Object.assign(new Error(`unlink failed: ${code}`), {
        code,
      });
      vi.spyOn(fsp, "unlink").mockRejectedValueOnce(cause);
      const registry = await loadModule();

      const refreshed = await registry.refreshRegistry();

      expect([...refreshed.keys()]).toEqual(["plugin-b"]);
      expect([...(await registry.getRegistryPlugins()).keys()]).toEqual([
        "plugin-b",
      ]);
      expect(fetchCalls).toBe(1);
    },
  );

  it("keeps GET /api/registry/plugins available when cache removal fails", async () => {
    const cachePath = path.join(stateDir, "cache", "registry.json");
    await fsp.mkdir(path.dirname(cachePath), { recursive: true });
    await fsp.writeFile(
      cachePath,
      JSON.stringify({
        fetchedAt: Date.now(),
        plugins: [...PAYLOAD_A().entries()],
      }),
    );
    fetchImpl = async () => PAYLOAD_B();
    vi.spyOn(fsp, "unlink").mockRejectedValueOnce(
      Object.assign(new Error("permission denied"), { code: "EACCES" }),
    );
    const registry = await loadModule();
    const json = vi.fn();
    const error = vi.fn();
    const res = {} as http.ServerResponse;
    const ctx = {
      req: { method: "GET", url: "/api/registry/plugins" },
      res,
      method: "GET",
      pathname: "/api/registry/plugins",
      url: new URL("http://localhost/api/registry/plugins"),
      json,
      error,
      getPluginManager: () => ({
        refreshRegistry: registry.refreshRegistry,
        listInstalledPlugins: async () => [],
        getRegistryPlugin: async () => null,
        searchRegistry: async () => [],
      }),
      getLoadedPluginNames: () => [],
      getBundledPluginIds: () => new Set<string>(),
      classifyRegistryPluginRelease: () => ({ status: "compatible" }),
    } as unknown as RegistryRouteContext;

    await expect(handleRegistryRoutes(ctx)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(res, {
      count: 1,
      plugins: [expect.objectContaining({ name: "plugin-b" })],
    });
    expect(fetchCalls).toBe(1);
  });

  it("still supersedes an in-flight load when cache removal fails", async () => {
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
    fetchImpl = async () => PAYLOAD_B();

    const cause = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    });
    vi.spyOn(fsp, "unlink").mockRejectedValueOnce(cause);
    const refreshed = await registry.refreshRegistry();

    expect([...refreshed.keys()]).toEqual(["plugin-b"]);
    expect(fetchCalls).toBe(2);
    releaseFetch?.();

    expect([...(await first).keys()]).toEqual(["plugin-a"]);
    expect([...(await registry.getRegistryPlugins()).keys()]).toEqual([
      "plugin-b",
    ]);
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
