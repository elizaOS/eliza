/**
 * Provides the fail-closed controller boundary for provider canaries. It only
 * accepts a canonical operator manifest bound to the exact authored scenario;
 * execution and qualification remain external signed-evidence operations.
 */

import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import {
  type ProviderQualificationManifest,
  validateProviderQualificationManifestForScenario,
} from "./manifest.ts";

export interface ProviderCanaryPreflight {
  status: "operator-manifest-validated";
  scenarioId: string;
  manifest: ProviderQualificationManifest;
}

/**
 * Validate the externally authored run manifest before any canary ingress.
 * Missing input is an explicit refusal: this boundary never substitutes local
 * fixtures, simulated connectors, or runner-authored qualification evidence.
 */
export function preflightProviderCanary(
  scenario: ScenarioDefinition,
  operatorManifest: unknown,
): ProviderCanaryPreflight {
  if (operatorManifest === undefined || operatorManifest === null) {
    throw new Error(
      `provider canary ${scenario.id} requires an operator manifest; refusing simulated or self-qualified execution`,
    );
  }

  return {
    status: "operator-manifest-validated",
    scenarioId: scenario.id,
    manifest: validateProviderQualificationManifestForScenario(
      operatorManifest,
      scenario,
    ),
  };
}
