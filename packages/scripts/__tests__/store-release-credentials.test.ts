/**
 * Guards the store-release credential contract against the shipped workflows
 * and exercises the readiness evaluation the preflight CLI reports. The
 * workflow assertions read the real `.github/workflows` sources; the readiness
 * assertions use deterministic inventories instead of the live GitHub API,
 * which no test may depend on.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  auditWorkflowCoverage,
  evaluateEnvironmentReadiness,
  extractWorkflowReferences,
  NON_CREDENTIAL_VARIABLES,
  RELEASE_ENVIRONMENT,
  requiredSecretNames,
  requiredVariableNames,
  STORE_LANES,
} from "../lib/store-release-credentials.mjs";

const repoRoot = new URL("../../../", import.meta.url);

function readWorkflow(path: string): string {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

const workflowSources = Object.fromEntries(
  [...new Set(STORE_LANES.map((lane) => lane.workflow))].map((path) => [
    path,
    readWorkflow(path),
  ]),
);

describe("store release credential contract", () => {
  test("covers every store lane the canonical release publishes", () => {
    expect(STORE_LANES.map((lane) => lane.id).sort()).toEqual([
      "apple",
      "google-play",
      "microsoft",
      "snap",
    ]);
  });

  test("names the protected environment the workflows actually deploy to", () => {
    expect(RELEASE_ENVIRONMENT).toBe("production-release");
    for (const source of Object.values(workflowSources)) {
      expect(source).toContain(`name: ${RELEASE_ENVIRONMENT}`);
    }
  });

  test("matches the secret and variable names the workflows reference", () => {
    const coverage = auditWorkflowCoverage(workflowSources);
    expect(coverage.missingInWorkflows).toEqual([]);
    expect(coverage.missingInContract).toEqual([]);
    expect(coverage.ok).toBe(true);
  });

  test("defines ownership, rotation, revocation, and prerequisite for each lane", () => {
    for (const lane of STORE_LANES) {
      expect(lane.owner.length).toBeGreaterThan(0);
      expect(lane.rotation.length).toBeGreaterThan(0);
      expect(lane.revocation.length).toBeGreaterThan(0);
      expect(lane.prerequisite.length).toBeGreaterThan(0);
      expect(lane.secrets.length).toBeGreaterThan(0);
    }
  });

  test("reports drift when a contract name leaves its workflow", () => {
    const lane = STORE_LANES.find((entry) => entry.id === "snap");
    if (!lane) throw new Error("snap lane missing from the contract");
    const mutated = {
      ...workflowSources,
      [lane.workflow]: workflowSources[lane.workflow].replaceAll(
        "SNAPCRAFT_STORE_CREDENTIALS",
        "SOME_OTHER_NAME",
      ),
    };
    const coverage = auditWorkflowCoverage(mutated);
    expect(coverage.ok).toBe(false);
    expect(coverage.missingInWorkflows).toContain(
      `secrets.SNAPCRAFT_STORE_CREDENTIALS in ${lane.workflow}`,
    );
    expect(coverage.missingInContract).toContain("secrets.SOME_OTHER_NAME");
  });

  test("treats runner routing variables as non-credential", () => {
    for (const name of NON_CREDENTIAL_VARIABLES) {
      expect(requiredVariableNames()).not.toContain(name);
    }
  });

  test("ignores the automatic GITHUB_TOKEN when extracting references", () => {
    const refs = extractWorkflowReferences(
      `token: \${{ secrets.GITHUB_TOKEN }}\nid: \${{ vars.SOME_ID }}`,
    );
    expect(refs.secrets).toEqual([]);
    expect(refs.variables).toEqual(["SOME_ID"]);
  });
});

describe("environment readiness evaluation", () => {
  const fullyProvisioned = {
    environmentExists: true,
    secretNames: requiredSecretNames(),
    variableNames: requiredVariableNames(),
    hasRequiredReviewers: true,
    hasBranchPolicy: true,
  };

  test("is ready only when every lane name is present and the gates are set", () => {
    const readiness = evaluateEnvironmentReadiness(fullyProvisioned);
    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toEqual([]);
    expect(readiness.lanes.every((lane) => lane.ready)).toBe(true);
  });

  test("blocks everything when the environment does not exist", () => {
    const readiness = evaluateEnvironmentReadiness({
      environmentExists: false,
      secretNames: [],
      variableNames: [],
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.lanes.every((lane) => lane.ready)).toBe(false);
    expect(readiness.blockers[0]).toContain(RELEASE_ENVIRONMENT);
  });

  test("names each missing credential per provider without values", () => {
    const readiness = evaluateEnvironmentReadiness({
      ...fullyProvisioned,
      secretNames: fullyProvisioned.secretNames.filter(
        (name) => name !== "PLAY_STORE_SERVICE_ACCOUNT_JSON",
      ),
      variableNames: fullyProvisioned.variableNames.filter(
        (name) => name !== "MICROSOFT_STORE_APPLICATION_ID",
      ),
    });
    expect(readiness.ready).toBe(false);
    const play = readiness.lanes.find((lane) => lane.id === "google-play");
    expect(play?.missingSecrets).toEqual(["PLAY_STORE_SERVICE_ACCOUNT_JSON"]);
    const microsoft = readiness.lanes.find((lane) => lane.id === "microsoft");
    expect(microsoft?.missingVariables).toEqual([
      "MICROSOFT_STORE_APPLICATION_ID",
    ]);
    expect(readiness.lanes.find((lane) => lane.id === "snap")?.ready).toBe(
      true,
    );
  });

  test("flags a protected environment that lost its reviewers or branch policy", () => {
    const readiness = evaluateEnvironmentReadiness({
      ...fullyProvisioned,
      hasRequiredReviewers: false,
      hasBranchPolicy: false,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toContain(
      `Environment ${RELEASE_ENVIRONMENT} has no required reviewers.`,
    );
    expect(readiness.blockers).toContain(
      `Environment ${RELEASE_ENVIRONMENT} has no deployment branch/tag policy.`,
    );
  });
});
