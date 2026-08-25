/**
 * Behavioral coverage for plugin-types.ts: the shared plugin-resolution
 * constants and helpers. Drives the real module against real temp directories
 * — export selection order, drop-in scan/merge edges, install-record repair,
 * package-entry resolution, and import-specifier fallbacks. No mocks.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Plugin } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import type { PluginInstallRecord } from "../config/types.eliza.ts";
import {
  CUSTOM_PLUGINS_DIRNAME,
  EJECTED_PLUGINS_DIRNAME,
  findRuntimePluginExport,
  mergeDropInPlugins,
  type PluginModuleShape,
  repairBrokenInstallRecord,
  resolveElizaPluginImportSpecifier,
  resolvePackageEntry,
  STATIC_ELIZA_PLUGIN_LOADERS,
  STATIC_ELIZA_PLUGINS,
  scanDropInPlugins,
} from "./plugin-types.ts";

const STATIC_TEST_KEY = "__plugin_types_coverage_key__";

function plugin(name: string, extra?: Partial<Plugin>): Plugin {
  return {
    name,
    description: `${name} description`,
    actions: [],
    ...extra,
  };
}

function namedOnly(name: string, description: string): Record<string, unknown> {
  return { name, description };
}

function pathRecord(
  installPath: string,
  version = "1.0.0",
): PluginInstallRecord {
  return { source: "path", installPath, version };
}

async function writeJson(
  filePath: string,
  value: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

describe("plugin-types constants", () => {
  afterEach(() => {
    delete STATIC_ELIZA_PLUGINS[STATIC_TEST_KEY];
    delete STATIC_ELIZA_PLUGIN_LOADERS[STATIC_TEST_KEY];
  });

  it("exports the drop-in and ejected plugin directory names", () => {
    expect(CUSTOM_PLUGINS_DIRNAME).toBe("plugins/custom");
    expect(EJECTED_PLUGINS_DIRNAME).toBe("plugins/ejected");
  });

  it("exposes STATIC_ELIZA_PLUGINS as a mutable shared registry", () => {
    expect(STATIC_ELIZA_PLUGINS).toEqual(expect.any(Object));
    STATIC_ELIZA_PLUGINS[STATIC_TEST_KEY] = { marker: true };
    expect(STATIC_ELIZA_PLUGINS[STATIC_TEST_KEY]).toEqual({ marker: true });
  });

  it("exposes STATIC_ELIZA_PLUGIN_LOADERS as a mutable loader map", async () => {
    const loader = async () => ({ loaded: true });
    STATIC_ELIZA_PLUGIN_LOADERS[STATIC_TEST_KEY] = loader;
    expect(STATIC_ELIZA_PLUGIN_LOADERS[STATIC_TEST_KEY]).toBe(loader);
    await expect(
      STATIC_ELIZA_PLUGIN_LOADERS[STATIC_TEST_KEY]?.(),
    ).resolves.toEqual({ loaded: true });
  });
});

describe("findRuntimePluginExport", () => {
  it("returns null for an empty module", () => {
    expect(findRuntimePluginExport({})).toBeNull();
  });

  it("prefers a default export that looks like a plugin", () => {
    const defaultPlugin = plugin("default-plugin");
    const namedPlugin = plugin("named-plugin");
    const mod: PluginModuleShape = {
      default: defaultPlugin,
      plugin: namedPlugin,
      ExtraPlugin: plugin("extra-plugin"),
    };
    expect(findRuntimePluginExport(mod)).toBe(defaultPlugin);
  });

  it("uses the named plugin export when default is not a plugin", () => {
    const namedPlugin = plugin("named-plugin");
    const mod = {
      default: namedOnly("provider", "not a plugin"),
      plugin: namedPlugin,
      ExtraPlugin: plugin("extra-plugin"),
    } as unknown as PluginModuleShape;
    expect(findRuntimePluginExport(mod)).toBe(namedPlugin);
  });

  it("prefers keys that look like Plugin over generic capability exports", () => {
    const generic = plugin("generic-actions");
    const preferred = plugin("preferred-plugin");
    const mod: PluginModuleShape = {
      actions: generic,
      MyPlugin: preferred,
    };
    expect(findRuntimePluginExport(mod)).toBe(preferred);
  });

  it("treats keys that start with plugin as preferred as well", () => {
    const generic = plugin("generic");
    const pluginPrefixed = plugin("plugin-prefixed");
    const mod: PluginModuleShape = {
      helpers: generic,
      pluginHelpers: pluginPrefixed,
    };
    expect(findRuntimePluginExport(mod)).toBe(pluginPrefixed);
  });

  it("walks preferred keys in Object.keys insertion order on a tie", () => {
    const first = plugin("first-preferred");
    const second = plugin("second-preferred");
    const mod: PluginModuleShape = {
      AlphaPlugin: first,
      BetaPlugin: second,
    };
    expect(findRuntimePluginExport(mod)).toBe(first);
  });

  it("walks fallback keys in Object.keys order when none are preferred", () => {
    const first = plugin("first-fallback");
    const second = plugin("second-fallback");
    const mod: PluginModuleShape = {
      alpha: first,
      beta: second,
    };
    expect(findRuntimePluginExport(mod)).toBe(first);
  });

  it("returns a single named export when it is the only plugin-like value", () => {
    const only = plugin("only");
    expect(findRuntimePluginExport({ only })).toBe(only);
  });

  it("rejects name+description objects that have no plugin capability fields", () => {
    const mod = {
      default: namedOnly("openai", "a provider"),
      plugin: namedOnly("also", "still a provider"),
      helper: namedOnly("helper", "no capabilities"),
    } as unknown as PluginModuleShape;
    expect(findRuntimePluginExport(mod)).toBeNull();
  });

  it("accepts each capability field as enough to look like a plugin", () => {
    const cases: Array<Record<string, unknown>> = [
      { services: [] },
      { providers: [] },
      { actions: [] },
      { routes: [] },
      { events: [] },
      { views: [] },
      { init: async () => undefined },
    ];
    for (const extra of cases) {
      const candidate = {
        name: "capability",
        description: "capability description",
        ...extra,
      };
      expect(findRuntimePluginExport({ candidate })).toBe(candidate);
    }
  });

  it("rejects null, non-objects, and objects missing name or description", () => {
    expect(findRuntimePluginExport({ value: null })).toBeNull();
    expect(findRuntimePluginExport({ value: "plugin" })).toBeNull();
    expect(findRuntimePluginExport({ value: 1 })).toBeNull();
    expect(
      findRuntimePluginExport({
        value: { description: "no name", actions: [] },
      }),
    ).toBeNull();
    expect(
      findRuntimePluginExport({
        value: { name: "no description", actions: [] },
      }),
    ).toBeNull();
    expect(
      findRuntimePluginExport({
        value: { name: 1, description: "bad name", actions: [] },
      }),
    ).toBeNull();
  });

  it("skips a missing preferred export and continues to a later match", () => {
    const later = plugin("later");
    const mod: PluginModuleShape = {
      BrokenPlugin: namedOnly("broken", "no capabilities"),
      later,
    };
    expect(findRuntimePluginExport(mod)).toBe(later);
  });
});

describe("scanDropInPlugins", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-types-scan-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty record when the directory is missing", async () => {
    await expect(
      scanDropInPlugins(path.join(tmpDir, "does-not-exist")),
    ).resolves.toEqual({});
  });

  it("returns an empty record for an empty directory", async () => {
    await expect(scanDropInPlugins(tmpDir)).resolves.toEqual({});
  });

  it("skips non-directory entries and uses the directory name with version 0.0.0", async () => {
    await fs.writeFile(path.join(tmpDir, "readme.txt"), "not a plugin\n");
    const pluginDir = path.join(tmpDir, "orphan-plugin");
    await fs.mkdir(pluginDir);
    await expect(scanDropInPlugins(tmpDir)).resolves.toEqual({
      "orphan-plugin": {
        source: "path",
        installPath: pluginDir,
        version: "0.0.0",
      },
    });
  });

  it("reads name and version from package.json and trims whitespace", async () => {
    const pluginDir = path.join(tmpDir, "on-disk");
    await writeJson(path.join(pluginDir, "package.json"), {
      name: "  @elizaos/plugin-trimmed  ",
      version: "  2.3.4  ",
    });
    await expect(scanDropInPlugins(tmpDir)).resolves.toEqual({
      "@elizaos/plugin-trimmed": {
        source: "path",
        installPath: pluginDir,
        version: "2.3.4",
      },
    });
  });

  it("keeps the directory name and 0.0.0 when package.json name/version are blank", async () => {
    const pluginDir = path.join(tmpDir, "blank-pkg");
    await writeJson(path.join(pluginDir, "package.json"), {
      name: "   ",
      version: "   ",
    });
    await expect(scanDropInPlugins(tmpDir)).resolves.toEqual({
      "blank-pkg": {
        source: "path",
        installPath: pluginDir,
        version: "0.0.0",
      },
    });
  });

  it("treats invalid JSON as a missing package.json and keeps directory defaults", async () => {
    const pluginDir = path.join(tmpDir, "invalid-json");
    await fs.mkdir(pluginDir);
    await fs.writeFile(path.join(pluginDir, "package.json"), "{not json");
    await expect(scanDropInPlugins(tmpDir)).resolves.toEqual({
      "invalid-json": {
        source: "path",
        installPath: pluginDir,
        version: "0.0.0",
      },
    });
  });

  it("does not recurse into nested directories", async () => {
    const pluginDir = path.join(tmpDir, "outer");
    await fs.mkdir(path.join(pluginDir, "nested"), { recursive: true });
    await writeJson(path.join(pluginDir, "nested", "package.json"), {
      name: "nested-should-not-appear",
      version: "9.9.9",
    });
    const records = await scanDropInPlugins(tmpDir);
    expect(Object.keys(records)).toEqual(["outer"]);
    expect(records.outer?.installPath).toBe(pluginDir);
  });

  it("skips a symlink even when it points at a directory", async () => {
    const realDir = path.join(tmpDir, "real");
    await fs.mkdir(realDir);
    await fs.symlink(realDir, path.join(tmpDir, "linked"));
    await expect(scanDropInPlugins(tmpDir)).resolves.toEqual({
      real: {
        source: "path",
        installPath: realDir,
        version: "0.0.0",
      },
    });
  });

  it("rethrows non-ENOENT directory read errors", async () => {
    const filePath = path.join(tmpDir, "not-a-dir");
    await fs.writeFile(filePath, "file\n");
    await expect(scanDropInPlugins(filePath)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });

  it("rethrows package.json read errors that are not missing or invalid JSON", async () => {
    const pluginDir = path.join(tmpDir, "eisdir-pkg");
    await fs.mkdir(path.join(pluginDir, "package.json"), { recursive: true });
    await expect(scanDropInPlugins(tmpDir)).rejects.toMatchObject({
      code: "EISDIR",
    });
  });
});

describe("mergeDropInPlugins", () => {
  it("accepts nothing from an empty drop-in queue", () => {
    const pluginsToLoad = new Set<string>();
    const installRecords: Record<string, PluginInstallRecord> = {};
    expect(
      mergeDropInPlugins({
        dropInRecords: {},
        installRecords,
        corePluginNames: new Set(),
        denyList: new Set(),
        pluginsToLoad,
      }),
    ).toEqual({ accepted: [], skipped: [] });
    expect(pluginsToLoad.size).toBe(0);
    expect(installRecords).toEqual({});
  });

  it("accepts a single drop-in and mutates the load set and install records", () => {
    const record = pathRecord("/tmp/custom-one");
    const pluginsToLoad = new Set<string>();
    const installRecords: Record<string, PluginInstallRecord> = {};
    expect(
      mergeDropInPlugins({
        dropInRecords: { "custom-one": record },
        installRecords,
        corePluginNames: new Set(),
        denyList: new Set(["unrelated-deny"]),
        pluginsToLoad,
      }),
    ).toEqual({ accepted: ["custom-one"], skipped: [] });
    expect([...pluginsToLoad]).toEqual(["custom-one"]);
    expect(installRecords).toEqual({ "custom-one": record });
  });

  it("silently skips denied and already-installed names, including a missing deny entry", () => {
    const keep = pathRecord("/tmp/keep");
    const denied = pathRecord("/tmp/denied");
    const installed = pathRecord("/tmp/installed");
    const pluginsToLoad = new Set<string>(["pre-existing"]);
    const installRecords: Record<string, PluginInstallRecord> = {
      already: pathRecord("/tmp/already"),
    };
    const result = mergeDropInPlugins({
      dropInRecords: {
        denied,
        already: installed,
        keep,
      },
      installRecords,
      corePluginNames: new Set(),
      denyList: new Set(["denied", "not-in-drop-ins"]),
      pluginsToLoad,
    });
    expect(result).toEqual({ accepted: ["keep"], skipped: [] });
    expect([...pluginsToLoad]).toEqual(["pre-existing", "keep"]);
    expect(installRecords.keep).toBe(keep);
    expect(installRecords.already).toEqual(pathRecord("/tmp/already"));
  });

  it("skips core-colliding names with a message and does not mutate load state", () => {
    const colliding = pathRecord("/tmp/core-hit");
    const pluginsToLoad = new Set<string>();
    const installRecords: Record<string, PluginInstallRecord> = {};
    const result = mergeDropInPlugins({
      dropInRecords: { "@elizaos/plugin-sql": colliding },
      installRecords,
      corePluginNames: new Set(["@elizaos/plugin-sql"]),
      denyList: new Set(),
      pluginsToLoad,
    });
    expect(result.accepted).toEqual([]);
    expect(result.skipped).toEqual([
      '[eliza] Custom plugin "@elizaos/plugin-sql" collides with core plugin — skipping',
    ]);
    expect(pluginsToLoad.size).toBe(0);
    expect(installRecords).toEqual({});
  });

  it("checks deny and already-installed before core collision so those stay silent", () => {
    const pluginsToLoad = new Set<string>();
    const installRecords: Record<string, PluginInstallRecord> = {
      coreInstalled: pathRecord("/tmp/installed-core"),
    };
    const result = mergeDropInPlugins({
      dropInRecords: {
        coreDenied: pathRecord("/tmp/denied-core"),
        coreInstalled: pathRecord("/tmp/new-core"),
      },
      installRecords,
      corePluginNames: new Set(["coreDenied", "coreInstalled"]),
      denyList: new Set(["coreDenied"]),
      pluginsToLoad,
    });
    expect(result).toEqual({ accepted: [], skipped: [] });
    expect(pluginsToLoad.size).toBe(0);
  });

  it("preserves Object.entries order across a mixed accepted queue", () => {
    const first = pathRecord("/tmp/a");
    const second = pathRecord("/tmp/b");
    const pluginsToLoad = new Set<string>();
    const installRecords: Record<string, PluginInstallRecord> = {};
    const result = mergeDropInPlugins({
      dropInRecords: { alpha: first, beta: second },
      installRecords,
      corePluginNames: new Set(),
      denyList: new Set(),
      pluginsToLoad,
    });
    expect(result.accepted).toEqual(["alpha", "beta"]);
    expect([...pluginsToLoad]).toEqual(["alpha", "beta"]);
  });
});

describe("repairBrokenInstallRecord", () => {
  it("returns false when plugins, installs, or the named record are missing", () => {
    expect(repairBrokenInstallRecord({}, "missing")).toBe(false);
    expect(repairBrokenInstallRecord({ plugins: {} }, "missing")).toBe(false);
    expect(
      repairBrokenInstallRecord({ plugins: { installs: {} } }, "missing"),
    ).toBe(false);
  });

  it("returns false and does not mutate a record with a non-string or blank path", () => {
    const nonString: ElizaConfig = {
      plugins: {
        installs: {
          "bad-path": {
            source: "path",
            installPath: 12 as unknown as string,
          },
        },
      },
    };
    expect(repairBrokenInstallRecord(nonString, "bad-path")).toBe(false);
    expect(nonString.plugins?.installs?.["bad-path"]?.source).toBe("path");
    expect(nonString.plugins?.installs?.["bad-path"]?.installPath).toBe(12);

    const blank: ElizaConfig = {
      plugins: {
        installs: {
          blank: { source: "path", installPath: "   " },
        },
      },
    };
    expect(repairBrokenInstallRecord(blank, "blank")).toBe(false);
    expect(blank.plugins?.installs?.blank).toEqual({
      source: "path",
      installPath: "   ",
    });
  });

  it("clears the install path and forces npm resolution for a broken record", () => {
    const config: ElizaConfig = {
      plugins: {
        installs: {
          "@elizaos/plugin-sql": {
            source: "path",
            installPath: "/gone/plugin",
            version: "1.2.3",
          },
        },
      },
    };
    expect(repairBrokenInstallRecord(config, "@elizaos/plugin-sql")).toBe(true);
    expect(config.plugins?.installs?.["@elizaos/plugin-sql"]).toEqual({
      source: "npm",
      installPath: "",
      version: "1.2.3",
    });
  });
});

describe("resolveElizaPluginImportSpecifier", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-types-spec-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns non @elizaos/plugin- names unchanged, including empty and near-miss prefixes", () => {
    expect(resolveElizaPluginImportSpecifier("")).toBe("");
    expect(resolveElizaPluginImportSpecifier("plugin-sql")).toBe("plugin-sql");
    expect(resolveElizaPluginImportSpecifier("@elizaos/plugin")).toBe(
      "@elizaos/plugin",
    );
    expect(resolveElizaPluginImportSpecifier("@elizaos/core")).toBe(
      "@elizaos/core",
    );
  });

  it("returns the package name when the bundled index.js is missing", () => {
    const runtimeUrl = pathToFileURL(
      path.join(tmpDir, "runtime", "plugin-types.js"),
    ).href;
    expect(
      resolveElizaPluginImportSpecifier(
        "@elizaos/plugin-does-not-exist",
        runtimeUrl,
      ),
    ).toBe("@elizaos/plugin-does-not-exist");
  });

  it("returns a file URL when runtime-relative plugins/<name>/index.js exists", async () => {
    const indexPath = path.join(tmpDir, "plugins", "sql", "index.js");
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, "export default {}\n");
    const runtimeUrl = pathToFileURL(
      path.join(tmpDir, "runtime", "plugin-types.js"),
    ).href;
    expect(
      resolveElizaPluginImportSpecifier("@elizaos/plugin-sql", runtimeUrl),
    ).toBe(pathToFileURL(indexPath).href);
  });

  it("uses thisDir as distRoot when the module directory does not end with runtime", async () => {
    const distRoot = path.join(tmpDir, "src");
    const indexPath = path.join(distRoot, "plugins", "sql", "index.js");
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, "export default {}\n");
    const runtimeUrl = pathToFileURL(
      path.join(distRoot, "plugin-types.js"),
    ).href;
    expect(
      resolveElizaPluginImportSpecifier("@elizaos/plugin-sql", runtimeUrl),
    ).toBe(pathToFileURL(indexPath).href);
  });

  it("treats a directory whose name merely ends with runtime as the runtime folder", async () => {
    const indexPath = path.join(tmpDir, "plugins", "sql", "index.js");
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(indexPath, "export default {}\n");
    const runtimeUrl = pathToFileURL(
      path.join(tmpDir, "myruntime", "plugin-types.js"),
    ).href;
    expect(
      resolveElizaPluginImportSpecifier("@elizaos/plugin-sql", runtimeUrl),
    ).toBe(pathToFileURL(indexPath).href);
  });
});

describe("resolvePackageEntry", () => {
  let pkgRoot: string;

  beforeEach(async () => {
    pkgRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-types-entry-"));
  });

  afterEach(async () => {
    await fs.rm(pkgRoot, { recursive: true, force: true });
  });

  it("falls back to dist/index when package.json is missing", async () => {
    await expect(resolvePackageEntry(pkgRoot)).resolves.toBe(
      path.resolve(pkgRoot, "dist", "index"),
    );
  });

  it("prefers an existing fallback candidate in listed order when package.json is missing", async () => {
    const indexTs = path.join(pkgRoot, "index.ts");
    await fs.writeFile(indexTs, "export {}\n");
    await expect(resolvePackageEntry(pkgRoot)).resolves.toBe(
      path.resolve(indexTs),
    );
  });

  it("uses the string exports map for subpath . when the file exists", async () => {
    await writeJson(path.join(pkgRoot, "package.json"), {
      exports: { ".": "./lib/entry.js" },
    });
    const entry = path.join(pkgRoot, "lib", "entry.js");
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, "export {}\n");
    await expect(resolvePackageEntry(pkgRoot)).resolves.toBe(
      path.resolve(entry),
    );
  });

  it("walks eliza-source, then import, then default on a nested exports object", async () => {
    await writeJson(path.join(pkgRoot, "package.json"), {
      exports: {
        ".": {
          "eliza-source": { import: "./src/index.ts" },
          import: "./dist/index.js",
          default: "./fallback.js",
        },
      },
    });
    const source = path.join(pkgRoot, "src", "index.ts");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.writeFile(source, "export {}\n");
    await fs.mkdir(path.join(pkgRoot, "dist"), { recursive: true });
    await fs.writeFile(path.join(pkgRoot, "dist", "index.js"), "export {}\n");
    await fs.writeFile(path.join(pkgRoot, "fallback.js"), "export {}\n");
    await expect(resolvePackageEntry(pkgRoot)).resolves.toBe(
      path.resolve(source),
    );
  });

  it("falls through nested export candidates to the first existing fallback", async () => {
    await writeJson(path.join(pkgRoot, "package.json"), {
      exports: {
        ".": {
          import: "./missing-import.js",
          default: "./missing-default.js",
        },
      },
    });
    const main = path.join(pkgRoot, "index.mjs");
    await fs.writeFile(main, "export {}\n");
    await expect(resolvePackageEntry(pkgRoot)).resolves.toBe(
      path.resolve(main),
    );
  });

  it("uses a string exports value for subpath .", async () => {
    await writeJson(path.join(pkgRoot, "package.json"), {
      exports: "./from-string-exports.js",
    });
    const entry = path.join(pkgRoot, "from-string-exports.js");
    await fs.writeFile(entry, "export {}\n");
    await expect(resolvePackageEntry(pkgRoot)).resolves.toBe(
      path.resolve(entry),
    );
  });

  it("uses package.json main when exports is absent", async () => {
    await writeJson(path.join(pkgRoot, "package.json"), {
      main: "./main.js",
    });
    const entry = path.join(pkgRoot, "main.js");
    await fs.writeFile(entry, "export {}\n");
    await expect(resolvePackageEntry(pkgRoot)).resolves.toBe(
      path.resolve(entry),
    );
  });

  it("returns the first candidate even when every path is missing", async () => {
    await writeJson(path.join(pkgRoot, "package.json"), {
      exports: { ".": "./nowhere.js" },
    });
    await expect(resolvePackageEntry(pkgRoot)).resolves.toBe(
      path.resolve(pkgRoot, "nowhere.js"),
    );
  });

  it("resolves a non-dot export subpath and strips a leading ./", async () => {
    await writeJson(path.join(pkgRoot, "package.json"), {
      exports: { "./actions": "./lib/actions.js" },
    });
    const entry = path.join(pkgRoot, "lib", "actions.js");
    await fs.mkdir(path.dirname(entry), { recursive: true });
    await fs.writeFile(entry, "export {}\n");
    await expect(resolvePackageEntry(pkgRoot, "./actions")).resolves.toBe(
      path.resolve(entry),
    );
  });

  it("falls back through dist/<subpath> then extension variants for a missing subpath export", async () => {
    await writeJson(path.join(pkgRoot, "package.json"), {});
    const js = path.join(pkgRoot, "dist", "actions.js");
    await fs.mkdir(path.dirname(js), { recursive: true });
    await fs.writeFile(js, "export {}\n");
    await expect(resolvePackageEntry(pkgRoot, "actions")).resolves.toBe(
      path.resolve(js),
    );
  });

  it("does not use main or string exports when resolving a non-dot subpath", async () => {
    await writeJson(path.join(pkgRoot, "package.json"), {
      main: "./main.js",
      exports: "./from-string-exports.js",
    });
    await fs.writeFile(path.join(pkgRoot, "main.js"), "export {}\n");
    await fs.writeFile(
      path.join(pkgRoot, "from-string-exports.js"),
      "export {}\n",
    );
    await expect(resolvePackageEntry(pkgRoot, "./missing")).resolves.toBe(
      path.resolve(pkgRoot, "dist", "missing"),
    );
  });

  it("skips duplicate resolved candidates and still returns the first existing path", async () => {
    await writeJson(path.join(pkgRoot, "package.json"), {
      exports: {
        ".": {
          import: "./same.js",
          default: "./same.js",
        },
      },
    });
    const entry = path.join(pkgRoot, "same.js");
    await fs.writeFile(entry, "export {}\n");
    await expect(resolvePackageEntry(pkgRoot)).resolves.toBe(
      path.resolve(entry),
    );
  });

  it("rethrows invalid package.json JSON rather than inventing an entry", async () => {
    await fs.writeFile(path.join(pkgRoot, "package.json"), "{not json");
    await expect(resolvePackageEntry(pkgRoot)).rejects.toBeInstanceOf(
      SyntaxError,
    );
  });
});
