// App-level plugin manifest.
//
// Each host app (eliza, milady, custom downstream apps) declares which
// plugins it considers candidates and how they default in its own
// `package.json` under `elizaos.app`:
//
//   {
//     "elizaos": {
//       "app": {
//         "candidates": [
//           "@elizaos/plugin-anthropic",
//           "@elizaos/plugin-openai",
//           "@elizaos/plugin-wallet"
//         ],
//         "defaults": {
//           "@elizaos/plugin-cua": { "enabled": false },
//           "wallet": { "enabled": true }
//         },
//         "capabilities": {
//           "browser": "required",
//           "wallet": "optional"
//         }
//       }
//     }
//   }
//
// The plugin auto-enable engine reads the host app's manifest at boot:
//   - If `candidates` is set, restrict the discovered plugin list to that
//     allow-list (apps that haven't explicitly listed a plugin won't
//     load it even if its own auto-enable matches).
//   - If `defaults` is set, prepopulate `config.plugins.entries` with the
//     declared `{ enabled }` flags BEFORE the manifest evaluator runs, so
//     the user's own config still overrides app defaults.
//   - `capabilities` is informational today — surfaced via the verdict so
//     UIs can show "this app requires X" / "this app needs you to wire up Y".
//
// Apps that don't declare `elizaos.app` are unrestricted (every discovered
// plugin is a candidate, no defaults applied).

import { promises as fs } from "node:fs";
import path from "node:path";

import type { PluginManifestCandidate } from "./plugin-manifest.js";

/** Default to apply for a plugin entry. */
export interface PluginAppDefault {
  /** When false, the plugin is disabled by default unless the user enables it. */
  enabled?: boolean;
}

/** Capability requirement level declared by the app. */
export type AppCapabilityRequirement = "required" | "optional";

export interface AppManifestBlock {
  /**
   * If set, the plugin candidate list is restricted to this set. Plugins
   * outside this list are ignored even if they declare auto-enable in their
   * own package.json.
   *
   * Match by either npm package name (`@elizaos/plugin-X`) or the short id
   * (`X`). Both forms accepted.
   */
  candidates?: string[];
  /**
   * Per-plugin defaults. Keyed by short id OR full package name. Applied to
   * `config.plugins.entries` before the manifest evaluator runs — so the
   * user's saved config still wins, but plugin-specific app defaults take
   * effect on first boot.
   */
  defaults?: Record<string, PluginAppDefault>;
  /**
   * Capability declarations the app expects to be available. Currently
   * informational — surfaced by `readAppManifest` so UIs can warn when a
   * required capability isn't satisfied by any enabled plugin.
   */
  capabilities?: Record<string, AppCapabilityRequirement>;
}

export interface AppPackageManifest {
  name: string;
  version?: string;
  elizaos?: {
    app?: AppManifestBlock;
  };
}

/**
 * Read the host app's package.json and extract the `elizaos.app` block.
 * Returns null when no package.json is found at `appRoot` or when the file
 * has no `elizaos.app` block.
 *
 * Caller decides where the host app lives — typically `process.cwd()` or
 * `ELIZA_WORKSPACE_ROOT`. Walking up the tree to find an enclosing
 * `package.json` is *not* done here on purpose: the host app is an explicit
 * concept and we want exactly the package.json the user named, not whatever
 * happens to be one or two levels up.
 */
export async function readAppManifest(
  appRoot: string,
): Promise<AppManifestBlock | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(appRoot, "package.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const parsed = JSON.parse(raw) as AppPackageManifest;
  return parsed?.elizaos?.app ?? null;
}

/**
 * Restrict a candidate list to the ones declared in the app manifest.
 * When `manifest.candidates` is undefined or empty, returns the input
 * unchanged (no app-level restriction).
 *
 * Match is by package name OR short id — apps can list either form.
 */
export function filterCandidatesByAppManifest(
  candidates: PluginManifestCandidate[],
  manifest: AppManifestBlock | null,
): PluginManifestCandidate[] {
  if (!manifest?.candidates || manifest.candidates.length === 0) {
    return candidates;
  }
  const allow = new Set(manifest.candidates);
  return candidates.filter((c) => {
    if (allow.has(c.packageName)) return true;
    const shortId = c.packageName.includes("/plugin-")
      ? c.packageName.slice(
          c.packageName.lastIndexOf("/plugin-") + "/plugin-".length,
        )
      : c.packageName;
    return allow.has(shortId);
  });
}

/**
 * Pre-populate `config.plugins.entries` from the app manifest defaults.
 * User-set entries (already present in `config.plugins.entries`) win — the
 * defaults only fill in keys the user hasn't explicitly set.
 *
 * Mutates `config` in place. Returns the list of entries that were defaulted
 * (for log surfacing).
 */
export function applyAppManifestDefaults(
  config: { plugins?: { entries?: Record<string, { enabled?: boolean }> } },
  manifest: AppManifestBlock | null,
): string[] {
  if (!manifest?.defaults) return [];
  config.plugins = config.plugins ?? {};
  config.plugins.entries = config.plugins.entries ?? {};
  const entries = config.plugins.entries;
  const applied: string[] = [];
  for (const [id, defaultsForPlugin] of Object.entries(manifest.defaults)) {
    if (entries[id] !== undefined) continue; // user wins
    entries[id] = { ...defaultsForPlugin };
    applied.push(id);
  }
  return applied;
}
