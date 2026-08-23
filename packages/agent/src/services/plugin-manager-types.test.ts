/**
 * Behavioral coverage for plugin-manager-types.ts: the runtime duck-type
 * guards used to accept a PluginManagerLike / CoreManagerLike passed across
 * a package boundary. Drives the real module — no mocks. Types-only exports
 * are exercised as typed fixtures so tsc still sees the result-record shapes.
 */
import { describe, expect, it } from "vitest";
import {
  type CoreManagerLike,
  type CoreStatusLike,
  type EjectResult,
  type InstalledPluginInfo,
  isCoreManagerLike,
  isPluginManagerLike,
  type PluginInstallResult,
  type PluginManagerLike,
  type PluginUninstallResult,
  type ReinjectResult,
  type SyncResult,
} from "./plugin-manager-types.ts";

const REQUIRED_PLUGIN_MANAGER_METHODS = [
  "refreshRegistry",
  "listInstalledPlugins",
  "getRegistryPlugin",
  "searchRegistry",
  "installPlugin",
  "uninstallPlugin",
] as const;

type RequiredPluginManagerMethod =
  (typeof REQUIRED_PLUGIN_MANAGER_METHODS)[number];

function installResult(pluginName = "demo"): PluginInstallResult {
  return {
    success: true,
    pluginName,
    version: "1.0.0",
    installPath: `/tmp/${pluginName}`,
    requiresRestart: false,
  };
}

function uninstallResult(pluginName = "demo"): PluginUninstallResult {
  return { success: true, pluginName, requiresRestart: false };
}

function ejectResult(pluginName = "demo"): EjectResult {
  return {
    success: true,
    pluginName,
    ejectedPath: `/tmp/${pluginName}`,
    requiresRestart: false,
  };
}

function syncResult(pluginName = "demo"): SyncResult {
  return {
    success: true,
    pluginName,
    ejectedPath: `/tmp/${pluginName}`,
    requiresRestart: false,
  };
}

function reinjectResult(pluginName = "demo"): ReinjectResult {
  return {
    success: true,
    pluginName,
    removedPath: `/tmp/${pluginName}`,
    requiresRestart: false,
  };
}

function coreStatus(): CoreStatusLike {
  return {
    ejected: false,
    ejectedPath: "",
    monorepoPath: "/tmp/eliza",
    corePackagePath: "/tmp/eliza/packages/core",
    coreDistPath: "/tmp/eliza/packages/core/dist",
    version: "1.0.0",
    npmVersion: "1.0.0",
    commitHash: null,
    localChanges: false,
    upstream: null,
  };
}

function requiredPluginManager(): Pick<
  PluginManagerLike,
  RequiredPluginManagerMethod
> {
  return {
    refreshRegistry: async () => new Map(),
    listInstalledPlugins: async () => [],
    getRegistryPlugin: async () => null,
    searchRegistry: async () => [],
    installPlugin: async () => installResult(),
    uninstallPlugin: async () => uninstallResult(),
  };
}

function fullPluginManager(): PluginManagerLike {
  return {
    ...requiredPluginManager(),
    updatePlugin: async () => installResult(),
    listEjectedPlugins: async () => [],
    ejectPlugin: async () => ejectResult(),
    syncPlugin: async () => syncResult(),
    reinjectPlugin: async () => reinjectResult(),
  };
}

function coreManager(): CoreManagerLike {
  return { getCoreStatus: async () => coreStatus() };
}

function omitRequiredMethod(
  missing: RequiredPluginManagerMethod,
): Record<string, unknown> {
  const methods = { ...requiredPluginManager() } as Record<string, unknown>;
  delete methods[missing];
  return methods;
}

describe("isPluginManagerLike", () => {
  it("rejects the empty queue: primitives, null, and undefined", () => {
    expect(isPluginManagerLike(undefined)).toBe(false);
    expect(isPluginManagerLike(null)).toBe(false);
    expect(isPluginManagerLike(false)).toBe(false);
    expect(isPluginManagerLike(true)).toBe(false);
    expect(isPluginManagerLike(0)).toBe(false);
    expect(isPluginManagerLike(1)).toBe(false);
    expect(isPluginManagerLike("")).toBe(false);
    expect(isPluginManagerLike("plugin_manager")).toBe(false);
    expect(isPluginManagerLike(Symbol("plugin"))).toBe(false);
    expect(isPluginManagerLike(1n)).toBe(false);
  });

  it("rejects functions even when they carry manager-shaped properties", () => {
    const fn = Object.assign(async () => {}, requiredPluginManager());
    expect(isPluginManagerLike(fn)).toBe(false);
  });

  it("rejects an empty object and a single required method", () => {
    expect(isPluginManagerLike({})).toBe(false);
    expect(
      isPluginManagerLike({
        refreshRegistry: async () => new Map(),
      }),
    ).toBe(false);
  });

  it("rejects a candidate missing any one required method", () => {
    for (const missing of REQUIRED_PLUGIN_MANAGER_METHODS) {
      expect(isPluginManagerLike(omitRequiredMethod(missing))).toBe(false);
    }
  });

  it("rejects required keys that exist but are not functions", () => {
    const notFunctions: unknown[] = [
      undefined,
      null,
      "fn",
      1,
      true,
      {},
      [],
      Promise.resolve(),
    ];
    for (const missing of REQUIRED_PLUGIN_MANAGER_METHODS) {
      for (const value of notFunctions) {
        expect(
          isPluginManagerLike({
            ...requiredPluginManager(),
            [missing]: value,
          }),
        ).toBe(false);
      }
    }
  });

  it("accepts the six required methods without optional lifecycle methods", () => {
    expect(isPluginManagerLike(requiredPluginManager())).toBe(true);
  });

  it("accepts a full PluginManagerLike including optional methods", () => {
    expect(isPluginManagerLike(fullPluginManager())).toBe(true);
  });

  it("ignores optional methods that are missing or not functions", () => {
    expect(
      isPluginManagerLike({
        ...requiredPluginManager(),
        updatePlugin: "not-a-function",
        listEjectedPlugins: null,
        ejectPlugin: 1,
        syncPlugin: {},
        reinjectPlugin: undefined,
      }),
    ).toBe(true);
  });

  it("accepts extra unrelated properties without treating them as overflow", () => {
    expect(
      isPluginManagerLike({
        ...requiredPluginManager(),
        extra: "ignored",
        nested: { ok: true },
      }),
    ).toBe(true);
  });

  it("accepts class instances whose required methods live on the prototype", () => {
    class PrototypePluginManager implements PluginManagerLike {
      async refreshRegistry() {
        return new Map();
      }
      async listInstalledPlugins(): Promise<InstalledPluginInfo[]> {
        return [];
      }
      async getRegistryPlugin() {
        return null;
      }
      async searchRegistry() {
        return [];
      }
      async installPlugin() {
        return installResult();
      }
      async uninstallPlugin() {
        return uninstallResult();
      }
      async listEjectedPlugins(): Promise<InstalledPluginInfo[]> {
        return [];
      }
      async ejectPlugin() {
        return ejectResult();
      }
      async syncPlugin() {
        return syncResult();
      }
      async reinjectPlugin() {
        return reinjectResult();
      }
    }
    expect(isPluginManagerLike(new PrototypePluginManager())).toBe(true);
  });

  it("accepts a null-prototype object that still exposes the required methods", () => {
    const candidate = Object.assign(
      Object.create(null),
      requiredPluginManager(),
    );
    expect(isPluginManagerLike(candidate)).toBe(true);
  });

  it("accepts an array that has the required methods assigned as own properties", () => {
    // Local isObjectRecord is `typeof value === "object" && value !== null`,
    // so arrays are records; the guard then only checks method presence.
    const candidate = Object.assign([], requiredPluginManager());
    expect(isPluginManagerLike(candidate)).toBe(true);
  });

  it("rejects Date, Map, and Set when they do not carry the required methods", () => {
    expect(isPluginManagerLike(new Date())).toBe(false);
    expect(isPluginManagerLike(new Map())).toBe(false);
    expect(isPluginManagerLike(new Set())).toBe(false);
  });

  it("rejects a CoreManagerLike as a PluginManagerLike", () => {
    expect(isPluginManagerLike(coreManager())).toBe(false);
  });
});

describe("isCoreManagerLike", () => {
  it("rejects the empty queue: primitives, null, and undefined", () => {
    expect(isCoreManagerLike(undefined)).toBe(false);
    expect(isCoreManagerLike(null)).toBe(false);
    expect(isCoreManagerLike(0)).toBe(false);
    expect(isCoreManagerLike("")).toBe(false);
    expect(isCoreManagerLike(true)).toBe(false);
    expect(isCoreManagerLike(Symbol("core"))).toBe(false);
    expect(isCoreManagerLike(1n)).toBe(false);
  });

  it("rejects functions even when they expose getCoreStatus", () => {
    const fn = Object.assign(async () => {}, coreManager());
    expect(isCoreManagerLike(fn)).toBe(false);
  });

  it("rejects an empty object and a missing getCoreStatus", () => {
    expect(isCoreManagerLike({})).toBe(false);
    expect(isCoreManagerLike({ other: async () => coreStatus() })).toBe(false);
  });

  it("rejects getCoreStatus values that are not functions", () => {
    expect(isCoreManagerLike({ getCoreStatus: undefined })).toBe(false);
    expect(isCoreManagerLike({ getCoreStatus: null })).toBe(false);
    expect(isCoreManagerLike({ getCoreStatus: "status" })).toBe(false);
    expect(isCoreManagerLike({ getCoreStatus: 1 })).toBe(false);
    expect(isCoreManagerLike({ getCoreStatus: {} })).toBe(false);
    expect(isCoreManagerLike({ getCoreStatus: [] })).toBe(false);
  });

  it("accepts a single-method CoreManagerLike", () => {
    expect(isCoreManagerLike(coreManager())).toBe(true);
  });

  it("accepts extra properties without treating them as overflow", () => {
    expect(
      isCoreManagerLike({
        getCoreStatus: async () => coreStatus(),
        extra: true,
      }),
    ).toBe(true);
  });

  it("accepts class instances whose getCoreStatus lives on the prototype", () => {
    class PrototypeCoreManager implements CoreManagerLike {
      async getCoreStatus() {
        return coreStatus();
      }
    }
    expect(isCoreManagerLike(new PrototypeCoreManager())).toBe(true);
  });

  it("accepts a null-prototype object with getCoreStatus", () => {
    const candidate = Object.assign(Object.create(null), coreManager());
    expect(isCoreManagerLike(candidate)).toBe(true);
  });

  it("accepts an array that has getCoreStatus assigned as an own property", () => {
    const candidate = Object.assign([], coreManager());
    expect(isCoreManagerLike(candidate)).toBe(true);
  });

  it("rejects a PluginManagerLike as a CoreManagerLike", () => {
    expect(isCoreManagerLike(requiredPluginManager())).toBe(false);
    expect(isCoreManagerLike(fullPluginManager())).toBe(false);
  });
});
