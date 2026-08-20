/** Verifies release catalogs fail closed on missing, extra, stale, or mixed-deployment provider evidence. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDER_CANARY_SCENARIO_IDS } from "./canary-catalog.ts";
import { canonicalSha256 } from "./manifest.ts";
import * as qualificationArtifact from "./qualification-artifact.ts";
import {
  PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA,
  type ProviderQualificationArtifact,
  validateProviderQualificationArtifact,
} from "./qualification-artifact.ts";
import {
  assembleProviderQualificationCatalog,
  renderProviderQualificationCatalogMarkdown,
} from "./qualification-catalog.ts";

let reverifyArtifact: ReturnType<typeof vi.spyOn>;

const REPOSITORY_SHA = "a".repeat(40);
const DEPLOYMENT_SHA = "b".repeat(64);
const HASH = "c".repeat(64);

function artifact(
  scenarioId: string,
  deploymentSha = DEPLOYMENT_SHA,
): ProviderQualificationArtifact {
  const runnerResult = {
    scenarioStatus: "passed" as const,
    finalChecks: [],
    runnerResultSha256: HASH,
  };
  const core = {
    schema: PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA,
    createdAtIso: "2026-08-19T00:00:00.000Z",
    scenarioId,
    runId: `run-${scenarioId}`,
    repositorySha: REPOSITORY_SHA,
    deploymentSha,
    manifestSha256: HASH,
    trajectorySetSha256: HASH,
    runnerResultSha256: HASH,
    observerEvidenceSha256: HASH,
    semanticEvidenceSha256: HASH,
    decision: {
      manifestSha256: HASH,
      qualification: {
        status: "qualified" as const,
        publishable: true as const,
        reasons: [] as const,
      },
      matchedObservationContracts: [],
      guarantees: {
        providerAuthorizationVerified: true,
        providerFailurePathsVerified: true,
        providerAcceptanceVerified: true,
        providerReadbackVerified: true,
        providerIdempotencyVerified: true,
        exactlyOnce: false as const,
      },
    },
    reverification: {
      scenarioDefinition: {},
      manifest: { manifestSha256: HASH },
      manifestSignature: {},
      publicKeyPins: {
        manifestAuthorities: [{}],
        providerObservers: [{}],
        semanticJudges: [{}],
      },
      signedObserverEvidence: { payload: { runnerResultSha256: HASH } },
      signedSemanticJudgeEvidence: {},
      trajectoryInventory: { setSha256: HASH },
      runnerResult,
      verifierTranscript: {
        schema: "eliza.provider-qualification-verifier-transcript.v1",
        implementation: "@elizaos/scenario-runner/provider-qualification",
        verifiedAtIso: "2026-08-19T00:00:00.000Z",
        verificationOptions: {},
        sourcePrivacy: {},
        inventory: {},
        proofDigests: {},
      },
    },
    qualifiedReport: { scenarioId },
  };
  return {
    ...core,
    artifactSha256: canonicalSha256(core, "providerQualificationArtifact"),
  } as unknown as ProviderQualificationArtifact;
}

function canonicalArtifacts(): ProviderQualificationArtifact[] {
  return PROVIDER_CANARY_SCENARIO_IDS.map((scenarioId) => artifact(scenarioId));
}

describe("provider qualification catalog", () => {
  beforeEach(() => {
    reverifyArtifact = vi.spyOn(
      qualificationArtifact,
      "reverifyProviderQualificationArtifact",
    );
    reverifyArtifact.mockImplementation((value: unknown) => {
      return validateProviderQualificationArtifact(value).decision;
    });
  });

  afterEach(() => {
    reverifyArtifact.mockRestore();
  });

  it("renders the repository-owned 13-scenario catalog", () => {
    const catalog = assembleProviderQualificationCatalog({
      artifacts: canonicalArtifacts(),
      expectedRepositorySha: REPOSITORY_SHA,
      createdAtIso: "2026-08-19T00:01:00.000Z",
    });
    expect(catalog.artifacts.map((entry) => entry.scenarioId)).toEqual(
      PROVIDER_CANARY_SCENARIO_IDS,
    );
    expect(renderProviderQualificationCatalogMarkdown(catalog)).toContain(
      "All **13** provider canaries qualified",
    );
    expect(reverifyArtifact).toHaveBeenCalledTimes(13);
  });

  it("rejects missing, extra, reordered, and substituted inventory", () => {
    const canonical = canonicalArtifacts();
    expect(() =>
      assembleProviderQualificationCatalog({
        artifacts: canonical.slice(0, -1),
        expectedRepositorySha: REPOSITORY_SHA,
        createdAtIso: "2026-08-19T00:01:00.000Z",
      }),
    ).toThrow(/canonical 13-scenario inventory/);
    expect(() =>
      assembleProviderQualificationCatalog({
        artifacts: [...canonical, artifact("provider.extra")],
        expectedRepositorySha: REPOSITORY_SHA,
        createdAtIso: "2026-08-19T00:01:00.000Z",
      }),
    ).toThrow(/canonical 13-scenario inventory/);
    expect(() =>
      assembleProviderQualificationCatalog({
        artifacts: [canonical[1], canonical[0], ...canonical.slice(2)],
        expectedRepositorySha: REPOSITORY_SHA,
        createdAtIso: "2026-08-19T00:01:00.000Z",
      }),
    ).toThrow(/canonical 13-scenario inventory/);
    expect(() =>
      assembleProviderQualificationCatalog({
        artifacts: [artifact("provider.substitute"), ...canonical.slice(1)],
        expectedRepositorySha: REPOSITORY_SHA,
        createdAtIso: "2026-08-19T00:01:00.000Z",
      }),
    ).toThrow(/canonical 13-scenario inventory/);
  });

  it("rejects mixed deployments", () => {
    const mixed = canonicalArtifacts();
    mixed[1] = artifact(mixed[1]?.scenarioId ?? "", "d".repeat(64));
    expect(() =>
      assembleProviderQualificationCatalog({
        artifacts: mixed,
        expectedRepositorySha: REPOSITORY_SHA,
        createdAtIso: "2026-08-19T00:01:00.000Z",
      }),
    ).toThrow(/share one deployment SHA/);
  });

  it("rejects a modified artifact digest", () => {
    const artifacts = canonicalArtifacts();
    const forged = artifacts[0];
    if (!forged) throw new Error("canonical provider inventory is empty");
    forged.runId = "forged-run";
    expect(() =>
      assembleProviderQualificationCatalog({
        artifacts,
        expectedRepositorySha: REPOSITORY_SHA,
        createdAtIso: "2026-08-19T00:01:00.000Z",
      }),
    ).toThrow(/digest does not match/);
  });

  it("rejects a capsule whose observer signature fails offline reverification", () => {
    const artifacts = canonicalArtifacts();
    const tampered = artifacts[0];
    if (!tampered) throw new Error("canonical provider inventory is empty");
    tampered.reverification.signedObserverEvidence.signature = "tampered";
    const { artifactSha256: _digest, ...core } = tampered;
    tampered.artifactSha256 = canonicalSha256(
      core,
      "providerQualificationArtifact",
    );
    reverifyArtifact.mockImplementation((value: unknown) => {
      const candidate = validateProviderQualificationArtifact(value);
      if (
        candidate.reverification.signedObserverEvidence.signature === "tampered"
      ) {
        throw new Error(
          "provider qualification artifact decision does not reverify",
        );
      }
      return candidate.decision;
    });

    expect(() =>
      assembleProviderQualificationCatalog({
        artifacts,
        expectedRepositorySha: REPOSITORY_SHA,
        createdAtIso: "2026-08-19T00:01:00.000Z",
      }),
    ).toThrow(/decision does not reverify/);
  });

  it("rejects a recomputed artifact digest with a forged qualification decision", () => {
    const artifacts = canonicalArtifacts();
    const tampered = artifacts[0];
    if (!tampered) throw new Error("canonical provider inventory is empty");
    tampered.decision.guarantees.providerReadbackVerified = false;
    const { artifactSha256: _digest, ...core } = tampered;
    tampered.artifactSha256 = canonicalSha256(
      core,
      "providerQualificationArtifact",
    );
    reverifyArtifact.mockImplementation((value: unknown) => {
      const candidate = validateProviderQualificationArtifact(value);
      if (!candidate.decision.guarantees.providerReadbackVerified) {
        throw new Error(
          "provider qualification artifact decision does not reverify",
        );
      }
      return candidate.decision;
    });

    expect(() =>
      assembleProviderQualificationCatalog({
        artifacts,
        expectedRepositorySha: REPOSITORY_SHA,
        createdAtIso: "2026-08-19T00:01:00.000Z",
      }),
    ).toThrow(/decision does not reverify/);
  });
});
