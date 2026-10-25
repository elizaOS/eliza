/**
 * Default-pack of `FeatureFlagContribution`s for the closed
 * `LifeOpsFeatureKey` built-ins.
 *
 * Source of truth for the built-in shape stays at `BASE_FEATURE_DEFAULTS`
 * in `feature-flags.types.ts` (it carries the compile-time defaults that
 * `resolveFeatureDefaults` uses for Cloud-aware policy). This pack mirrors
 * those keys into the `FeatureFlagRegistry` so the registry is the single
 * runtime source of truth for "what feature flags exist", while the closed
 * union keeps its compile-time guarantees for typed callers like
 * `requireFeatureEnabled(runtime, "travel.book_flight")`.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  ALL_FEATURE_KEYS,
  BASE_FEATURE_DEFAULTS,
  type LifeOpsFeatureKey,
} from "../feature-flags.types.js";
import {
  createFeatureFlagRegistry,
  type FeatureFlagContribution,
  type FeatureFlagRegistry,
  registerFeatureFlagRegistry,
} from "./feature-flag-registry.js";

/**
 * Set of compile-time built-in keys. Passed to the registry factory so
 * `registry.isBuiltin(key)` answers without re-importing the closed union.
 */
export const LIFEOPS_BUILTIN_FEATURE_KEYS: ReadonlySet<LifeOpsFeatureKey> =
  new Set<LifeOpsFeatureKey>(ALL_FEATURE_KEYS);

/**
 * Default contributions: one per `LifeOpsFeatureKey` built-in, mirroring
 * the compile-time `BASE_FEATURE_DEFAULTS` baseline (Cloud-link policy is
 * applied separately by `resolveFeatureDefaults`).
 */
export const DEFAULT_FEATURE_FLAG_PACK: readonly FeatureFlagContribution[] =
  ALL_FEATURE_KEYS.map((key) => {
    const def = BASE_FEATURE_DEFAULTS[key];
    return {
      key,
      label: def.label,
      description: def.description,
      defaultEnabled: def.enabled,
      namespace: "core",
      metadata: { costsMoney: def.costsMoney ? "true" : "false" },
    } satisfies FeatureFlagContribution;
  });

/**
 * Create a registry, register every built-in `LifeOpsFeatureKey`, and bind
 * it to the runtime. Plugin `init` calls this once during bootstrap.
 */
export function registerDefaultFeatureFlagPack(
  runtime: IAgentRuntime,
): FeatureFlagRegistry {
  const registry = createFeatureFlagRegistry({
    builtinKeys: LIFEOPS_BUILTIN_FEATURE_KEYS,
  });
  for (const contribution of DEFAULT_FEATURE_FLAG_PACK) {
    registry.register(contribution);
  }
  registerFeatureFlagRegistry(runtime, registry);
  return registry;
}
