/**
 * Behavioural coverage for createConfigPluginManager: the config-only
 * PluginManagerLike used before a live runtime plugin-manager exists.
 * Installed-plugin listing is driven from a real Eliza config getter (empty
 * queue, single element, insertion order, non-object installs, live re-read);
 * mutating operations throw; ejected listing is always empty. Registry
 * search mapping and argument forwarding are proven against a mocked
 * registry-client seam so the suite does not depend on a network fetch.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ElizaConfig,
  PluginInstallRecord,
} from "../config/types.eliza.ts";
import { createConfigPluginManager } from "./config-plugin-manager.ts";
import type { RegistryPluginInfo } from "./plugin-manager-types.ts";
import type { RegistrySearchResult as ClientSearchResult } from "./registry-client-types.ts";

const refreshRegistry = vi.hoisted(() => vi.fn());
const getPluginInfo = vi.hoisted(() => vi.fn());
const searchPlugins = vi.hoisted(() => vi.fn());

vi.mock("./registry-client.ts", () => ({
  refreshRegistry,
  getPluginInfo,
  searchPlugins,
}));

function installRecord(
  extras: Partial<PluginInstallRecord> = {},
): PluginInstallRecord {
  return { source: "npm", ...extras };
}

function configWithInstalls(
  installs: Record<string, PluginInstallRecord>,
): ElizaConfig {
  return { plugins: { installs } } as ElizaConfig;
}

function configWithRawInstalls(installs: unknown): ElizaConfig {
  return { plugins: { installs } } as unknown as ElizaConfig;
}

function clientSearchResult(
  extras: Partial<ClientSearchResult> & Pick<ClientSearchResult, "name">,
): ClientSearchResult {
  return {
    description: `${extras.name} description`,
    score: 1,
    tags: [],
    latestVersion: "1.0.0",
    stars: 0,
    supports: { v0: false, v1: false, v2: true },
    repository: `https://example.test/${extras.name}`,
    ...extras,
  };
}

function registryPlugin(name: string): RegistryPluginInfo {
  return {
    name,
    gitRepo: name,
    gitUrl: `https://example.test/${name}.git`,
    description: `${name} plugin`,
    homepage: null,
    topics: [],
    stars: 0,
    language: "TypeScript",
    npm: { package: name, v0Version: null, v1Version: null, v2Version: null },
    git: { v0Branch: null, v1Branch: null, v2Branch: null },
    supports: { v0: false, v1: false, v2: true },
  };
}

describe("createConfigPluginManager", () => {
  beforeEach(() => {
    refreshRegistry.mockReset();
    getPluginInfo.mockReset();
    searchPlugins.mockReset();
  });

  describe("listInstalledPlugins", () => {
    it("returns an empty list when plugins is missing", async () => {
      const manager = createConfigPluginManager(() => ({}) as ElizaConfig);
      await expect(manager.listInstalledPlugins()).resolves.toEqual([]);
    });

    it("returns an empty list when installs is missing", async () => {
      const manager = createConfigPluginManager(
        () => ({ plugins: {} }) as ElizaConfig,
      );
      await expect(manager.listInstalledPlugins()).resolves.toEqual([]);
    });

    it("returns an empty list when installs is null", async () => {
      const manager = createConfigPluginManager(() =>
        configWithRawInstalls(null),
      );
      await expect(manager.listInstalledPlugins()).resolves.toEqual([]);
    });

    it("returns an empty list when installs is a non-object", async () => {
      const manager = createConfigPluginManager(() =>
        configWithRawInstalls("not-a-map"),
      );
      await expect(manager.listInstalledPlugins()).resolves.toEqual([]);
    });

    it("returns an empty list for an empty installs map", async () => {
      const manager = createConfigPluginManager(() => configWithInstalls({}));
      await expect(manager.listInstalledPlugins()).resolves.toEqual([]);
    });

    it("maps a single install to name, version, and installedAt", async () => {
      const manager = createConfigPluginManager(() =>
        configWithInstalls({
          "@elizaos/plugin-sql": installRecord({
            version: "1.2.3",
            installedAt: "2026-01-02T03:04:05.000Z",
            spec: "@elizaos/plugin-sql@1.2.3",
            installPath: "/unused/path",
          }),
        }),
      );

      await expect(manager.listInstalledPlugins()).resolves.toEqual([
        {
          name: "@elizaos/plugin-sql",
          version: "1.2.3",
          installedAt: "2026-01-02T03:04:05.000Z",
        },
      ]);
    });

    it("preserves Object.entries insertion order for multiple installs", async () => {
      const manager = createConfigPluginManager(() =>
        configWithInstalls({
          "plugin-beta": installRecord({ version: "2.0.0" }),
          "plugin-alpha": installRecord({ version: "1.0.0" }),
        }),
      );

      await expect(manager.listInstalledPlugins()).resolves.toEqual([
        { name: "plugin-beta", version: "2.0.0", installedAt: undefined },
        { name: "plugin-alpha", version: "1.0.0", installedAt: undefined },
      ]);
    });

    it("leaves version and installedAt undefined when the record omits them", async () => {
      const manager = createConfigPluginManager(() =>
        configWithInstalls({
          "plugin-bare": installRecord(),
        }),
      );

      await expect(manager.listInstalledPlugins()).resolves.toEqual([
        { name: "plugin-bare", version: undefined, installedAt: undefined },
      ]);
    });

    it("treats an array installs value as an object keyed by index", async () => {
      const manager = createConfigPluginManager(() =>
        configWithRawInstalls([
          installRecord({ version: "9.9.9", installedAt: "t0" }),
        ]),
      );

      await expect(manager.listInstalledPlugins()).resolves.toEqual([
        { name: "0", version: "9.9.9", installedAt: "t0" },
      ]);
    });

    it("re-reads the getter on every call instead of snapshotting config", async () => {
      let current: ElizaConfig = configWithInstalls({});
      const manager = createConfigPluginManager(() => current);

      await expect(manager.listInstalledPlugins()).resolves.toEqual([]);

      current = configWithInstalls({
        "plugin-later": installRecord({ version: "0.1.0" }),
      });

      await expect(manager.listInstalledPlugins()).resolves.toEqual([
        { name: "plugin-later", version: "0.1.0", installedAt: undefined },
      ]);
    });

    it("propagates a getter failure", async () => {
      const manager = createConfigPluginManager(() => {
        throw new Error("config unavailable");
      });
      await expect(manager.listInstalledPlugins()).rejects.toThrow(
        "config unavailable",
      );
    });
  });

  describe("listEjectedPlugins", () => {
    it("always returns an empty list, even when installs exist", async () => {
      const manager = createConfigPluginManager(() =>
        configWithInstalls({
          "plugin-installed": installRecord({ version: "1.0.0" }),
        }),
      );
      await expect(manager.listEjectedPlugins()).resolves.toEqual([]);
    });
  });

  describe("mutating operations", () => {
    const manager = createConfigPluginManager(() => ({}) as ElizaConfig);
    const runtimeRequired =
      "requires a running agent runtime with the plugin manager service.";

    it("throws for installPlugin regardless of the requested name", async () => {
      await expect(manager.installPlugin("missing-plugin")).rejects.toThrow(
        `Plugin installation ${runtimeRequired}`,
      );
    });

    it("throws for uninstallPlugin of a missing and a present name", async () => {
      const withInstalls = createConfigPluginManager(() =>
        configWithInstalls({
          "plugin-present": installRecord({ version: "1.0.0" }),
        }),
      );
      await expect(withInstalls.uninstallPlugin("missing")).rejects.toThrow(
        `Plugin removal ${runtimeRequired}`,
      );
      await expect(
        withInstalls.uninstallPlugin("plugin-present"),
      ).rejects.toThrow(`Plugin removal ${runtimeRequired}`);
    });

    it("throws for ejectPlugin, syncPlugin, and reinjectPlugin", async () => {
      await expect(manager.ejectPlugin("any")).rejects.toThrow(
        `Plugin ejection ${runtimeRequired}`,
      );
      await expect(manager.syncPlugin("any")).rejects.toThrow(
        `Plugin sync ${runtimeRequired}`,
      );
      await expect(manager.reinjectPlugin("any")).rejects.toThrow(
        `Plugin reinjection ${runtimeRequired}`,
      );
    });
  });

  describe("registry read paths", () => {
    it("forwards refreshRegistry to the registry client and returns its map", async () => {
      const registry = new Map<string, RegistryPluginInfo>([
        ["@elizaos/plugin-sql", registryPlugin("@elizaos/plugin-sql")],
      ]);
      refreshRegistry.mockResolvedValue(registry);

      const manager = createConfigPluginManager(() => ({}) as ElizaConfig);
      const result = await manager.refreshRegistry();

      expect(refreshRegistry).toHaveBeenCalledTimes(1);
      expect(refreshRegistry).toHaveBeenCalledWith();
      expect(result).toBe(registry);
    });

    it("forwards getRegistryPlugin by name and returns a miss as null", async () => {
      getPluginInfo.mockResolvedValue(null);
      const manager = createConfigPluginManager(() => ({}) as ElizaConfig);

      await expect(manager.getRegistryPlugin("missing")).resolves.toBeNull();
      expect(getPluginInfo).toHaveBeenCalledWith("missing");
    });

    it("returns the registry plugin the client resolved", async () => {
      const info = registryPlugin("@elizaos/plugin-bootstrap");
      getPluginInfo.mockResolvedValue(info);
      const manager = createConfigPluginManager(() => ({}) as ElizaConfig);

      await expect(
        manager.getRegistryPlugin("@elizaos/plugin-bootstrap"),
      ).resolves.toBe(info);
    });

    it("maps empty search results to an empty list", async () => {
      searchPlugins.mockResolvedValue([]);
      const manager = createConfigPluginManager(() => ({}) as ElizaConfig);

      await expect(manager.searchRegistry("nothing")).resolves.toEqual([]);
      expect(searchPlugins).toHaveBeenCalledWith("nothing", undefined);
    });

    it("forwards the optional search limit", async () => {
      searchPlugins.mockResolvedValue([]);
      const manager = createConfigPluginManager(() => ({}) as ElizaConfig);

      await expect(manager.searchRegistry("sql", 3)).resolves.toEqual([]);
      expect(searchPlugins).toHaveBeenCalledWith("sql", 3);
    });

    it("adds version null and npmPackage from the result name, overwriting either if present", async () => {
      searchPlugins.mockResolvedValue([
        {
          ...clientSearchResult({
            name: "@elizaos/plugin-sql",
            description: "SQL plugin",
            score: 0.9,
            tags: ["db"],
          }),
          version: "should-be-dropped",
          npmPackage: "should-be-replaced",
        },
        clientSearchResult({ name: "plugin-other", score: 0.1 }),
      ]);
      const manager = createConfigPluginManager(() => ({}) as ElizaConfig);

      await expect(manager.searchRegistry("plugin")).resolves.toEqual([
        {
          ...clientSearchResult({
            name: "@elizaos/plugin-sql",
            description: "SQL plugin",
            score: 0.9,
            tags: ["db"],
          }),
          version: null,
          npmPackage: "@elizaos/plugin-sql",
        },
        {
          ...clientSearchResult({ name: "plugin-other", score: 0.1 }),
          version: null,
          npmPackage: "plugin-other",
        },
      ]);
    });
  });
});
