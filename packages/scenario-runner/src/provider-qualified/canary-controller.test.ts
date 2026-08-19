/**
 * Validates every cataloged provider canary using deterministic trust metadata,
 * not provider mocks or fabricated execution evidence.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import { PROVIDER_CANARY_SCENARIOS } from "../../../test/scenarios/provider-qualified/_provider-canary-catalog.ts";
import { providerQualifiedScenarioProblems } from "../executor.ts";
import { preflightProviderCanary } from "./canary-controller.ts";
import {
  createProviderQualificationManifest,
  type ProviderRunBindings,
} from "./manifest.ts";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

type CanaryCase = {
  scenario: ScenarioDefinition;
  provider: string;
  observerId: string;
  accountId: string;
  operation: string;
};

const cases: CanaryCase[] = PROVIDER_CANARY_SCENARIOS.map((scenario) => {
  const check = scenario.finalChecks?.find(
    (candidate) => candidate.type === "providerEffectObserved",
  );
  if (check?.type !== "providerEffectObserved") {
    throw new Error(`${scenario.id} lacks its provider effect check`);
  }
  return {
    scenario,
    provider: check.provider,
    observerId: check.observerId,
    accountId: check.accountId,
    operation: check.operation,
  };
});

function bindings(testCase: CanaryCase): ProviderRunBindings {
  const accountRefSha256 = hash(testCase.accountId);
  const connectionRefSha256 = hash(`${testCase.provider}-canary-connection`);
  return {
    runId: `run-${testCase.provider}-canary`,
    runNonce: "a".repeat(64),
    repositorySha: "b".repeat(40),
    deploymentSha: "c".repeat(64),
    trust: {
      manifestAuthorityKeyId: hash("operator-manifest-authority"),
      observerSigners: [
        {
          observerId: testCase.observerId,
          keyId: hash(`${testCase.provider}-observer-key`),
        },
      ],
    },
    target: {
      principalRefSha256: hash("operator-canary-principal"),
      roomRefSha256: hash(`${testCase.provider}-canary-room`),
    },
    models: {
      actingAdapter: "eliza-runtime",
      actingProvider: "operator-live-model-provider",
      actingModel: "operator-live-model",
      judgeProvider: "independent-live-judge-provider",
      judgeModel: "independent-live-judge",
      judgeKeyId: hash("independent-live-judge-key"),
    },
    connectors: [
      {
        provider: testCase.provider,
        accountRefSha256,
        connectionRefSha256,
        environment: "operator-canary",
      },
    ],
    ingress: {
      kind: "provider-api",
      provider: testCase.provider,
      channel: `${testCase.provider}-canary`,
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: hash("operator-canary-principal"),
      roomRefSha256: hash(`${testCase.provider}-canary-room`),
      endpointOriginSha256: hash(`${testCase.provider}-canary-ingress`),
    },
    capabilities: [
      {
        provider: testCase.provider,
        accountRefSha256,
        connectionRefSha256,
        capability: testCase.operation,
        authorizationGrantSha256: hash(`${testCase.provider}-canary-grant`),
      },
    ],
    observationContracts: [
      {
        contractId: `${testCase.provider}-canary-${testCase.operation}`,
        kind: "provider-effect",
        observerId: testCase.observerId,
        sourceKind: "provider-api",
        system: testCase.provider,
        environment: "operator-canary",
        connectorProvider: testCase.provider,
        accountRefSha256,
        connectionRefSha256,
        requiredCount: 1,
        maxObservationAgeMs: 60_000,
        provider: testCase.provider,
        operation: testCase.operation,
        providerAcceptanceRequired: true,
        readbackRequired: true,
        idempotencyRequired: true,
      },
    ],
  };
}

describe("preflightProviderCanary", () => {
  it("records source-evidenced exclusions for non-qualifiable surfaces", () => {
    const repoRoot = resolve(import.meta.dirname, "../../../../");
    const exclusions = JSON.parse(
      readFileSync(
        resolve(
          repoRoot,
          "packages/test/scenarios/provider-qualified/_provider-canary-exclusions.json",
        ),
        "utf8",
      ),
    ) as {
      exclusions: Record<string, { reason: string; sourceEvidence: string }>;
    };
    expect(Object.keys(exclusions.exclusions).sort()).toEqual([
      "browser-portal-upload",
      "calendly",
      "native-notifications",
    ]);
    for (const exclusion of Object.values(exclusions.exclusions)) {
      expect(exclusion.reason.length).toBeGreaterThan(20);
      expect(existsSync(resolve(repoRoot, exclusion.sourceEvidence))).toBe(
        true,
      );
    }
  });

  it.each(cases)(
    "declares loadable production plugins for $provider",
    (testCase) => {
      expect(
        providerQualifiedScenarioProblems(
          testCase.scenario as ScenarioDefinition,
        ),
      ).toEqual([]);
    },
  );

  it.each(cases)(
    "accepts an exact operator manifest for $provider",
    (testCase) => {
      const scenario = testCase.scenario as ScenarioDefinition;
      const manifest = createProviderQualificationManifest({
        scenario,
        bindings: bindings(testCase),
      });

      expect(preflightProviderCanary(scenario, manifest)).toEqual({
        status: "operator-manifest-validated",
        scenarioId: scenario.id,
        manifest,
      });
      expect(manifest.connectors[0]?.accountRefSha256).toBe(
        hash(testCase.accountId),
      );
      expect(JSON.stringify(manifest)).not.toContain(testCase.accountId);
    },
  );

  it("refuses to run without an operator manifest", () => {
    expect(() => preflightProviderCanary(cases[0].scenario, undefined)).toThrow(
      /requires an operator manifest; refusing simulated or self-qualified execution/,
    );
  });

  it("rejects a manifest bound to a different provider canary", () => {
    const otherManifest = createProviderQualificationManifest({
      scenario: cases[1].scenario,
      bindings: bindings(cases[1]),
    });
    expect(() =>
      preflightProviderCanary(cases[0].scenario, otherManifest),
    ).toThrow(
      /has no authored trusted final check|does not exactly match|scenario\.id/,
    );
  });
});
