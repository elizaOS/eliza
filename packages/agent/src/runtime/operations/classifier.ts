/**
 * Reload-tier classifier.
 *
 * Pure function. Given an OperationIntent and a small ClassifyContext snapshot
 * of the current runtime config, returns the cheapest reload tier that can
 * apply the change correctly.
 *
 * Decision rules (FIRST match wins; conservative upgrade when uncertain):
 *
 *   1. restart                                 → cold (explicit user intent)
 *   2. plugin-enable / plugin-disable          → cold (loaded plugin set changes)
 *   3. provider-switch:
 *        a. same provider, key only            → hot
 *        b. same provider, primaryModel only   → hot
 *        c. same provider, both                → hot (still same plugin family)
 *        d. different provider, same family    → warm
 *        e. otherwise (cross-family / first-time provider with no current)
 *                                              → cold
 *   4. config-reload:
 *        - all changedPaths under env./vars./models. → hot
 *        - otherwise                            → cold
 */

import { getOnboardingProviderFamily } from "@elizaos/shared";
import type { OperationIntent, ReloadTier } from "./types.js";

export interface ClassifyContext {
  currentProvider?: string;
  currentApiKey?: string;
  currentPrimaryModel?: string;
}

const HOT_CONFIG_PATH_PREFIXES = ["env.", "vars.", "models."] as const;

function allPathsAreHotEligible(paths: readonly string[]): boolean {
  if (paths.length === 0) return false;
  return paths.every((path) =>
    HOT_CONFIG_PATH_PREFIXES.some((prefix) => path.startsWith(prefix)),
  );
}

function classifyProviderSwitch(
  intent: Extract<OperationIntent, { kind: "provider-switch" }>,
  ctx: ClassifyContext,
): ReloadTier {
  const target = intent.provider;
  const current = ctx.currentProvider;

  if (!current) {
    // First-time provider setup with no current provider — cold.
    return "cold";
  }

  if (current === target) {
    // Same provider; key/model swaps stay in the same plugin family.
    return "hot";
  }

  const targetFamily = getOnboardingProviderFamily(target);
  const currentFamily = getOnboardingProviderFamily(current);
  if (targetFamily && currentFamily && targetFamily === currentFamily) {
    // Same plugin family (e.g. openai ↔ openai-subscription) — warm.
    return "warm";
  }

  return "cold";
}

export function classifyOperation(
  intent: OperationIntent,
  ctx: ClassifyContext,
): ReloadTier {
  switch (intent.kind) {
    case "restart":
      return "cold";
    case "plugin-enable":
    case "plugin-disable":
      return "cold";
    case "provider-switch":
      return classifyProviderSwitch(intent, ctx);
    case "config-reload": {
      const paths = intent.changedPaths;
      if (paths && allPathsAreHotEligible(paths)) {
        return "hot";
      }
      return "cold";
    }
  }
}

/**
 * Default classifier reference suitable for injection into the operations
 * manager. Identical to calling `classifyOperation` directly; provided so
 * the manager's wiring stays symmetric with the strategies.
 */
export const defaultClassifier: (
  intent: OperationIntent,
  ctx: ClassifyContext,
) => ReloadTier = (intent, ctx) => classifyOperation(intent, ctx);
