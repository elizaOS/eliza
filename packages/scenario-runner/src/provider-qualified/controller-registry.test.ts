/**
 * Proves the data-only provider controller registry covers the canonical
 * release inventory exactly and cannot be redirected to another operation or
 * controller family by operator input.
 */

import { describe, expect, it } from "vitest";
import { PROVIDER_CANARY_SCENARIO_IDS } from "./canary-catalog.ts";
import {
  PROVIDER_CANARY_CONTROLLER_CONTRACTS,
  PROVIDER_CONTROLLER_FAMILIES,
  providerCanaryControllerContract,
} from "./controller-registry.ts";
import { PROVIDER_OPERATION_KINDS } from "./operation-binding.ts";

describe("provider controller registry", () => {
  it("covers the canonical 13 canaries exactly once", () => {
    expect(Object.keys(PROVIDER_CANARY_CONTROLLER_CONTRACTS)).toEqual(
      PROVIDER_CANARY_SCENARIO_IDS,
    );
    expect(
      Object.values(PROVIDER_CANARY_CONTROLLER_CONTRACTS).map(
        (entry) => entry.scenarioId,
      ),
    ).toEqual(PROVIDER_CANARY_SCENARIO_IDS);
    expect(
      new Set(
        Object.values(PROVIDER_CANARY_CONTROLLER_CONTRACTS).map(
          (entry) => entry.operationKind,
        ),
      ),
    ).toEqual(new Set(PROVIDER_OPERATION_KINDS));
  });

  it("routes every contract to a closed controller family", () => {
    for (const entry of Object.values(PROVIDER_CANARY_CONTROLLER_CONTRACTS)) {
      expect(PROVIDER_CONTROLLER_FAMILIES).toContain(entry.controllerFamily);
      expect(entry).toMatchObject({
        requiresDeployedIngress: true,
        requiresVerifiedTrajectories: true,
        requiresIndependentObserver: true,
        requiresIndependentSemanticJudge: true,
        requiresReplayProof: true,
        requiresFailureProbeProof: true,
        requiresCleanupProof: true,
      });
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it("rejects an operator-supplied non-canonical scenario ID", () => {
    expect(() =>
      providerCanaryControllerContract("provider.fake.send"),
    ).toThrow(/rejects non-canonical scenario/);
  });
});
