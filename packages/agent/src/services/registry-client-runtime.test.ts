/**
 * Exercises registry authority caching with real cache stores and deterministic
 * clocks. Network responses are in-memory protocol fixtures; concurrency,
 * cancellation, disk fencing, overlay isolation, and mutation boundaries use
 * the production RegistryClient implementation without a fake runtime.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_REGISTRY_JSON_BYTES } from "./registry-client-network.ts";
import {
  createFileRegistryCacheStore,
  type RegistryCacheRecord,
  type RegistryCacheStore,
  RegistryClient,
} from "./registry-client-runtime.ts";
import type { RegistryPluginInfo } from "./registry-client-types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

function plugin(name: string, description = "upstream"): RegistryPluginInfo {
  return {
    name,
    gitRepo: `fixture/${name}`,
    gitUrl: `https://github.com/fixture/${name}.git`,
    directory: null,
    description,
    homepage: null,
    topics: [],
    stars: 0,
    language: "TypeScript",
    npm: {
      package: name,
      v0Version: null,
      v1Version: null,
      v2Version: "1.0.0",
    },
    git: { v0Branch: null, v1Branch: null, v2Branch: "main" },
    supports: { v0: false, v1: false, v2: true },
  };
}

function record(fetchedAt: number, name = "plugin-a"): RegistryCacheRecord {
  return {
    fetchedAt,
    sourceUrl: "https://registry.example/generated-registry.json",
    etag: '"fixture"',
    plugins: [[name, plugin(name)]],
  };
}

function registryResponse(name: string): Response {
  const entry = plugin(name);
  return Response.json({
    registry: {
      [name]: {
        git: {
          repo: entry.gitRepo,
          v0: { branch: null },
          v1: { branch: null },
          v2: { branch: "main" },
        },
        npm: {
          repo: name,
          v0: null,
          v1: null,
          v2: "1.0.0",
        },
        supports: entry.supports,
        directory: null,
        description: entry.description,
        homepage: null,
        topics: [],
        stargazers_count: 0,
        language: "TypeScript",
      },
    },
  });
}

function client(options: {
  cacheStore: RegistryCacheStore;
  now?: () => number;
  fetchImpl?: () => Promise<Response>;
  applyLocalWorkspaceApps?: (
    plugins: Map<string, RegistryPluginInfo>,
  ) => Promise<void>;
}): RegistryClient {
  return new RegistryClient({
    generatedRegistryUrl: "https://registry.example/generated-registry.json",
    indexRegistryUrl: "https://registry.example/index.json",
    cacheStore: options.cacheStore,
    now: options.now,
    cacheTtlMs: 100,
    fetchImpl: options.fetchImpl,
    cloudReachable: async () => true,
    applyLocalWorkspaceApps:
      options.applyLocalWorkspaceApps ?? (async () => {}),
    applyNodeModulePlugins: async () => {},
    sanitizeSandbox: (value) => value ?? "allow-scripts",
    getConfiguredEndpoints: () => [],
    mergeCustomEndpoints: async () => {},
  });
}

describe("RegistryClient authority isolation", () => {
  it("preserves a nearly expired disk age when promoting it to memory", async () => {
    let now = 99;
    let fetchCalls = 0;
    const instance = client({
      cacheStore: {
        read: async () => record(0),
        write: async () => true,
        remove: async () => {},
      },
      now: () => now,
      fetchImpl: async () => {
        fetchCalls += 1;
        return registryResponse("plugin-network");
      },
    });

    expect([...(await instance.getRegistryPlugins()).keys()]).toEqual([
      "plugin-a",
    ]);
    now = 101;
    expect([...(await instance.getRegistryPlugins()).keys()]).toEqual([
      "plugin-network",
    ]);
    expect(fetchCalls).toBe(1);
  });

  it("reapplies overlays per read without caching them or caller mutations", async () => {
    let overlayGeneration = 0;
    const authority = record(0);
    const instance = client({
      cacheStore: {
        read: async () => structuredClone(authority),
        write: async () => true,
        remove: async () => {},
      },
      now: () => 1,
      applyLocalWorkspaceApps: async (plugins) => {
        overlayGeneration += 1;
        const upstream = plugins.get("plugin-a");
        if (upstream) upstream.description = `overlay-${overlayGeneration}`;
        plugins.set("plugin-local", plugin("plugin-local"));
      },
    });

    const first = await instance.getRegistryPlugins();
    expect(first.get("plugin-a")?.description).toBe("overlay-1");
    first.delete("plugin-a");
    const local = first.get("plugin-local");
    if (local) local.description = "caller-corruption";

    const second = await instance.getRegistryPlugins();
    expect(second.get("plugin-a")?.description).toBe("overlay-2");
    expect(second.get("plugin-local")?.description).toBe("upstream");
    expect(authority.plugins[0]?.[1].description).toBe("upstream");
    expect(first).not.toBe(second);
  });

  it("generation-fences a delayed disk promotion across refresh", async () => {
    let releaseFirstRead: ((value: RegistryCacheRecord) => void) | undefined;
    let reads = 0;
    const delayed = new Promise<RegistryCacheRecord>((resolve) => {
      releaseFirstRead = resolve;
    });
    const store: RegistryCacheStore = {
      read: async () => {
        reads += 1;
        return reads === 1 ? delayed : null;
      },
      write: async (_record, shouldCommit) => shouldCommit(),
      remove: async () => {},
    };
    const instance = client({
      cacheStore: store,
      now: () => 1,
      fetchImpl: async () => registryResponse("plugin-network"),
    });

    const stale = instance.getRegistryPlugins();
    const refreshed = instance.refreshRegistry();
    expect([...(await refreshed).keys()]).toEqual(["plugin-network"]);
    releaseFirstRead?.(record(0, "plugin-stale"));
    expect([...(await stale).keys()]).toEqual(["plugin-stale"]);
    expect([...(await instance.getRegistryPlugins()).keys()]).toEqual([
      "plugin-network",
    ]);
  });

  it("isolates caller cancellation while preserving one shared load", async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    let fetchCalls = 0;
    const response = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const instance = client({
      cacheStore: {
        read: async () => null,
        write: async () => true,
        remove: async () => {},
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        return response;
      },
    });
    const controller = new AbortController();
    const cancelled = instance.getRegistryPlugins({
      signal: controller.signal,
    });
    const survivor = instance.getRegistryPlugins();
    controller.abort(new DOMException("caller stopped", "AbortError"));

    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    resolveFetch?.(registryResponse("plugin-network"));
    expect([...(await survivor).keys()]).toEqual(["plugin-network"]);
    expect(fetchCalls).toBe(1);
    expect([...(await instance.getRegistryPlugins()).keys()]).toEqual([
      "plugin-network",
    ]);
  });
});

describe("file registry cache admission", () => {
  it("bounds bytes, rejects invalid UTF-8, and cleans fenced temp writes", async () => {
    const directory = await fs.mkdtemp(
      path.join(os.tmpdir(), "registry-cache-admission-"),
    );
    temporaryDirectories.push(directory);
    const file = path.join(directory, "registry.json");
    const store = createFileRegistryCacheStore(file);

    await fs.writeFile(file, new Uint8Array(MAX_REGISTRY_JSON_BYTES + 1));
    await expect(store.read()).resolves.toBeNull();
    await fs.writeFile(file, Uint8Array.from([0xc3, 0x28]));
    await expect(store.read()).resolves.toBeNull();

    await expect(store.write(record(0), () => false)).resolves.toBe(false);
    expect(
      (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);

    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename denied"));
    await expect(store.write(record(0), () => true)).rejects.toThrow(
      "rename denied",
    );
    expect(
      (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });
});
