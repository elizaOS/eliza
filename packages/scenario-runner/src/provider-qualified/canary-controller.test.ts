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
import {
  createProviderQualificationManifest,
  type ProviderRunBindings,
  preflightProviderCanary,
} from "./index.ts";
import {
  PROVIDER_OPERATION_CONTRACT_BY_KIND,
  type ProviderOperationKind,
} from "./operation-binding.ts";

const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

type CanaryCase = {
  scenario: ScenarioDefinition;
  provider: string;
  connectorProvider: string;
  observerId: string;
  accountId: string;
  operation: string;
  operationKind: ProviderOperationKind;
};

const cases: CanaryCase[] = PROVIDER_CANARY_SCENARIOS.map((scenario) => {
  const check = scenario.finalChecks?.find(
    (candidate) => candidate.type === "providerEffectObserved",
  );
  if (
    check?.type !== "providerEffectObserved" ||
    typeof check.provider !== "string" ||
    typeof check.connectorProvider !== "string" ||
    typeof check.observerId !== "string" ||
    typeof check.accountId !== "string" ||
    typeof check.operation !== "string"
  ) {
    throw new Error(`${scenario.id} lacks its provider effect check`);
  }
  const operationKind = Object.entries(
    PROVIDER_OPERATION_CONTRACT_BY_KIND,
  ).find(
    ([, contract]) =>
      contract.provider === check.provider &&
      contract.connectorProvider === check.connectorProvider &&
      contract.operation === check.operation,
  )?.[0] as ProviderOperationKind | undefined;
  if (!operationKind) {
    throw new Error(`${scenario.id} has no canonical operation binding kind`);
  }
  return {
    scenario,
    provider: check.provider,
    connectorProvider: check.connectorProvider,
    observerId: check.observerId,
    accountId: check.accountId,
    operation: check.operation,
    operationKind,
  };
});

function bindings(testCase: CanaryCase): ProviderRunBindings {
  const accountRefSha256 = hash(testCase.accountId);
  const connectionRefSha256 = hash(
    `${testCase.connectorProvider}-canary-connection`,
  );
  const durableApprovals = (testCase.scenario.finalChecks ?? []).filter(
    (check) => check.type === "durableApprovalObserved",
  );
  const providerNoEffects = (testCase.scenario.finalChecks ?? []).filter(
    (check) => check.type === "providerNoEffectObserved",
  );
  const durableObserverIds = [
    ...new Set(durableApprovals.map((check) => String(check.observerId))),
  ].filter((observerId) => observerId !== testCase.observerId);
  const approvalConnectionRefSha256 = hash(
    `${testCase.provider}-approval-ledger-connection`,
  );
  const approvalAccountRefSha256 = hash(testCase.accountId);
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
        ...durableObserverIds.map((observerId) => ({
          observerId,
          keyId: hash(`${observerId}-key`),
        })),
      ],
    },
    target: {
      principalRefSha256: hash("operator-canary-principal"),
      roomRefSha256: hash(`${testCase.provider}-canary-room`),
      operation: {
        schema: "eliza.provider-operation-binding.v1",
        kind: testCase.operationKind,
        providerTargetRefSha256: hash(`${testCase.provider}-provider-target`),
        operationInputSha256: hash(`${testCase.provider}-operation-input`),
      },
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
        provider: testCase.connectorProvider,
        accountRefSha256,
        connectionRefSha256,
        environment: "operator-canary",
      },
      ...(durableApprovals.length === 0
        ? []
        : [
            {
              provider: "approval-ledger",
              accountRefSha256: approvalAccountRefSha256,
              connectionRefSha256: approvalConnectionRefSha256,
              environment: "operator-canary",
            },
          ]),
    ],
    ingress: {
      kind: "provider-api",
      provider: testCase.connectorProvider,
      channel: `${testCase.provider}-canary`,
      accountRefSha256,
      connectionRefSha256,
      authenticatedPrincipalRefSha256: hash("operator-canary-principal"),
      roomRefSha256: hash(`${testCase.provider}-canary-room`),
      endpointOriginSha256: hash(`${testCase.provider}-canary-ingress`),
    },
    capabilities: [
      {
        provider: testCase.connectorProvider,
        accountRefSha256,
        connectionRefSha256,
        capability: testCase.operation,
        authorizationGrantSha256: hash(`${testCase.provider}-canary-grant`),
      },
      ...providerNoEffects.flatMap(() =>
        ["booking-order-create", "payment-create"].map((capability) => ({
          provider: testCase.connectorProvider,
          accountRefSha256,
          connectionRefSha256,
          capability,
          authorizationGrantSha256: hash(
            `${testCase.provider}-${capability}-read-grant`,
          ),
        })),
      ),
      ...(durableApprovals.length === 0
        ? []
        : [
            {
              provider: "approval-ledger",
              accountRefSha256: approvalAccountRefSha256,
              connectionRefSha256: approvalConnectionRefSha256,
              capability: "book_travel",
              authorizationGrantSha256: hash(
                `${testCase.provider}-approval-ledger-read-grant`,
              ),
            },
          ]),
    ],
    observationContracts: [
      {
        contractId: `${testCase.provider}-canary-${testCase.operation}`,
        kind: "provider-effect",
        observerId: testCase.observerId,
        sourceKind: "provider-api",
        system: testCase.provider,
        environment: "operator-canary",
        connectorProvider: testCase.connectorProvider,
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
      ...durableApprovals.map((check) => ({
        contractId: String(check.name),
        kind: "durable-approval" as const,
        observerId: String(check.observerId),
        sourceKind: "durable-database" as const,
        system: String(check.provider),
        environment: "operator-canary",
        connectorProvider: "approval-ledger",
        accountRefSha256: approvalAccountRefSha256,
        connectionRefSha256: approvalConnectionRefSha256,
        requiredCount: check.minCount ?? 1,
        maxObservationAgeMs: 60_000,
        operation: String(check.operation),
        state: String(check.state),
        transitionGroupId: check.transitionGroupId,
        transitionIndex: check.transitionIndex,
        trajectoryPhase: check.trajectoryPhase,
      })),
      ...providerNoEffects.map((check) => ({
        contractId: String(check.name),
        kind: "provider-no-effect" as const,
        observerId: String(check.observerId),
        sourceKind: "provider-api" as const,
        system: String(check.provider),
        environment: "operator-canary",
        connectorProvider: String(check.connectorProvider),
        accountRefSha256,
        connectionRefSha256,
        requiredCount: check.minCount ?? 1,
        maxObservationAgeMs: 60_000,
        provider: String(check.provider),
        effectKinds: ["booking-order-create", "payment-create"] as const,
        scopeSha256: hash(`${testCase.provider}-preapproval-effects`),
        intervalCoverage: "before-referenced-stage" as const,
        trajectoryPhase: "approval" as const,
      })),
    ],
    failureProbes: [
      {
        probeId: `${testCase.provider}-authorization-denied`,
        observerId: testCase.observerId,
        sourceKind: "provider-api",
        system: testCase.provider,
        environment: "operator-canary",
        provider: testCase.provider,
        connectorProvider: testCase.connectorProvider,
        accountRefSha256,
        connectionRefSha256,
        operation: testCase.operation,
        failureClass: "authorization-denied",
        requestPayloadSha256: hash(`${testCase.provider}-denied-request`),
        expectedStatusCode: 403,
        expectedErrorCodeSha256: hash(`${testCase.provider}-denied-error`),
        scopeSha256: hash(`${testCase.provider}-failure-scope`),
        authorizationGrantSha256: hash(`${testCase.provider}-denied-grant`),
        maxObservationAgeMs: 60_000,
      },
      {
        probeId: `${testCase.provider}-provider-rejected`,
        observerId: testCase.observerId,
        sourceKind: "provider-api",
        system: testCase.provider,
        environment: "operator-canary",
        provider: testCase.provider,
        connectorProvider: testCase.connectorProvider,
        accountRefSha256,
        connectionRefSha256,
        operation: testCase.operation,
        failureClass: "provider-rejected",
        requestPayloadSha256: hash(`${testCase.provider}-rejected-request`),
        expectedStatusCode: 400,
        expectedErrorCodeSha256: hash(`${testCase.provider}-rejected-error`),
        scopeSha256: hash(`${testCase.provider}-failure-scope`),
        authorizationGrantSha256: hash(`${testCase.provider}-canary-grant`),
        maxObservationAgeMs: 60_000,
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
