/**
 * Exercises connector export extraction and optional package/filesystem
 * resolution against real installed packages and paths, without live APIs.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  extractPlugin,
  isPackageImportResolvable,
  looksLikePlugin,
  type PluginModuleShape,
  resolveFarcasterPluginImportSpecifier,
  resolveFeishuPluginImportSpecifier,
  resolveLensPluginImportSpecifier,
  resolveMatrixPluginImportSpecifier,
  resolveNostrPluginImportSpecifier,
  resolveTelegramPluginImportSpecifier,
} from "./connector-imports";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function existingFileHref(absolutePath: string): string | null {
  return existsSync(absolutePath) ? pathToFileURL(absolutePath).href : null;
}

function expectedPluginSpecifier({
  packageNames,
  nodeModulesEntries,
  localEntries,
}: {
  packageNames: readonly string[];
  nodeModulesEntries?: readonly {
    packageName: string;
    relativeEntryPath: string;
  }[];
  localEntries?: readonly string[];
}): string | null {
  for (const packageName of packageNames) {
    if (isPackageImportResolvable(packageName)) {
      return packageName;
    }
  }
  for (const entry of nodeModulesEntries ?? []) {
    const href = existingFileHref(
      path.resolve(
        PACKAGE_ROOT,
        "node_modules",
        ...entry.packageName.split("/"),
        entry.relativeEntryPath,
      ),
    );
    if (href) return href;
  }
  for (const relativeEntryPath of localEntries ?? []) {
    const href = existingFileHref(
      path.resolve(PACKAGE_ROOT, relativeEntryPath),
    );
    if (href) return href;
  }
  return null;
}

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
    expect(namedExport.name).toBe("namedExport");
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

  it("skips default and plugin keys while scanning remaining exports, and returns the first insertion-order match", () => {
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

  it("returns null rather than a missing nested item when no export matches", () => {
    expect(
      extractPlugin({
        default: undefined,
        plugin: undefined,
        actions: [],
      }),
    ).toBeNull();
  });
});

describe("isPackageImportResolvable", () => {
  it("returns true for packages that Node can resolve from this module", () => {
    expect(isPackageImportResolvable("vitest")).toBe(true);
    expect(isPackageImportResolvable("@elizaos/core")).toBe(true);
  });

  it("returns false for an empty name and for a package that does not exist", () => {
    expect(isPackageImportResolvable("")).toBe(false);
    expect(
      isPackageImportResolvable(
        "@elizaos/this-package-is-not-installed-9f3a2c1b",
      ),
    ).toBe(false);
  });
});

describe("plugin import specifiers", () => {
  it("resolves Telegram in package-name, node_modules dist, then local-checkout order", () => {
    expect(resolveTelegramPluginImportSpecifier()).toBe(
      expectedPluginSpecifier({
        packageNames: ["@elizaos/plugin-telegram"],
        nodeModulesEntries: [
          {
            packageName: "@elizaos/plugin-telegram",
            relativeEntryPath: "dist/index.js",
          },
        ],
        localEntries: ["../plugins/plugin-telegram/dist/index"],
      }),
    );
  });

  it("resolves Lens with the canonical name, then the client-lens fallback, then filesystem probes", () => {
    expect(resolveLensPluginImportSpecifier()).toBe(
      expectedPluginSpecifier({
        packageNames: ["@elizaos/plugin-lens", "@elizaos-plugins/client-lens"],
        nodeModulesEntries: [
          {
            packageName: "@elizaos-plugins/client-lens",
            relativeEntryPath: "src/index.ts",
          },
          {
            packageName: "@elizaos-plugins/client-lens",
            relativeEntryPath: "dist/index.js",
          },
        ],
        localEntries: [
          "../plugins/plugin-lens/dist/index",
          "../../client-lens/dist/index",
          "../../client-lens/src/index",
        ],
      }),
    );
  });

  it("resolves Farcaster from the package name, then the local node dist entry", () => {
    expect(resolveFarcasterPluginImportSpecifier()).toBe(
      expectedPluginSpecifier({
        packageNames: ["@elizaos/plugin-farcaster"],
        localEntries: ["../plugins/plugin-farcaster/dist/node/index.node.js"],
      }),
    );
  });

  it("resolves Nostr from the package name, then the local dist entry", () => {
    expect(resolveNostrPluginImportSpecifier()).toBe(
      expectedPluginSpecifier({
        packageNames: ["@elizaos/plugin-nostr"],
        localEntries: ["../plugins/plugin-nostr/dist/index"],
      }),
    );
  });

  it("resolves Matrix from the package name, then the local dist entry", () => {
    expect(resolveMatrixPluginImportSpecifier()).toBe(
      expectedPluginSpecifier({
        packageNames: ["@elizaos/plugin-matrix"],
        localEntries: ["../plugins/plugin-matrix/dist/index"],
      }),
    );
  });

  it("resolves Feishu in package-name, node_modules dist, then local-checkout order", () => {
    expect(resolveFeishuPluginImportSpecifier()).toBe(
      expectedPluginSpecifier({
        packageNames: ["@elizaos/plugin-feishu"],
        nodeModulesEntries: [
          {
            packageName: "@elizaos/plugin-feishu",
            relativeEntryPath: "dist/index.js",
          },
        ],
        localEntries: ["../plugins/plugin-feishu/dist/index"],
      }),
    );
  });

  it("returns a resolvable package name, an existing file URL, or null", () => {
    const specifiers = [
      resolveTelegramPluginImportSpecifier(),
      resolveLensPluginImportSpecifier(),
      resolveFarcasterPluginImportSpecifier(),
      resolveNostrPluginImportSpecifier(),
      resolveMatrixPluginImportSpecifier(),
      resolveFeishuPluginImportSpecifier(),
    ];
    for (const specifier of specifiers) {
      if (specifier === null) continue;
      if (specifier.startsWith("file:")) {
        expect(existsSync(fileURLToPath(specifier))).toBe(true);
      } else {
        expect(isPackageImportResolvable(specifier)).toBe(true);
      }
    }
  });
});
