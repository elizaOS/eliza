/**
 * Verifies the qualification artifact boundary rejects mismatched runner data
 * and renders only publication-safe hashes and decision state.
 */

import { generateKeyPairSync } from "node:crypto";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import type { ScenarioReport } from "../types.ts";
import {
  assembleProviderQualificationArtifact,
  normalizeProviderQualificationPublicKeyPins,
  PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA,
  type ProviderQualificationArtifact,
} from "./qualification-artifact.ts";
import {
  PROVIDER_QUALIFICATION_VERIFY_CONFIG_SCHEMA,
  parseProviderQualificationVerifyConfig,
  renderProviderQualificationMarkdown,
} from "./qualification-cli.ts";

const HASH = "a".repeat(64);

function verifyConfig(): Record<string, unknown> {
  return {
    schema: PROVIDER_QUALIFICATION_VERIFY_CONFIG_SCHEMA,
    scenarioFile: "scenario.ts",
    authorizationFile: "authorization.json",
    operationKind: "gmail.email-send",
    providerTargetFile: "provider-target.json",
    operationInputFile: "operation-input.json",
    failureProbesFile: "failure-probes.json",
    manifestAuthorityPublicKeyFiles: ["authority.pem"],
    runDir: "run",
    observerEvidenceFile: "observer.json",
    observerPublicKeyFiles: ["observer.pem"],
    semanticEvidenceFile: "judge.json",
    semanticJudgePublicKeyFiles: ["judge.pem"],
    runnerReportFile: "report.json",
    outputDir: "verified",
  };
}

describe("provider qualification artifact", () => {
  it("rejects a runner report bound to another scenario before qualification", () => {
    const scenario = {
      id: "provider.test.canary",
      title: "Provider test canary",
      domain: "provider-canary",
      lane: "live-only",
      executionProfile: "provider-qualified",
      evidenceScope: "provider-certification",
      isolation: "per-scenario",
      turns: [{ name: "ingress", kind: "message", text: "Send canary." }],
    } satisfies ScenarioDefinition;
    const report = {
      id: "provider.attacker.canary",
      title: scenario.title,
      domain: scenario.domain,
      tags: [],
      status: "passed",
      durationMs: 1,
      turns: [],
      finalChecks: [],
      actionsCalled: [],
      failedAssertions: [],
      providerName: "live",
      executionProfile: "provider-qualified",
      evidence: {
        schemaVersion: 1,
        executionProfile: "provider-qualified",
        qualification: {
          status: "unqualified",
          publishable: false,
          reasons: ["external-controller-decision:missing"],
        },
        observerProvenance: [],
        trajectoryHashes: [],
        observations: [],
      },
    } satisfies ScenarioReport;
    expect(() =>
      assembleProviderQualificationArtifact({
        scenarioDefinition: scenario,
        manifest: { scenario: { id: scenario.id } } as never,
        manifestSignature: {} as never,
        pinnedManifestAuthorityPublicKeysPem: ["unused"],
        trajectories: {} as never,
        signedEvidence: {} as never,
        pinnedObserverPublicKeysPem: ["unused"],
        signedSemanticEvidence: {} as never,
        pinnedSemanticJudgePublicKeysPem: ["unused"],
        runnerReport: report,
        nowIso: "2026-08-19T00:00:00.000Z",
      }),
    ).toThrow(/runner, manifest, and authored scenario IDs must match/);
  });

  it("parses a closed verifier config and rejects unknown controls", () => {
    expect(parseProviderQualificationVerifyConfig(verifyConfig())).toEqual(
      verifyConfig(),
    );
    expect(() =>
      parseProviderQualificationVerifyConfig({
        ...verifyConfig(),
        skipSignatureVerification: true,
      }),
    ).toThrow(/unknown=skipSignatureVerification/);
  });

  it("retains only public SPKI pins", () => {
    const pair = generateKeyPairSync("ed25519");
    const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });
    const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
    expect(
      normalizeProviderQualificationPublicKeyPins([publicPem], "pins"),
    ).toMatchObject([{ algorithm: "ed25519", spkiPem: publicPem }]);
    expect(() =>
      normalizeProviderQualificationPublicKeyPins([privatePem], "pins"),
    ).toThrow(/public SPKI PEM/);
  });

  it("renders hashes and guarantees without embedding signed evidence", () => {
    const artifact = {
      schema: PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA,
      artifactSha256: HASH,
      createdAtIso: "2026-08-19T00:00:00.000Z",
      scenarioId: "provider.test.canary",
      runId: "run-1",
      repositorySha: "b".repeat(40),
      deploymentSha: HASH,
      manifestSha256: HASH,
      trajectorySetSha256: HASH,
      runnerResultSha256: HASH,
      observerEvidenceSha256: HASH,
      semanticEvidenceSha256: HASH,
      decision: {
        manifestSha256: HASH,
        qualification: {
          status: "qualified",
          publishable: true,
          reasons: [],
        },
        matchedObservationContracts: [
          { observationId: "private-observation", contractId: "contract-1" },
        ],
        guarantees: {
          providerAuthorizationVerified: true,
          providerFailurePathsVerified: true,
          providerAcceptanceVerified: true,
          providerReadbackVerified: true,
          providerIdempotencyVerified: true,
          exactlyOnce: false,
        },
      },
      reverification: {
        publicKeyPins: {
          manifestAuthorities: [{ keyId: HASH }],
          providerObservers: [{ keyId: HASH }],
          semanticJudges: [{ keyId: HASH }],
        },
        verifierTranscript: {
          inventory: { trajectoryCount: 1, trajectoryStageCount: 2 },
          proofDigests: {
            failurePathObservationsSha256: HASH,
            readbackReplayAssurancesSha256: HASH,
          },
        },
      },
    } as unknown as ProviderQualificationArtifact;
    const markdown = renderProviderQualificationMarkdown(artifact);
    expect(markdown).toContain("**QUALIFIED**");
    expect(markdown).toContain("Provider authorization verified: **yes**");
    expect(markdown).toContain("Provider failure paths verified: **yes**");
    expect(markdown).toContain("Idempotent replay verified: **yes**");
    expect(markdown).toContain("Verified trajectory artifacts: **1**");
    expect(markdown).toContain("public-key/hash-only capsule");
    expect(markdown).not.toContain("private-observation");
  });
});
