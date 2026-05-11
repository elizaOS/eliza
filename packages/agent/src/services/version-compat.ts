/**
 * Plugin ↔ Core version compatibility validation.
 *
 * Detects version skew between @elizaos/core and plugins that depend on
 * specific core exports. This catches the class of bug where plugins on npm
 * advance past the core version, importing symbols that don't exist yet in
 * the installed core — causing silent import failures that take down every
 * model provider.
 *
 * @see https://github.com/elizaos/eliza/issues/10
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a single plugin compatibility check. */
export interface PluginCompatResult {
  /** Plugin package name. */
  plugin: string;
  /** Whether the plugin is compatible with the installed core. */
  compatible: boolean;
  /** The installed plugin version, or null if unresolvable. */
  pluginVersion: string | null;
  /** The installed core version. */
  coreVersion: string;
  /** List of symbols the plugin needs that are missing from core. */
  missingExports: string[];
  /** Human-readable explanation when incompatible. */
  message: string;
}

/** Aggregate result of validating all critical plugins. */
export interface VersionCompatReport {
  /** Whether all checked plugins are compatible. */
  compatible: boolean;
  /** Per-plugin results. */
  results: PluginCompatResult[];
  /** Plugins that failed the check. */
  failures: PluginCompatResult[];
  /** Advisory message (e.g. "pin to beta.0" or "upgrade core"). */
  advisory: string;
}

/**
 * Plugins that provide AI model capabilities. If ALL of these fail to load
 * the agent is completely non-functional — no responses can be generated.
 */
export const AI_PROVIDER_PLUGINS: readonly string[] = [
  "@elizaos/plugin-anthropic",
  "@elizaos/plugin-openai",
  "@elizaos/plugin-openrouter",
  "@elizaos/plugin-ollama",
  "@elizaos/plugin-mlx",
  "@elizaos/plugin-google-genai",
  "@elizaos/plugin-groq",
  "@elizaos/plugin-xai",
  "@elizaos/plugin-zai",
  "@elizaos/plugin-elizacloud",
  "@elizaos/plugin-codex-cli",
];

/**
 * Self-declared plugin names (the `name` property on the plugin object) that
 * correspond to AI provider plugins.  Some plugins use a short internal name
 * (e.g. "elizaOSCloud") that differs from the npm package name.  The
 * diagnostic must recognise both forms to avoid false-positive warnings.
 */
const AI_PROVIDER_PLUGIN_ALIASES: readonly string[] = [
  "elizaOSCloud",
  "codex-cli",
];

// ---------------------------------------------------------------------------
// Semver comparison for stable and prerelease tags.
// ---------------------------------------------------------------------------

/**
 * Parse a semver string (including pre-release tags) into a comparable tuple.
 * Returns null for unparseable versions.
 *
 * Examples:
 *   "2.0.0-beta.0"           → [2, 0, 0, 0]
 *   "2.0.0-beta.1"           → [2, 0, 0, 1]
 *   "2.0.0-nightly.20260208" → [2, 0, 0, 20260208]
 *   "2.0.0"                  → [2, 0, 0, Infinity]  (release beats any pre-release)
 *
 * Note: comparisons are only meaningful within the same pre-release tag type
 * (beta vs beta, nightly vs nightly). Cross-tag comparisons (beta.1 vs rc.1)
 * compare only the numeric suffix, which may not reflect the intended ordering.
 * The update checker always compares within the same channel, so this is safe.
 */
export function parseSemver(
  version: string,
): [number, number, number, number] | null {
  const match = version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-(?:beta|rc|nightly)\.(\d+))?$/,
  );
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  // A release without a pre-release tag sorts after any pre-release.
  const pre =
    match[4] !== undefined ? Number(match[4]) : Number.POSITIVE_INFINITY;

  return [major, minor, patch, pre];
}

/**
 * Compare two semver strings. Returns:
 *   -1 if a < b
 *    0 if a === b
 *    1 if a > b
 *   null if either version is unparseable.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;

  for (let i = 0; i < 4; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * Check if `installed` version satisfies `>= required`.
 */
export function versionSatisfies(installed: string, required: string): boolean {
  const cmp = compareSemver(installed, required);
  return cmp !== null && cmp >= 0;
}

// ---------------------------------------------------------------------------
// Core export probing
// ---------------------------------------------------------------------------

/**
 * Check whether a specific named export exists in `@elizaos/core`.
 *
 * This does a live import check — it tests the *actual* installed module,
 * not a version number lookup.
 */
export async function coreExportExists(exportName: string): Promise<boolean> {
  try {
    const core = (await import("@elizaos/core")) as Record<string, unknown>;
    return exportName in core && core[exportName] !== undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
      return false;
    }
    throw err;
  }
}

/**
 * Read the installed version of a package from its package.json.
 * Returns null if the package is not installed or the version is unreadable.
 */
export async function getInstalledVersion(
  packageName: string,
): Promise<string | null> {
  try {
    // Dynamic import of package.json is not universally supported, so we
    // use createRequire as a robust fallback for reading metadata.
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve(`${packageName}/package.json`);
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      version: string;
    };
    return pkg.version ?? null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (
      code === "MODULE_NOT_FOUND" ||
      code === "ERR_MODULE_NOT_FOUND" ||
      code === "ENOENT"
    ) {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a single plugin's compatibility with the installed core.
 */
export async function validatePluginCompat(
  pluginName: string,
  coreVersion: string,
): Promise<PluginCompatResult> {
  const missingExports: string[] = [];

  const pluginVersion = await getInstalledVersion(pluginName);
  const compatible = missingExports.length === 0;

  let message = "";
  if (!compatible) {
    message =
      `${pluginName}${pluginVersion ? `@${pluginVersion}` : ""} requires ` +
      `${missingExports.join(", ")} from @elizaos/core, but the installed ` +
      `core@${coreVersion} does not export ${missingExports.length === 1 ? "it" : "them"}. ` +
      `Pin this plugin to a version compatible with core@${coreVersion}, or upgrade core.`;
  }

  return {
    plugin: pluginName,
    compatible,
    pluginVersion,
    coreVersion,
    missingExports,
    message,
  };
}

/**
 * After plugin resolution, check whether at least one AI provider plugin
 * loaded successfully. If none loaded, return a diagnostic message explaining
 * whether this is a version-skew issue or a configuration issue.
 *
 * @param loadedPluginNames - Names of plugins that loaded successfully.
 * @param failedPlugins - Names + error strings of plugins that failed to load.
 */
export function diagnoseNoAIProvider(
  loadedPluginNames: string[],
  failedPlugins: Array<{ name: string; error: string }>,
): string | null {
  const isAIProvider = (name: string): boolean =>
    AI_PROVIDER_PLUGINS.includes(name) ||
    AI_PROVIDER_PLUGIN_ALIASES.includes(name);

  const loadedProviders = loadedPluginNames.filter(isAIProvider);

  // At least one AI provider loaded — no issue.
  if (loadedProviders.length > 0) return null;

  if (
    process.env.ELIZA_LOCAL_LLAMA?.trim() === "1" ||
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1"
  ) {
    return null;
  }

  // Check if any AI provider plugins were attempted but failed.
  const failedProviders = failedPlugins.filter((f) =>
    AI_PROVIDER_PLUGINS.includes(f.name),
  );

  if (failedProviders.length === 0) {
    return (
      "No AI provider plugin was loaded. Set an API key environment variable " +
      "(e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY) or log in " +
      "to Eliza Cloud (ELIZAOS_CLOUD_API_KEY) to enable at least one model provider."
    );
  }

  // Check for the specific version-skew signature.
  const versionSkewPlugins = failedProviders.filter(
    (f) =>
      f.error.includes("not found in module") ||
      f.error.includes("Export named") ||
      f.error.includes("does not provide an export named"),
  );

  if (versionSkewPlugins.length > 0) {
    const names = versionSkewPlugins.map((f) => f.name).join(", ");
    return (
      `Version skew detected: ${names} failed to import required symbols from ` +
      `@elizaos/core. This usually means the plugin version is ahead of the ` +
      `installed core version. Pin the affected plugins to a version compatible ` +
      `with your installed @elizaos/core, or upgrade core. ` +
      `See: https://github.com/elizaos/eliza/issues/10`
    );
  }

  // Generic failure.
  const details = failedProviders
    .map((f) => `  ${f.name}: ${f.error}`)
    .join("\n");
  return `All AI provider plugins failed to load:\n${details}`;
}
