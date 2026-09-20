/**
 * Exercises connector export selection and import resolution with real modules.
 * A disposable package tree checks fallback lookup from the live-test location.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractPlugin,
  looksLikePlugin,
  type PluginModuleShape,
} from "./connector-imports";

describe("looksLikePlugin", () => {
  it("rejects null, undefined, and non-objects", () => {
    expect(looksLikePlugin(null)).toBe(false);
    expect(looksLikePlugin(undefined)).toBe(false);
    expect(looksLikePlugin("plugin")).toBe(false);
    expect(looksLikePlugin(1)).toBe(false);
    expect(looksLikePlugin(true)).toBe(false);
  });

  it("rejects functions even when Function.name is a non-empty string", () => {
    function namedExport() {}
    expect(looksLikePlugin(namedExport)).toBe(false);
  });

  it("rejects objects whose name is missing or not a string", () => {
    expect(looksLikePlugin({})).toBe(false);
    expect(looksLikePlugin({ Name: "wrong-case" })).toBe(false);
    expect(looksLikePlugin({ name: 42 })).toBe(false);
    expect(looksLikePlugin({ name: null })).toBe(false);
    expect(looksLikePlugin({ name: undefined })).toBe(false);
    expect(looksLikePlugin([])).toBe(false);
  });

  it("accepts a plain object whose name is a string, including empty", () => {
    expect(looksLikePlugin({ name: "telegram" })).toBe(true);
    expect(looksLikePlugin({ name: "" })).toBe(true);
    expect(looksLikePlugin({ name: "x", extra: 1 })).toBe(true);
  });
});

describe("extractPlugin", () => {
  it("returns null for an empty module and for modules with no plugin-shaped export", () => {
    expect(extractPlugin({})).toBeNull();
    expect(
      extractPlugin({
        default: { not: "a-plugin" },
        plugin: 1,
        helper: () => undefined,
      }),
    ).toBeNull();
  });

  it("prefers default over plugin when both look like plugins", () => {
    const mod: PluginModuleShape = {
      default: { name: "from-default" },
      plugin: { name: "from-plugin" },
    };
    expect(extractPlugin(mod)).toEqual({ name: "from-default" });
  });

  it("uses plugin when default is present but not plugin-shaped", () => {
    const mod: PluginModuleShape = {
      default: { name: 1 },
      plugin: { name: "from-plugin" },
    };
    expect(extractPlugin(mod)).toEqual({ name: "from-plugin" });
  });

  it("returns the module itself when it has a string name, before scanning other keys", () => {
    const nested = { name: "nested" };
    const mod: PluginModuleShape = {
      name: "root-module",
      other: nested,
    };
    expect(extractPlugin(mod)).toBe(mod);
  });

  it("skips default and plugin keys while scanning remaining exports, in insertion order", () => {
    const first = { name: "first-named" };
    const second = { name: "second-named" };
    const mod: PluginModuleShape = {
      default: { name: 0 },
      plugin: { nope: true },
      first,
      second,
    };
    expect(extractPlugin(mod)).toBe(first);
  });

  it("returns null when no export matches", () => {
    expect(
      extractPlugin({
        default: undefined,
        plugin: undefined,
        actions: [],
      }),
    ).toBeNull();
  });
});

it("loads an ESM-only connector from the package node_modules fallback", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "connector-imports-"));
  try {
    const packageRoot = path.join(directory, "packages/app-core");
    const helper = path.join(
      packageRoot,
      "test/live-agent/helpers/connector-imports.ts",
    );
    const connector = path.join(
      packageRoot,
      "node_modules/@elizaos/plugin-telegram/dist/index.js",
    );
    mkdirSync(path.dirname(helper), { recursive: true });
    mkdirSync(path.dirname(connector), { recursive: true });
    copyFileSync(
      fileURLToPath(new URL("./connector-imports.ts", import.meta.url)),
      helper,
    );
    writeFileSync(path.join(packageRoot, "package.json"), '{"type":"module"}');
    writeFileSync(connector, 'export default { name: "fixture-telegram" };');
    // The package has only an ESM dist entry: require.resolve cannot find a main entry.
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const helper = await import(${JSON.stringify(pathToFileURL(helper).href)});
       const specifier = helper.resolveTelegramPluginImportSpecifier();
       if (specifier === null) throw new Error("connector fallback was not found");
       console.log(JSON.stringify(helper.extractPlugin(await import(specifier))));`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(JSON.parse(output)).toEqual({ name: "fixture-telegram" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
