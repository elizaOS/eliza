// Plugin manifest evaluation engine.
//
// Each plugin declares its auto-enable conditions in its package.json under
// `elizaos.plugin`, optionally pointing at a small JS module that implements
// the actual `shouldEnable(ctx)` check:
//
//   {
//     "elizaos": {
//       "plugin": {
//         "autoEnableModule": "./dist/auto-enable.js",
//         "force": false,
//         "capabilities": ["text-large", "tool-use"]
//       }
//     }
//   }
//
// The check module exports:
//
//   export function shouldEnable(ctx: PluginAutoEnableContext): boolean | Promise<boolean>;
//   export function shouldForce?(ctx: PluginAutoEnableContext): boolean;  // optional override
//
// The engine here:
//   1. Walks a list of candidate plugin packages.
//   2. Reads each package.json for the elizaos.plugin block.
//   3. Dynamic-imports the autoEnableModule (cheap if it stays small — convention,
//      not enforced; consumers can lint via knip or import-graph if drift becomes a problem).
//   4. Evaluates shouldEnable + shouldForce against the runtime context.
//   5. Returns a verdict per plugin.
//
// This replaces the centralized maps in plugin-auto-enable-engine.ts. Both
// engines coexist during the migration: the new one runs first, the old one
// fills gaps for plugins that haven't migrated yet. When all plugins ship a
// manifest, the central maps and the old engine can be deleted.

import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  PluginAutoEnableContext,
  PluginAutoEnableModule,
} from "@elizaos/core";

import type { ElizaConfig } from "./types.eliza";

// Re-export the runtime types so consumers that import from @elizaos/shared
// keep working. The canonical home for these is @elizaos/core (plugin author
// API surface) — they live there so plugin packages don't need to depend on
// app/shared just to type a manifest predicate.
export type { PluginAutoEnableContext, PluginAutoEnableModule };

/** Subset of package.json the manifest reader cares about. */
export interface PluginPackageManifestBlock {
  /**
   * Path (relative to the plugin's package root) to the autoEnable check module.
   * The module must implement {@link PluginAutoEnableModule}.
   */
  autoEnableModule?: string;
  /**
   * Static capability declarations. Apps can use these to filter candidates
   * (e.g. "I only need plugins that declare `wallet` capability"). Purely
   * informational — the engine doesn't act on them today.
   */
  capabilities?: string[];
  /**
   * Hard-coded force flag. When true, the plugin overrides
   * `config.plugins.entries[X].enabled === false`. Equivalent to a
   * `shouldForce` that always returns true; useful when force is unconditional.
   */
  force?: boolean;
}

export interface PluginPackageManifest {
  name: string;
  version?: string;
  elizaos?: {
    plugin?: PluginPackageManifestBlock;
  };
}

/**
 * Minimal candidate shape for the autoEnable manifest evaluator.
 *
 * This is intentionally narrower than `PluginCandidate` in @elizaos/core —
 * the manifest evaluator only needs the package name and root dir; the richer
 * `PluginCandidate` shape with `idHint`, `source`, `origin`, etc. is for the
 * full plugin discovery / loading pipeline.
 */
export interface PluginManifestCandidate {
  /** npm package name (e.g. "@elizaos/plugin-anthropic"). */
  packageName: string;
  /** Absolute path to the package root (the dir containing package.json). */
  packageRoot: string;
}

/** Verdict for a single candidate after evaluating its manifest. */
export interface PluginManifestVerdict {
  packageName: string;
  /** Short id derived from the package name, e.g. "anthropic" for "@elizaos/plugin-anthropic". */
  shortId: string;
  /** True when shouldEnable() returned truthy. */
  enabled: boolean;
  /** True when shouldForce() returned truthy or `manifest.force === true`. */
  force: boolean;
  /** Capabilities declared in package.json. */
  capabilities: string[];
  /** Human-readable reason for the verdict — used for `[eliza] Plugin auto-enable: ...` log lines. */
  reason: string | null;
  /** When non-null the manifest existed but the check module failed to load/run; the plugin is treated as not-enabled. */
  error: string | null;
}

/**
 * Derive the short id used for `plugins.allow` and `plugins.entries` lookups.
 * Mirrors the logic in plugin-auto-enable-engine.addToAllowlist.
 */
export function pluginShortId(packageName: string): string {
  return packageName.includes("/plugin-")
    ? packageName.slice(packageName.lastIndexOf("/plugin-") + "/plugin-".length)
    : packageName;
}

/**
 * Read `package.json` for a candidate and extract the elizaos.plugin block.
 * Returns null when no package.json exists or it doesn't declare an elizaos.plugin block.
 */
export async function readPluginPackageManifest(
  packageRoot: string,
): Promise<PluginPackageManifest | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(packageRoot, "package.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as PluginPackageManifest;
  if (!parsed?.elizaos?.plugin) return null;
  return parsed;
}

const CHECK_MODULE_CACHE = new Map<
  string,
  PluginAutoEnableModule | "missing"
>();

/**
 * Dynamic-import the check module declared by a manifest. Cached per absolute
 * module path so re-evaluation across multiple boots in the same process
 * (e.g. test suites) doesn't re-import.
 */
async function loadCheckModule(
  packageRoot: string,
  modulePath: string,
): Promise<PluginAutoEnableModule | null> {
  const absolute = path.resolve(packageRoot, modulePath);
  const cached = CHECK_MODULE_CACHE.get(absolute);
  if (cached === "missing") return null;
  if (cached) return cached;

  try {
    await fs.access(absolute);
  } catch {
    CHECK_MODULE_CACHE.set(absolute, "missing");
    return null;
  }

  const url = pathToFileURL(absolute).href;
  // Dynamic file:// import — Vite's static analyzer flags this on the client
  // bundle even though the engine only runs server-side at boot. Suppress.
  const mod = (await import(
    /* @vite-ignore */ url
  )) as Partial<PluginAutoEnableModule> & {
    default?: Partial<PluginAutoEnableModule>;
  };
  // Accept both named and default exports — `export function shouldEnable`
  // and `export default { shouldEnable }` both work.
  const resolved: PluginAutoEnableModule | null =
    typeof mod.shouldEnable === "function"
      ? { shouldEnable: mod.shouldEnable, shouldForce: mod.shouldForce }
      : typeof mod.default?.shouldEnable === "function"
        ? {
            shouldEnable: mod.default.shouldEnable,
            shouldForce: mod.default.shouldForce,
          }
        : null;

  if (!resolved) {
    CHECK_MODULE_CACHE.set(absolute, "missing");
    return null;
  }

  CHECK_MODULE_CACHE.set(absolute, resolved);
  return resolved;
}

/**
 * Evaluate one candidate's manifest against the runtime context. Pure
 * verdict — caller decides how to apply it to the allow list / force overrides.
 */
export async function evaluatePluginManifest(
  candidate: PluginManifestCandidate,
  ctx: PluginAutoEnableContext,
): Promise<PluginManifestVerdict | null> {
  const manifest = await readPluginPackageManifest(candidate.packageRoot);
  if (!manifest) return null;

  const block = manifest.elizaos?.plugin ?? {};
  const shortId = pluginShortId(candidate.packageName);
  const capabilities = Array.isArray(block.capabilities)
    ? block.capabilities.filter((c): c is string => typeof c === "string")
    : [];

  if (!block.autoEnableModule) {
    // Manifest exists but no check module — treat as not-auto-enabled (the
    // plugin can still be enabled via explicit user config). Still surface
    // declared capabilities.
    return {
      packageName: candidate.packageName,
      shortId,
      enabled: false,
      force: block.force === true,
      capabilities,
      reason: null,
      error: null,
    };
  }

  let module: PluginAutoEnableModule | null;
  try {
    module = await loadCheckModule(
      candidate.packageRoot,
      block.autoEnableModule,
    );
  } catch (err) {
    return {
      packageName: candidate.packageName,
      shortId,
      enabled: false,
      force: block.force === true,
      capabilities,
      reason: null,
      error: `failed to import autoEnableModule "${block.autoEnableModule}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  if (!module) {
    return {
      packageName: candidate.packageName,
      shortId,
      enabled: false,
      force: block.force === true,
      capabilities,
      reason: null,
      error: `autoEnableModule "${block.autoEnableModule}" did not export a shouldEnable function`,
    };
  }

  let enabled: boolean;
  try {
    enabled = Boolean(await module.shouldEnable(ctx));
  } catch (err) {
    return {
      packageName: candidate.packageName,
      shortId,
      enabled: false,
      force: block.force === true,
      capabilities,
      reason: null,
      error: `shouldEnable threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let force = block.force === true;
  if (module.shouldForce) {
    try {
      force = force || Boolean(module.shouldForce(ctx));
    } catch {
      // Treat predicate failure as "no force" — don't escalate.
      force = block.force === true;
    }
  }

  return {
    packageName: candidate.packageName,
    shortId,
    enabled,
    force,
    capabilities,
    reason: enabled
      ? `manifest: ${candidate.packageName}/${block.autoEnableModule}`
      : null,
    error: null,
  };
}

/**
 * Evaluate every candidate. Verdicts come back in the same order as the input.
 * Failures are reported in the verdict's `error` field — this function never
 * throws so a single bad manifest can't kill auto-enable for the rest.
 */
export async function evaluatePluginManifests(
  candidates: PluginManifestCandidate[],
  ctx: PluginAutoEnableContext,
): Promise<PluginManifestVerdict[]> {
  return Promise.all(
    candidates.map(async (candidate) => {
      try {
        return await evaluatePluginManifest(candidate, ctx);
      } catch (err) {
        return {
          packageName: candidate.packageName,
          shortId: pluginShortId(candidate.packageName),
          enabled: false,
          force: false,
          capabilities: [],
          reason: null,
          error: `manifest read failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }),
  ).then((entries) =>
    entries.filter((v): v is PluginManifestVerdict => v !== null),
  );
}

/**
 * Apply manifest verdicts to a config: push enabled plugins onto
 * `plugins.allow` (with the short id and full package name), set
 * `plugins.entries[shortId].enabled = true` for forced ones, and append
 * human-readable strings to `changes` for log surfacing.
 */
export function applyPluginManifestVerdicts(
  config: Partial<ElizaConfig>,
  verdicts: PluginManifestVerdict[],
  changes: string[],
): void {
  config.plugins = config.plugins ?? {};
  const pluginsConfig = config.plugins;
  pluginsConfig.allow = pluginsConfig.allow ?? [];
  pluginsConfig.entries = pluginsConfig.entries ?? {};

  for (const verdict of verdicts) {
    if (verdict.error) {
      changes.push(
        `Plugin auto-enable error for ${verdict.packageName}: ${verdict.error}`,
      );
      continue;
    }
    if (!verdict.enabled) continue;

    const explicitlyDisabled =
      pluginsConfig.entries[verdict.shortId]?.enabled === false;

    if (explicitlyDisabled && !verdict.force) {
      // User explicitly disabled — respect that unless force is set.
      continue;
    }

    if (verdict.force && explicitlyDisabled) {
      pluginsConfig.entries[verdict.shortId] = {
        ...pluginsConfig.entries[verdict.shortId],
        enabled: true,
      };
    }

    let added = false;
    if (!pluginsConfig.allow.includes(verdict.shortId)) {
      pluginsConfig.allow.push(verdict.shortId);
      added = true;
    }
    if (
      verdict.packageName !== verdict.shortId &&
      !pluginsConfig.allow.includes(verdict.packageName)
    ) {
      pluginsConfig.allow.push(verdict.packageName);
      added = true;
    }
    if (added && verdict.reason) {
      changes.push(
        `Auto-enabled plugin: ${verdict.packageName} (${verdict.reason})`,
      );
    }
  }
}
