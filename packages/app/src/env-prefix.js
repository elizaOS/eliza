/**
 * Normalizes an app's configured env-var prefix into a canonical uppercase
 * identifier: collapses each run of non-alphanumeric characters to a single `_`,
 * strips leading/trailing underscores, and uppercases the result; throws when
 * the value reduces to an empty identifier. Authored as plain JS (with an
 * `env-prefix.d.ts` sidecar) so the same rule can be shared by the Vite/build
 * config, the build script, and the runtime brand-env code.
 */
export function normalizeEnvPrefix(value) {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  if (!normalized) {
    throw new Error("App envPrefix must resolve to a non-empty identifier");
  }
  return normalized;
}
