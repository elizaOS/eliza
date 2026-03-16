/**
 * Plugin ↔ Core version compatibility validation.
 *
 * Detects version skew between @elizaos/core and plugins that depend on
 * specific core exports. This catches the class of bug where plugins on npm
 * advance past the core version, importing symbols that don't exist yet in
 * the installed core — causing silent import failures that take down every
 * model provider.
 *
 * @see https://github.com/milady-ai/milady/issues/10
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
  /** Advisory message (e.g. "pin to alpha.3" or "upgrade core"). */
  advisory: string;
}

// ---------------------------------------------------------------------------
// Known critical exports per version
// ---------------------------------------------------------------------------

/**
 * Exports introduced in specific core versions.
 *
 * When a plugin imports a symbol from @elizaos/core, we can check whether
 * the installed core version actually contains that export. This map records
 * which version first introduced each critical export.
 *
 * Key: export name. Value: minimum core version that includes it.
 */
const CORE_EXPORT_INTRODUCED_IN: Readonly<Record<string, string>> = {
  MAX_EMBEDDING_TOKENS: "2.0.0-alpha.4",
  MAX_EMBEDDING_CHARS: "2.0.0-alpha.4",
};

/**
 * Map of plugin → list of core exports the plugin requires.
 *
 * These are the imports that caused issue #10. If more cross-version
 * import issues are discovered, add them here.
 */
const PLUGIN_REQUIRED_CORE_EXPORTS: Readonly<
  Record<string, readonly string[]>
> = {
  "@elizaos/plugin-openrouter": ["MAX_EMBEDDING_TOKENS"],
  "@elizaos/plugin-openai": ["MAX_EMBEDDING_TOKENS"],
  "@elizaos/plugin-ollama": ["MAX_EMBEDDING_TOKENS"],
  "@elizaos/plugin-google-genai": ["MAX_EMBEDDING_TOKENS"],
  "@elizaos/plugin-knowledge": ["MAX_EMBEDDING_TOKENS"],
};

/**
 * Plugins that provide AI model capabilities. If ALL of these fail to load
 * the agent is completely non-functional — no responses can be generated.
 */
export const AI_PROVIDER_PLUGINS: readonly string[] = [
  "@elizaos/plugin-anthropic",
  "@elizaos/plugin-openai",
  "@elizaos/plugin-openrouter",
  "@elizaos/plugin-ollama",
  "@elizaos/plugin-google-genai",
  "@elizaos/plugin-groq",
  "@elizaos/plugin-xai",
  "@homunculuslabs/plugin-zai",
  "@elizaos/plugin-pi-ai",
  "@elizaos/plugin-elizacloud",
];

// ---------------------------------------------------------------------------
// Semver comparison (simplified for alpha tags)
// ---------------------------------------------------------------------------

/**
 * Parse a semver string (including pre-release tags) into a comparable tuple.
 * Returns null for unparseable versions.
 *
 * Examples:
 *   "2.0.0-alpha.3"          → [2, 0, 0, 3]
 *   "2.0.0-alpha.4"          → [2, 0, 0, 4]
 *   "2.0.0-nightly.20260208" → [2, 0, 0, 20260208]
 *   "2.0.0"                  → [2, 0, 0, Infinity]  (release beats any pre-release)
 *
 * Note: comparisons are only meaningful within the same pre-release tag type
 * (alpha vs alpha, nightly vs nightly). Cross-tag comparisons (alpha.7 vs beta.1)
 * compare only the numeric suffix, which may not reflect the intended ordering.
 * The update checker always compares within the same channel, so this is safe.
 */
export function parseSemver(
  version: string,
): [number, number, number, number] | null {
  const match = version.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-(?:alpha|beta|rc|nightly)\.(\d+))?$/,
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
  const requiredExports = PLUGIN_REQUIRED_CORE_EXPORTS[pluginName];

  // If we don't track this plugin's requirements, assume compatible.
  if (!requiredExports || requiredExports.length === 0) {
    return {
      plugin: pluginName,
      compatible: true,
      pluginVersion: await getInstalledVersion(pluginName),
      coreVersion,
      missingExports: [],
      message: "",
    };
  }

  const missingExports: string[] = [];

  for (const exportName of requiredExports) {
    const minVersion = CORE_EXPORT_INTRODUCED_IN[exportName];

    if (minVersion) {
      // Fast path: compare versions without importing.
      if (!versionSatisfies(coreVersion, minVersion)) {
        missingExports.push(exportName);
        continue;
      }
    }

    // Slow path: probe the actual module to be sure.
    const exists = await coreExportExists(exportName);
    if (!exists) {
      missingExports.push(exportName);
    }
  }

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
 * Validate all known critical plugins against the installed core.
 *
 * Returns a report with per-plugin results and an overall advisory.
 */
export async function validateVersionCompat(): Promise<VersionCompatReport> {
  const coreVersion = (await getInstalledVersion("@elizaos/core")) ?? "unknown";
  const pluginNames = Object.keys(PLUGIN_REQUIRED_CORE_EXPORTS);

  const results = await Promise.all(
    pluginNames.map((name) => validatePluginCompat(name, coreVersion)),
  );

  const failures = results.filter((r) => !r.compatible);
  const compatible = failures.length === 0;

  let advisory = "";
  if (!compatible) {
    const affectedNames = failures.map((f) => f.plugin).join(", ");
    const allMissing = [...new Set(failures.flatMap((f) => f.missingExports))];
    advisory =
      `Version skew detected: @elizaos/core@${coreVersion} is missing ` +
      `${allMissing.join(", ")} required by ${affectedNames}. ` +
      `Fix: pin affected plugins to versions compatible with core@${coreVersion}, ` +
      `or upgrade @elizaos/core to a version that exports these symbols.`;
  }

  return { compatible, results, failures, advisory };
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
  const loadedProviders = loadedPluginNames.filter((n) =>
    AI_PROVIDER_PLUGINS.includes(n),
  );

  // At least one AI provider loaded — no issue.
  if (loadedProviders.length > 0) return null;

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
      `See: https://github.com/milady-ai/milady/issues/10`
    );
  }

  // Generic failure.
  const details = failedProviders
    .map((f) => `  ${f.name}: ${f.error}`)
    .join("\n");
  return `All AI provider plugins failed to load:\n${details}`;
}
