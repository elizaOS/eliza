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
    process.env.ELIZA_DEVICE_BRIDGE_ENABLED?.trim() === "1" ||
    process.env.ELIZA_ALLOW_NO_PROVIDER?.trim() === "1"
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
