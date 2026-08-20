/**
 * Combines individually verified provider artifacts into one release catalog.
 * It enforces exact scenario inventory and a single repository/deployment
 * revision before producing a publication summary.
 */

import { PROVIDER_CANARY_SCENARIO_IDS } from "./canary-catalog.ts";
import { canonicalJsonValue, canonicalSha256 } from "./manifest.ts";
import { validateProviderQualificationArtifact } from "./qualification-artifact.ts";

export const PROVIDER_QUALIFICATION_CATALOG_SCHEMA =
  "eliza.provider-qualification-catalog.v1" as const;

export interface ProviderQualificationCatalog {
  schema: typeof PROVIDER_QUALIFICATION_CATALOG_SCHEMA;
  catalogSha256: string;
  createdAtIso: string;
  repositorySha: string;
  deploymentSha: string;
  scenarioCount: number;
  artifacts: readonly {
    scenarioId: string;
    runId: string;
    artifactSha256: string;
    manifestSha256: string;
    trajectorySetSha256: string;
  }[];
}

export function assembleProviderQualificationCatalog(input: {
  artifacts: readonly unknown[];
  expectedRepositorySha: string;
  createdAtIso: string;
}): ProviderQualificationCatalog {
  const expected = PROVIDER_CANARY_SCENARIO_IDS;
  const artifacts = input.artifacts.map(validateProviderQualificationArtifact);
  const actual = artifacts.map((artifact) => artifact.scenarioId);
  if (actual.join("\n") !== expected.join("\n")) {
    throw new Error(
      `provider qualification catalog must contain the canonical ${expected.length}-scenario inventory in repository order (expected=${expected.join(",")}; actual=${actual.join(",")})`,
    );
  }
  if (
    artifacts.some(
      (artifact) =>
        !artifact.decision.qualification.publishable ||
        !artifact.qualifiedReport ||
        artifact.repositorySha !== input.expectedRepositorySha,
    )
  ) {
    throw new Error(
      "every catalog artifact must be publishable and bound to the expected repository SHA",
    );
  }
  const deploymentShas = new Set(
    artifacts.map((artifact) => artifact.deploymentSha),
  );
  if (deploymentShas.size !== 1) {
    throw new Error("provider catalog artifacts must share one deployment SHA");
  }
  const core = {
    schema: PROVIDER_QUALIFICATION_CATALOG_SCHEMA,
    createdAtIso: input.createdAtIso,
    repositorySha: input.expectedRepositorySha,
    deploymentSha: artifacts[0]?.deploymentSha ?? "",
    scenarioCount: artifacts.length,
    artifacts: artifacts.map((artifact) => ({
      scenarioId: artifact.scenarioId,
      runId: artifact.runId,
      artifactSha256: artifact.artifactSha256,
      manifestSha256: artifact.manifestSha256,
      trajectorySetSha256: artifact.trajectorySetSha256,
    })),
  };
  return canonicalJsonValue(
    { ...core, catalogSha256: canonicalSha256(core, "catalog") },
    "providerQualificationCatalog",
  ) as unknown as ProviderQualificationCatalog;
}

export function renderProviderQualificationCatalogMarkdown(
  catalog: ProviderQualificationCatalog,
): string {
  return [
    "## Provider qualification catalog",
    "",
    `All **${catalog.scenarioCount}** provider canaries qualified against repository \`${catalog.repositorySha}\` and deployment \`${catalog.deploymentSha}\`.`,
    "",
    "| Scenario | Run | Artifact SHA-256 |",
    "| --- | --- | --- |",
    ...catalog.artifacts.map(
      (artifact) =>
        `| \`${artifact.scenarioId}\` | \`${artifact.runId}\` | \`${artifact.artifactSha256}\` |`,
    ),
    "",
    `Catalog SHA-256: \`${catalog.catalogSha256}\``,
    "",
  ].join("\n");
}
