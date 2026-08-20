/** Verifies release catalogs fail closed on missing, extra, stale, or mixed-deployment provider evidence. */

import { describe, expect, it } from "vitest";
import { canonicalSha256 } from "./manifest.ts";
import {
  PROVIDER_QUALIFICATION_ARTIFACT_SCHEMA,
  type ProviderQualificationArtifact,
} from "./qualification-artifact.ts";
import {
  assembleProviderQualificationCatalog,
  renderProviderQualificationCatalogMarkdown,
} from "./qualification-catalog.ts";

const REPOSITORY_SHA = "a".repeat(40);
const DEPLOYMENT_SHA = "b".repeat(64);
const HASH = "c".repeat(64);

function artifact(
  scenarioId: string,
  deploymentSha = DEPLOYMENT_SHA,
): ProviderQualificationArtifact {
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
    qualifiedReport: { id: scenarioId },
  };
  return {
    ...core,
    artifactSha256: canonicalSha256(core, "providerQualificationArtifact"),
  } as unknown as ProviderQualificationArtifact;
}

describe("provider qualification catalog", () => {
  it("renders an exact single-revision catalog", () => {
    const catalog = assembleProviderQualificationCatalog({
      artifacts: [artifact("provider.two"), artifact("provider.one")],
      expectedScenarioIds: ["provider.one", "provider.two"],
      expectedRepositorySha: REPOSITORY_SHA,
      createdAtIso: "2026-08-19T00:01:00.000Z",
    });
    expect(catalog.artifacts.map((entry) => entry.scenarioId)).toEqual([
      "provider.one",
      "provider.two",
    ]);
    expect(renderProviderQualificationCatalogMarkdown(catalog)).toContain(
      "All **2** provider canaries qualified",
    );
  });

  it("rejects missing inventory and mixed deployments", () => {
    expect(() =>
      assembleProviderQualificationCatalog({
        artifacts: [artifact("provider.one")],
        expectedScenarioIds: ["provider.one", "provider.two"],
        expectedRepositorySha: REPOSITORY_SHA,
        createdAtIso: "2026-08-19T00:01:00.000Z",
      }),
    ).toThrow(/inventory mismatch/);
    expect(() =>
      assembleProviderQualificationCatalog({
        artifacts: [
          artifact("provider.one"),
          artifact("provider.two", "d".repeat(64)),
        ],
        expectedScenarioIds: ["provider.one", "provider.two"],
        expectedRepositorySha: REPOSITORY_SHA,
        createdAtIso: "2026-08-19T00:01:00.000Z",
      }),
    ).toThrow(/share one deployment SHA/);
  });

  it("rejects a modified artifact digest", () => {
    const forged = artifact("provider.one");
    forged.runId = "forged-run";
    expect(() =>
      assembleProviderQualificationCatalog({
        artifacts: [forged],
        expectedScenarioIds: ["provider.one"],
        expectedRepositorySha: REPOSITORY_SHA,
        createdAtIso: "2026-08-19T00:01:00.000Z",
      }),
    ).toThrow(/digest does not match/);
  });
});
