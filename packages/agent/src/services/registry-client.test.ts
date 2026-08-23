/**
 * Behavioural coverage for the public registry-client surface: custom-endpoint
 * CRUD (empty, duplicate, default, missing), cache-tier resolution (memory →
 * file → network, expiry, malformed file, local fallback TTL), and the query
 * projections (lookup aliases, search limit/ties, app vs non-app listing).
 * Network, local discovery, and custom-endpoint HTTP are seams; parse, cache,
 * sort, and DTO mapping run on the real module. Module-level caches are reset
 * with `vi.resetModules()` so cases cannot leak TTL or snapshots.
 */

import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RegistryEndpoint } from "../config/types.eliza.ts";
import type {
  RegistryAppMeta,
  RegistryPluginInfo,
} from "./registry-client-types.ts";

let stateDir: string;
let fetchImpl: () => Promise<Map<string, RegistryPluginInfo>>;
let fetchCalls = 0;
let config: { plugins?: { registryEndpoints?: RegistryEndpoint[] } };
let configLoadError: Error | null = null;
let mergeCalls: Array<{
  pluginCount: number;
  endpoints: RegistryEndpoint[];
}>;
let localPlugins: RegistryPluginInfo[] = [];

vi.mock("../config/paths.ts", () => ({
  resolveStateDir: () => stateDir,
}));

vi.mock("../config/config.ts", () => ({
  loadElizaConfig: () => {
    if (configLoadError) throw configLoadError;
    return config;
  },
  saveElizaConfig: (next: typeof config) => {
    config = next;
  },
}));

vi.mock("./registry-client-local.ts", () => ({
  applyLocalWorkspaceApps: async (plugins: Map<string, RegistryPluginInfo>) => {
    for (const entry of localPlugins) plugins.set(entry.name, entry);
  },
  applyNodeModulePlugins: async () => {},
}));

vi.mock("./registry-client-network.ts", () => ({
  fetchFromNetwork: async () => {
    fetchCalls += 1;
    return fetchImpl();
  },
  isExpectedRegistryNetworkFallback: (error: unknown) =>
    error instanceof Error &&
    (error.name === "TimeoutError" ||
      error.message.toLowerCase().includes("timeout")),
}));

vi.mock("./registry-client-endpoints.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./registry-client-endpoints.ts")>();
  return {
    ...actual,
    mergeCustomEndpoints: async (
      plugins: Map<string, RegistryPluginInfo>,
      endpoints: RegistryEndpoint[],
    ) => {
      mergeCalls.push({
        pluginCount: plugins.size,
        endpoints: [...endpoints],
      });
    },
  };
});

const DEFAULT_REGISTRY_URL =
  "https://plugins.eliza.app/generated-registry.json";
const CUSTOM_ENDPOINT_URL = "https://1.1.1.1/registry";
const CACHE_TTL_MS = 3_600_000;
const LOCAL_FALLBACK_CACHE_TTL_MS = 5 * 60_000;

function plugin(
  extras: Partial<RegistryPluginInfo> & Pick<RegistryPluginInfo, "name">,
): RegistryPluginInfo {
  return {
    gitRepo: `elizaos/${extras.name.replace(/^@elizaos\//, "")}`,
    gitUrl: `https://github.com/elizaos/${extras.name.replace(/^@elizaos\//, "")}.git`,
    directory: null,
    description: `${extras.name} description`,
    homepage: null,
    topics: [],
    stars: 0,
    language: "TypeScript",
    npm: {
      package: extras.name,
      v0Version: null,
      v1Version: null,
      v2Version: extras.name.endsWith("-v2") ? "2.0.0" : null,
    },
    git: { v0Branch: null, v1Branch: null, v2Branch: null },
    supports: { v0: false, v1: false, v2: true },
    ...extras,
  };
}

function appMeta(
  extras: Partial<RegistryAppMeta> & Pick<RegistryAppMeta, "displayName">,
): RegistryAppMeta {
  return {
    category: "game",
    launchType: "url",
    launchUrl: "https://example.test/app",
    icon: null,
    heroImage: null,
    capabilities: [],
    minPlayers: null,
    maxPlayers: null,
    ...extras,
  };
}

function appPlugin(
  name: string,
  stars: number,
  meta: Partial<RegistryAppMeta> & Pick<RegistryAppMeta, "displayName">,
): RegistryPluginInfo {
  return plugin({
    name,
    kind: "app",
    stars,
    appMeta: appMeta(meta),
  });
}

async function loadModule() {
  vi.resetModules();
  return import("./registry-client.ts");
}

async function cachePath(): Promise<string> {
  return path.join(stateDir, "cache", "registry.json");
}

async function writeFileCache(
  plugins: Array<[string, RegistryPluginInfo]>,
  fetchedAt = Date.now(),
): Promise<void> {
  const filePath = await cachePath();
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(
    filePath,
    JSON.stringify({ fetchedAt, plugins }),
    "utf-8",
  );
}

beforeEach(async () => {
  stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), "registry-client-"));
  fetchCalls = 0;
  fetchImpl = async () => new Map();
  config = {};
  configLoadError = null;
  mergeCalls = [];
  localPlugins = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(stateDir, { recursive: true, force: true });
});

describe("getConfiguredEndpoints", () => {
  it("returns an empty list when config has no plugins block", async () => {
    const { getConfiguredEndpoints } = await loadModule();
    expect(getConfiguredEndpoints()).toEqual([]);
  });

  it("returns an empty list when registryEndpoints is missing", async () => {
    config = { plugins: {} };
    const { getConfiguredEndpoints } = await loadModule();
    expect(getConfiguredEndpoints()).toEqual([]);
  });

  it("returns the configured endpoints in insertion order", async () => {
    config = {
      plugins: {
        registryEndpoints: [
          { label: "one", url: "https://1.1.1.1/a", enabled: true },
          { label: "two", url: "https://8.8.8.8/b", enabled: false },
        ],
      },
    };
    const { getConfiguredEndpoints } = await loadModule();
    expect(getConfiguredEndpoints()).toEqual([
      { label: "one", url: "https://1.1.1.1/a", enabled: true },
      { label: "two", url: "https://8.8.8.8/b", enabled: false },
    ]);
  });

  it("returns an empty list when config load throws", async () => {
    configLoadError = new Error("config unreadable");
    const { getConfiguredEndpoints } = await loadModule();

    expect(getConfiguredEndpoints()).toEqual([]);
  });
});

describe("isDefaultEndpoint", () => {
  it("treats the generated-registry URL as the default, including a trailing slash", async () => {
    const { isDefaultEndpoint } = await loadModule();
    expect(isDefaultEndpoint(DEFAULT_REGISTRY_URL)).toBe(true);
    expect(isDefaultEndpoint(`${DEFAULT_REGISTRY_URL}/`)).toBe(true);
  });

  it("does not treat the index URL or an unrelated host as the default", async () => {
    const { isDefaultEndpoint } = await loadModule();
    expect(isDefaultEndpoint("https://plugins.eliza.app/index.json")).toBe(
      false,
    );
    expect(isDefaultEndpoint(CUSTOM_ENDPOINT_URL)).toBe(false);
  });
});

describe("addRegistryEndpoint", () => {
  it("appends a normalised https endpoint and enables it", async () => {
    const { addRegistryEndpoint, getConfiguredEndpoints } = await loadModule();

    addRegistryEndpoint("mirror", `${CUSTOM_ENDPOINT_URL}/`);

    expect(getConfiguredEndpoints()).toEqual([
      { label: "mirror", url: CUSTOM_ENDPOINT_URL, enabled: true },
    ]);
  });

  it("creates the plugins block when config has none", async () => {
    config = {};
    const { addRegistryEndpoint, getConfiguredEndpoints } = await loadModule();

    addRegistryEndpoint("mirror", CUSTOM_ENDPOINT_URL);

    expect(config.plugins?.registryEndpoints).toEqual([
      { label: "mirror", url: CUSTOM_ENDPOINT_URL, enabled: true },
    ]);
    expect(getConfiguredEndpoints()).toHaveLength(1);
  });

  it("rejects the default registry URL", async () => {
    const { addRegistryEndpoint, getConfiguredEndpoints } = await loadModule();

    expect(() => addRegistryEndpoint("official", DEFAULT_REGISTRY_URL)).toThrow(
      "Cannot add the default registry as a custom endpoint.",
    );
    expect(() =>
      addRegistryEndpoint("official", `${DEFAULT_REGISTRY_URL}/`),
    ).toThrow("Cannot add the default registry as a custom endpoint.");
    expect(getConfiguredEndpoints()).toEqual([]);
  });

  it("rejects a duplicate URL after normalisation", async () => {
    const { addRegistryEndpoint } = await loadModule();
    addRegistryEndpoint("mirror", CUSTOM_ENDPOINT_URL);

    expect(() =>
      addRegistryEndpoint("again", `${CUSTOM_ENDPOINT_URL}/`),
    ).toThrow(`Endpoint already exists: ${CUSTOM_ENDPOINT_URL}/`);
  });

  it("rejects a relative URL, http, and a blocked host", async () => {
    const { addRegistryEndpoint } = await loadModule();

    expect(() => addRegistryEndpoint("bad", "not-a-url")).toThrow(
      "Endpoint URL must be a valid absolute URL",
    );
    expect(() => addRegistryEndpoint("bad", "http://1.1.1.1/registry")).toThrow(
      "Endpoint URL must use https://",
    );
    expect(() =>
      addRegistryEndpoint("bad", "https://localhost/registry"),
    ).toThrow('Endpoint host "localhost" is blocked');
  });
});

describe("removeRegistryEndpoint", () => {
  it("removes a matching endpoint by normalised URL", async () => {
    const {
      addRegistryEndpoint,
      removeRegistryEndpoint,
      getConfiguredEndpoints,
    } = await loadModule();
    addRegistryEndpoint("mirror", CUSTOM_ENDPOINT_URL);
    addRegistryEndpoint("other", "https://8.8.8.8/registry");

    removeRegistryEndpoint(`${CUSTOM_ENDPOINT_URL}/`);

    expect(getConfiguredEndpoints()).toEqual([
      { label: "other", url: "https://8.8.8.8/registry", enabled: true },
    ]);
  });

  it("cannot remove the default registry", async () => {
    const { removeRegistryEndpoint } = await loadModule();
    expect(() => removeRegistryEndpoint(DEFAULT_REGISTRY_URL)).toThrow(
      "Cannot remove the default elizaOS registry.",
    );
  });

  it("throws when the URL is not in the configured list", async () => {
    const { removeRegistryEndpoint } = await loadModule();
    expect(() => removeRegistryEndpoint(CUSTOM_ENDPOINT_URL)).toThrow(
      `Endpoint not found: ${CUSTOM_ENDPOINT_URL}`,
    );
  });
});

describe("toggleRegistryEndpoint", () => {
  it("flips enabled on the matching endpoint", async () => {
    const {
      addRegistryEndpoint,
      toggleRegistryEndpoint,
      getConfiguredEndpoints,
    } = await loadModule();
    addRegistryEndpoint("mirror", CUSTOM_ENDPOINT_URL);

    toggleRegistryEndpoint(`${CUSTOM_ENDPOINT_URL}/`, false);
    expect(getConfiguredEndpoints()[0]?.enabled).toBe(false);

    toggleRegistryEndpoint(CUSTOM_ENDPOINT_URL, true);
    expect(getConfiguredEndpoints()[0]?.enabled).toBe(true);
  });

  it("throws when the URL is not in the configured list", async () => {
    const { toggleRegistryEndpoint } = await loadModule();
    expect(() => toggleRegistryEndpoint(CUSTOM_ENDPOINT_URL, false)).toThrow(
      `Endpoint not found: ${CUSTOM_ENDPOINT_URL}`,
    );
  });
});

describe("getRegistryPlugins", () => {
  it("returns an empty map when the network snapshot is empty", async () => {
    const { getRegistryPlugins } = await loadModule();
    const plugins = await getRegistryPlugins();
    expect(plugins.size).toBe(0);
    expect(fetchCalls).toBe(1);
  });

  it("returns the network snapshot and serves later callers from memory", async () => {
    const alpha = plugin({ name: "@elizaos/plugin-alpha" });
    fetchImpl = async () => new Map([[alpha.name, alpha]]);
    const { getRegistryPlugins } = await loadModule();

    const first = await getRegistryPlugins();
    const second = await getRegistryPlugins();

    expect([...first.keys()]).toEqual([alpha.name]);
    expect(second).toBe(first);
    expect(fetchCalls).toBe(1);
  });

  it("serves a fresh file cache without a network call and merges configured endpoints", async () => {
    const cached = plugin({ name: "plugin-file" });
    await writeFileCache([[cached.name, cached]]);
    config = {
      plugins: {
        registryEndpoints: [
          { label: "mirror", url: CUSTOM_ENDPOINT_URL, enabled: true },
        ],
      },
    };
    const { getRegistryPlugins } = await loadModule();

    expect([...(await getRegistryPlugins()).keys()]).toEqual([cached.name]);
    expect(fetchCalls).toBe(0);
    expect(mergeCalls).toEqual([
      {
        pluginCount: 1,
        endpoints: [
          { label: "mirror", url: CUSTOM_ENDPOINT_URL, enabled: true },
        ],
      },
    ]);
  });

  it("ignores an expired file cache and fetches the network", async () => {
    const network = plugin({ name: "plugin-net" });
    fetchImpl = async () => new Map([[network.name, network]]);
    await writeFileCache(
      [[plugin({ name: "stale" }).name, plugin({ name: "stale" })]],
      Date.now() - CACHE_TTL_MS - 1,
    );
    const { getRegistryPlugins } = await loadModule();

    expect([...(await getRegistryPlugins()).keys()]).toEqual([network.name]);
    expect(fetchCalls).toBe(1);
  });

  it("ignores malformed JSON in the file cache and fetches the network", async () => {
    const network = plugin({ name: "plugin-net" });
    fetchImpl = async () => new Map([[network.name, network]]);
    await fsp.mkdir(path.join(stateDir, "cache"), { recursive: true });
    await fsp.writeFile(await cachePath(), "{not-json", "utf-8");
    const { getRegistryPlugins } = await loadModule();

    expect([...(await getRegistryPlugins()).keys()]).toEqual([network.name]);
    expect(fetchCalls).toBe(1);
  });

  it("ignores a file cache whose fetchedAt is not a number", async () => {
    const network = plugin({ name: "plugin-net" });
    fetchImpl = async () => new Map([[network.name, network]]);
    await fsp.mkdir(path.join(stateDir, "cache"), { recursive: true });
    await fsp.writeFile(
      await cachePath(),
      JSON.stringify({ fetchedAt: "yesterday", plugins: [] }),
      "utf-8",
    );
    const { getRegistryPlugins } = await loadModule();

    expect([...(await getRegistryPlugins()).keys()]).toEqual([network.name]);
    expect(fetchCalls).toBe(1);
  });

  it("ignores a file cache whose plugins field is not an array", async () => {
    const network = plugin({ name: "plugin-net" });
    fetchImpl = async () => new Map([[network.name, network]]);
    await fsp.mkdir(path.join(stateDir, "cache"), { recursive: true });
    await fsp.writeFile(
      await cachePath(),
      JSON.stringify({ fetchedAt: Date.now(), plugins: { not: "array" } }),
      "utf-8",
    );
    const { getRegistryPlugins } = await loadModule();

    expect([...(await getRegistryPlugins()).keys()]).toEqual([network.name]);
    expect(fetchCalls).toBe(1);
  });

  it("falls back to local discovery when the network fails, with a shorter TTL", async () => {
    const local = plugin({ name: "plugin-local" });
    localPlugins = [local];
    fetchImpl = async () => {
      throw new Error("connect timeout");
    };
    const now = Date.now();
    let current = now;
    vi.spyOn(Date, "now").mockImplementation(() => current);
    const { getRegistryPlugins } = await loadModule();

    expect([...(await getRegistryPlugins()).keys()]).toEqual([local.name]);
    expect(fetchCalls).toBe(1);

    current = now + LOCAL_FALLBACK_CACHE_TTL_MS - 1;
    expect(fetchCalls).toBe(1);
    await getRegistryPlugins();
    expect(fetchCalls).toBe(1);

    const replacement = plugin({ name: "plugin-net" });
    fetchImpl = async () => new Map([[replacement.name, replacement]]);
    current = now + LOCAL_FALLBACK_CACHE_TTL_MS + 1;
    expect([...(await getRegistryPlugins()).keys()]).toEqual([
      replacement.name,
    ]);
    expect(fetchCalls).toBe(2);
  });

  it("still falls back for an unexpected network error", async () => {
    const local = plugin({ name: "plugin-local" });
    localPlugins = [local];
    fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const { getRegistryPlugins } = await loadModule();

    expect([...(await getRegistryPlugins()).keys()]).toEqual([local.name]);
    expect(fetchCalls).toBe(1);
  });

  it("invalidates memory so the next read re-merges endpoints after add", async () => {
    const alpha = plugin({ name: "plugin-alpha" });
    fetchImpl = async () => new Map([[alpha.name, alpha]]);
    const { addRegistryEndpoint, getRegistryPlugins } = await loadModule();

    await getRegistryPlugins();
    expect(mergeCalls).toHaveLength(1);
    addRegistryEndpoint("mirror", CUSTOM_ENDPOINT_URL);
    await getRegistryPlugins();

    expect(mergeCalls.at(-1)?.endpoints).toEqual([
      { label: "mirror", url: CUSTOM_ENDPOINT_URL, enabled: true },
    ]);
  });
});

describe("getPluginInfo", () => {
  it("returns null for a missing name, including the empty string", async () => {
    fetchImpl = async () =>
      new Map([
        ["@elizaos/plugin-alpha", plugin({ name: "@elizaos/plugin-alpha" })],
      ]);
    const { getPluginInfo } = await loadModule();

    expect(await getPluginInfo("missing")).toBeNull();
    expect(await getPluginInfo("")).toBeNull();
  });

  it("resolves an exact key, a bare name, and the obsidan alias", async () => {
    const alpha = plugin({ name: "@elizaos/plugin-alpha" });
    const obsidian = plugin({ name: "@elizaos/plugin-obsidian" });
    fetchImpl = async () =>
      new Map([
        [alpha.name, alpha],
        [obsidian.name, obsidian],
      ]);
    const { getPluginInfo } = await loadModule();

    expect(await getPluginInfo("@elizaos/plugin-alpha")).toEqual(alpha);
    expect(await getPluginInfo("plugin-alpha")).toEqual(alpha);
    expect(await getPluginInfo("obsidan")).toEqual(obsidian);
    expect(await getPluginInfo("@elizaos/plugin-obsidan")).toEqual(obsidian);
  });

  it("never resolves an explicit scope to a different publisher", async () => {
    const attacker = plugin({ name: "@attacker/plugin-x" });
    fetchImpl = async () => new Map([[attacker.name, attacker]]);
    const { getPluginInfo } = await loadModule();

    expect(await getPluginInfo("@elizaos/plugin-x")).toBeNull();
    expect(await getPluginInfo("plugin-x")).toEqual(attacker);
  });
});

describe("searchPlugins", () => {
  it("returns an empty list when nothing scores or the limit is zero", async () => {
    fetchImpl = async () =>
      new Map([["alpha", plugin({ name: "alpha", description: "one" })]]);
    const { searchPlugins } = await loadModule();

    expect(await searchPlugins("zzz-no-match")).toEqual([]);
    expect(await searchPlugins("alpha", 0)).toEqual([]);
  });

  it("ranks an exact name above a substring and breaks remaining ties by stars", async () => {
    const exact = plugin({
      name: "chat",
      description: "unrelated",
      stars: 1,
    });
    const substringHigh = plugin({
      name: "chat-kit",
      description: "unrelated",
      stars: 50,
    });
    const substringLow = plugin({
      name: "chat-lite",
      description: "unrelated",
      stars: 5,
    });
    fetchImpl = async () =>
      new Map([
        [substringLow.name, substringLow],
        [substringHigh.name, substringHigh],
        [exact.name, exact],
      ]);
    const { searchPlugins } = await loadModule();

    const results = await searchPlugins("chat");
    expect(results.map((r) => r.name)).toEqual([
      "chat",
      "chat-kit",
      "chat-lite",
    ]);
    expect(results[0]?.score).toBe(1);
    expect(results[1]?.score).toBeLessThan(1);
    expect(results[1]?.stars).toBe(50);
  });

  it("caps at the default limit of 15 in insertion order when scores and stars tie", async () => {
    const entries = Array.from({ length: 16 }, (_, i) => {
      const name = `match-${String(i).padStart(2, "0")}`;
      return plugin({ name, description: "other" });
    });
    fetchImpl = async () => new Map(entries.map((p) => [p.name, p]));
    const { searchPlugins } = await loadModule();

    const results = await searchPlugins("match");
    expect(results).toHaveLength(15);
    expect(results.map((r) => r.name)).toEqual(
      entries.slice(0, 15).map((p) => p.name),
    );
  });
});

describe("listApps and getAppInfo", () => {
  it("returns an empty list when the registry has no apps", async () => {
    fetchImpl = async () =>
      new Map([["plugin-only", plugin({ name: "plugin-only" })]]);
    const { listApps, getAppInfo } = await loadModule();

    expect(await listApps()).toEqual([]);
    expect(await getAppInfo("plugin-only")).toBeNull();
    expect(await getAppInfo("missing")).toBeNull();
  });

  it("lists apps by descending stars and keeps equal-star insertion order", async () => {
    const firstTie = appPlugin("app-first", 50, { displayName: "First" });
    const secondTie = appPlugin("app-second", 50, { displayName: "Second" });
    const low = appPlugin("app-low", 10, { displayName: "Low" });
    const notApp = plugin({ name: "plugin-only", stars: 999 });
    fetchImpl = async () =>
      new Map([
        [notApp.name, notApp],
        [firstTie.name, firstTie],
        [secondTie.name, secondTie],
        [low.name, low],
      ]);
    const { listApps, getAppInfo } = await loadModule();

    expect((await listApps()).map((a) => a.name)).toEqual([
      "app-first",
      "app-second",
      "app-low",
    ]);
    const info = await getAppInfo("app-low");
    expect(info?.displayName).toBe("Low");
    expect(info?.stars).toBe(10);
    expect(info?.repository).toBe("https://github.com/elizaos/app-low");
  });

  it("treats a plugin that only has appMeta as an app, and applies the hyperfy override", async () => {
    const metaOnly = plugin({
      name: "meta-only",
      appMeta: appMeta({ displayName: "Meta Only" }),
    });
    const hyperfy = plugin({ name: "@elizaos/app-hyperfy" });
    fetchImpl = async () =>
      new Map([
        [metaOnly.name, metaOnly],
        [hyperfy.name, hyperfy],
      ]);
    const { listApps, getAppInfo } = await loadModule();

    expect((await listApps()).map((a) => a.name)).toEqual([
      "meta-only",
      "@elizaos/app-hyperfy",
    ]);
    const info = await getAppInfo("@elizaos/app-hyperfy");
    expect(info?.launchType).toBe("connect");
    expect(info?.launchUrl).toBe("http://localhost:3003");
    expect(info?.viewer?.url).toBe("http://localhost:3003");
  });
});

describe("searchApps", () => {
  it("matches display name and capabilities, excludes non-apps, and honours limit", async () => {
    const named = appPlugin("app-named", 1, {
      displayName: "Arcade Cabinet",
      capabilities: ["chat"],
    });
    const capable = appPlugin("app-capable", 1, {
      displayName: "Other",
      capabilities: ["voice-arcade"],
    });
    const ignored = plugin({
      name: "plugin-arcade",
      description: "arcade plugin",
    });
    fetchImpl = async () =>
      new Map([
        [ignored.name, ignored],
        [named.name, named],
        [capable.name, capable],
      ]);
    const { searchApps } = await loadModule();

    const results = await searchApps("arcade");
    expect(results.map((a) => a.name)).toEqual(["app-named", "app-capable"]);
    expect(await searchApps("arcade", 1)).toHaveLength(1);
    expect(await searchApps("zzz-no-match")).toEqual([]);
  });
});

describe("listNonAppPlugins and searchNonAppPlugins", () => {
  it("excludes kind=app, includes appMeta-only entries, and sorts by stars", async () => {
    const app = appPlugin("kind-app", 1, { displayName: "Kind App" });
    const metaOnly = plugin({
      name: "meta-only",
      stars: 3,
      appMeta: appMeta({ displayName: "Meta" }),
    });
    const high = plugin({ name: "plug-high", stars: 20 });
    const low = plugin({ name: "plug-low", stars: 4 });
    fetchImpl = async () =>
      new Map([
        [app.name, app],
        [low.name, low],
        [high.name, high],
        [metaOnly.name, metaOnly],
      ]);
    const { listNonAppPlugins } = await loadModule();

    expect((await listNonAppPlugins()).map((p) => p.name)).toEqual([
      "plug-high",
      "plug-low",
      "meta-only",
    ]);
  });

  it("searches only non-app plugins and caps the result", async () => {
    const app = appPlugin("kind-app", 100, {
      displayName: "Search App",
      capabilities: ["search"],
    });
    const hit = plugin({
      name: "search-kit",
      description: "search helper",
      stars: 1,
    });
    const miss = plugin({ name: "other", description: "unrelated" });
    fetchImpl = async () =>
      new Map([
        [app.name, app],
        [miss.name, miss],
        [hit.name, hit],
      ]);
    const { searchNonAppPlugins } = await loadModule();

    const results = await searchNonAppPlugins("search");
    expect(results.map((p) => p.name)).toEqual(["search-kit"]);
    expect(results[0]?.repository).toBe(
      "https://github.com/elizaos/search-kit",
    );
    expect(await searchNonAppPlugins("search", 0)).toEqual([]);
  });

  it("sorts apps and non-app plugins deterministically when stars contains NaN or non-finite numbers", async () => {
    const app1 = appPlugin("app-nan", NaN as unknown as number, {
      displayName: "App NaN",
    });
    const app2 = appPlugin("app-high", 50, { displayName: "App High" });
    const app3 = appPlugin("app-low", 10, { displayName: "App Low" });

    const plug1 = plugin({ name: "plug-nan", stars: NaN });
    const plug2 = plugin({ name: "plug-high", stars: 100 });
    const plug3 = plugin({ name: "plug-low", stars: 5 });

    fetchImpl = async () =>
      new Map([
        [app1.name, app1],
        [app2.name, app2],
        [app3.name, app3],
        [plug1.name, plug1],
        [plug2.name, plug2],
        [plug3.name, plug3],
      ]);

    const { listApps, listNonAppPlugins } = await loadModule();

    const apps = await listApps();
    expect(apps.map((a) => a.name)).toEqual(["app-high", "app-low", "app-nan"]);

    const plugins = await listNonAppPlugins();
    expect(plugins.map((p) => p.name)).toEqual([
      "plug-high",
      "plug-low",
      "plug-nan",
    ]);
  });
});
