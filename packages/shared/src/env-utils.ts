/**
 * Shared environment variable utilities.
 *
 * `isTruthyEnvValue` mirrors the canonical implementation in `@elizaos/core`
 * (`packages/core/src/env-utils.ts`, truthy set `1/true/yes/y/on/enabled`).
 *
 * #18056: keep a local copy here instead of re-exporting from bare
 * `@elizaos/core` (Vite aliases that to the prebuilt ~2.4 MB browser blob) or
 * from `@elizaos/core/client-public` (that subpath is not resolvable when this
 * module is loaded from `packages/app/vite.config.ts` at config-evaluation
 * time). Shared consumers still import from `@elizaos/shared` / this module.
 */
const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "y", "on", "enabled"]);

export function isTruthyEnvValue(value: string | undefined | null): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return TRUTHY_ENV_VALUES.has(normalized);
}
