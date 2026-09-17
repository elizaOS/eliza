/**
 * Resolves optional connector plugins for repository integration tests and
 * extracts their supported export shapes before the tests boot them.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type PluginModuleShape = {
  [key: string]: unknown;
  default?: unknown;
  plugin?: unknown;
};

/** Loose plugin-shape predicate used in dynamic test imports across suites. */
export function looksLikePlugin(value: unknown): value is { name: string } {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).name === "string"
  );
}

/** Extract a plugin-like object from a dynamic module export shape. */
export function extractPlugin(mod: PluginModuleShape): { name: string } | null {
  if (looksLikePlugin(mod.default)) return mod.default;
  if (looksLikePlugin(mod.plugin)) return mod.plugin;
  if (looksLikePlugin(mod)) return mod;
  for (const key of Object.keys(mod)) {
    if (key === "default" || key === "plugin") continue;
    if (looksLikePlugin(mod[key])) return mod[key] as { name: string };
  }
  return null;
}

/** Check whether a package name can be resolved for dynamic import. */
export function isPackageImportResolvable(packageName: string): boolean {
  const require = createRequire(import.meta.url);
  try {
    require.resolve(packageName);
    return true;
  } catch {
    // error-policy:J3 unresolved packages are explicitly unavailable to the test.
    return false;
  }
}

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function resolveFirstExistingPath(
  relativeEntryPaths: readonly string[],
): string | null {
  for (const relativeEntryPath of relativeEntryPaths) {
    const absoluteEntryPath = path.resolve(PACKAGE_ROOT, relativeEntryPath);
    if (existsSync(absoluteEntryPath)) {
      return pathToFileURL(absoluteEntryPath).href;
    }
  }

  return null;
}

function resolveNodeModulesEntry(
  packageName: string,
  relativeEntryPath: string,
): string | null {
  const packageSegments = packageName.split("/");
  const entryPath = path.resolve(
    PACKAGE_ROOT,
    "node_modules",
    ...packageSegments,
    relativeEntryPath,
  );
  return existsSync(entryPath) ? pathToFileURL(entryPath).href : null;
}

/**
 * Resolve a plugin import specifier for a connector live test.
 *
 * Resolution order:
 * 1. Package resolution (CJS `require.resolve`) of the canonical name, then
 *    any alternate package names.
 * 2. Direct `node_modules` entry probes — required for ESM-only packages whose
 *    `require.resolve` fails (Telegram/Lens/Feishu ship ESM-only dist entries).
 * 3. Local plugin-checkout paths relative to the package root.
 */
function resolvePluginImportSpecifier({
  packageName,
  alternatePackageNames = [],
  nodeModulesEntries = [],
  localEntries = [],
}: {
  packageName: string;
  alternatePackageNames?: readonly string[];
  nodeModulesEntries?: readonly {
    packageName: string;
    relativeEntryPath: string;
  }[];
  localEntries?: readonly string[];
}): string | null {
  for (const candidatePackageName of [packageName, ...alternatePackageNames]) {
    if (isPackageImportResolvable(candidatePackageName)) {
      return candidatePackageName;
    }
  }

  for (const entry of nodeModulesEntries) {
    const resolved = resolveNodeModulesEntry(
      entry.packageName,
      entry.relativeEntryPath,
    );
    if (resolved) return resolved;
  }

  return resolveFirstExistingPath(localEntries);
}

const TELEGRAM_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-telegram";

export function resolveTelegramPluginImportSpecifier(): string | null {
  return resolvePluginImportSpecifier({
    packageName: TELEGRAM_PLUGIN_PACKAGE_NAME,
    nodeModulesEntries: [
      {
        packageName: TELEGRAM_PLUGIN_PACKAGE_NAME,
        relativeEntryPath: "dist/index.js",
      },
    ],
    localEntries: ["../plugins/plugin-telegram/dist/index"],
  });
}

const LENS_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-lens";
const LENS_PLUGIN_FALLBACK_PACKAGE = "@elizaos-plugins/client-lens";

export function resolveLensPluginImportSpecifier(): string | null {
  return resolvePluginImportSpecifier({
    packageName: LENS_PLUGIN_PACKAGE_NAME,
    alternatePackageNames: [LENS_PLUGIN_FALLBACK_PACKAGE],
    nodeModulesEntries: [
      {
        packageName: LENS_PLUGIN_FALLBACK_PACKAGE,
        relativeEntryPath: "src/index.ts",
      },
      {
        packageName: LENS_PLUGIN_FALLBACK_PACKAGE,
        relativeEntryPath: "dist/index.js",
      },
    ],
    localEntries: [
      "../plugins/plugin-lens/dist/index",
      "../../client-lens/dist/index",
      "../../client-lens/src/index",
    ],
  });
}

const FARCASTER_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-farcaster";

export function resolveFarcasterPluginImportSpecifier(): string | null {
  return resolvePluginImportSpecifier({
    packageName: FARCASTER_PLUGIN_PACKAGE_NAME,
    localEntries: ["../plugins/plugin-farcaster/dist/node/index.node.js"],
  });
}

const NOSTR_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-nostr";

export function resolveNostrPluginImportSpecifier(): string | null {
  return resolvePluginImportSpecifier({
    packageName: NOSTR_PLUGIN_PACKAGE_NAME,
    localEntries: ["../plugins/plugin-nostr/dist/index"],
  });
}

const MATRIX_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-matrix";

export function resolveMatrixPluginImportSpecifier(): string | null {
  return resolvePluginImportSpecifier({
    packageName: MATRIX_PLUGIN_PACKAGE_NAME,
    localEntries: ["../plugins/plugin-matrix/dist/index"],
  });
}

const FEISHU_PLUGIN_PACKAGE_NAME = "@elizaos/plugin-feishu";

export function resolveFeishuPluginImportSpecifier(): string | null {
  return resolvePluginImportSpecifier({
    packageName: FEISHU_PLUGIN_PACKAGE_NAME,
    nodeModulesEntries: [
      {
        packageName: FEISHU_PLUGIN_PACKAGE_NAME,
        relativeEntryPath: "dist/index.js",
      },
    ],
    localEntries: ["../plugins/plugin-feishu/dist/index"],
  });
}
