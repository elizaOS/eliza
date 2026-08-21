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
  RELEASE_ENVIRONMENT_POLICY,
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
  const canonicalPatterns = RELEASE_ENVIRONMENT_POLICY.deploymentRefs.map(
    (ref) => ({ ...ref }),
  );
  const allowlistedPolicy = {
    ...RELEASE_ENVIRONMENT_POLICY,
    authorizedReviewers: ["release-owner"],
  };
  const fullyProvisioned = {
    environmentExists: true,
    secretNames: requiredSecretNames(),
    variableNames: requiredVariableNames(),
    reviewers: [{ login: "release-owner", type: "User" }],
    preventSelfReview: true,
    branchPolicy: { protectedBranches: false, customBranchPolicies: true },
    branchPolicyPatterns: canonicalPatterns,
  };

  test("is ready only when names, allowlisted reviewers, self-review prevention, and the canonical deployment policy are all proven", () => {
    const readiness = evaluateEnvironmentReadiness(
      fullyProvisioned,
      allowlistedPolicy,
    );
    expect(readiness.ready).toBe(true);
    expect(readiness.blockers).toEqual([]);
    expect(readiness.lanes.every((lane) => lane.ready)).toBe(true);
    expect(readiness.caveat).toContain("real protected store publish");
  });

  test("ships with an empty reviewer allowlist that blocks READY pending owner verification", () => {
    expect(RELEASE_ENVIRONMENT_POLICY.authorizedReviewers).toEqual([]);
    const readiness = evaluateEnvironmentReadiness(fullyProvisioned);
    expect(readiness.ready).toBe(false);
    expect(
      readiness.blockers.some(
        (blocker) =>
          blocker.includes("reviewer allowlist is empty") &&
          blocker.includes("release-owner"),
      ),
    ).toBe(true);
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
    const readiness = evaluateEnvironmentReadiness(
      {
        ...fullyProvisioned,
        secretNames: fullyProvisioned.secretNames.filter(
          (name) => name !== "PLAY_STORE_SERVICE_ACCOUNT_JSON",
        ),
        variableNames: fullyProvisioned.variableNames.filter(
          (name) => name !== "MICROSOFT_STORE_APPLICATION_ID",
        ),
      },
      allowlistedPolicy,
    );
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

  test("rejects a reviewer outside the authorized allowlist", () => {
    const readiness = evaluateEnvironmentReadiness(
      {
        ...fullyProvisioned,
        reviewers: [
          { login: "release-owner", type: "User" },
          { login: "mallory", type: "User" },
        ],
      },
      allowlistedPolicy,
    );
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers).toContain(
      `Environment ${RELEASE_ENVIRONMENT}: reviewer mallory is not in the authorized reviewer allowlist.`,
    );
  });

  test("rejects an environment with no reviewers or with self-review enabled", () => {
    const noReviewers = evaluateEnvironmentReadiness(
      { ...fullyProvisioned, reviewers: [] },
      allowlistedPolicy,
    );
    expect(noReviewers.ready).toBe(false);
    expect(noReviewers.blockers).toContain(
      `Environment ${RELEASE_ENVIRONMENT} has no required reviewers.`,
    );

    const selfReview = evaluateEnvironmentReadiness(
      { ...fullyProvisioned, preventSelfReview: false },
      allowlistedPolicy,
    );
    expect(selfReview.ready).toBe(false);
    expect(selfReview.blockers).toContain(
      `Environment ${RELEASE_ENVIRONMENT} does not prevent self-review of deployments.`,
    );
  });

  test("rejects any-branch and protected-branches-only deployment policies", () => {
    const anyBranch = evaluateEnvironmentReadiness(
      { ...fullyProvisioned, branchPolicy: null, branchPolicyPatterns: null },
      allowlistedPolicy,
    );
    expect(anyBranch.ready).toBe(false);
    expect(
      anyBranch.blockers.some((blocker) =>
        blocker.includes("admits deployments from any branch"),
      ),
    ).toBe(true);

    const protectedOnly = evaluateEnvironmentReadiness(
      {
        ...fullyProvisioned,
        branchPolicy: { protectedBranches: true, customBranchPolicies: false },
        branchPolicyPatterns: null,
      },
      allowlistedPolicy,
    );
    expect(protectedOnly.ready).toBe(false);
    expect(
      protectedOnly.blockers.some((blocker) =>
        blocker.includes("protected-branches-only"),
      ),
    ).toBe(true);
  });

  test("rejects a policy that admits a noncanonical ref or misses the canonical one", () => {
    const noncanonical = evaluateEnvironmentReadiness(
      {
        ...fullyProvisioned,
        branchPolicyPatterns: [
          ...canonicalPatterns,
          { name: "*", type: "tag" },
        ],
      },
      allowlistedPolicy,
    );
    expect(noncanonical.ready).toBe(false);
    expect(noncanonical.blockers).toContain(
      `Environment ${RELEASE_ENVIRONMENT}: deployment policy admits noncanonical tag pattern *.`,
    );

    const missingCanonical = evaluateEnvironmentReadiness(
      {
        ...fullyProvisioned,
        branchPolicyPatterns: [{ name: "main", type: "branch" }],
      },
      allowlistedPolicy,
    );
    expect(missingCanonical.ready).toBe(false);
    expect(
      missingCanonical.blockers.some((blocker) =>
        blocker.includes("does not admit the canonical release ref"),
      ),
    ).toBe(true);
  });

  test("treats unreadable protection settings as blockers, never as passes", () => {
    const readiness = evaluateEnvironmentReadiness(
      {
        ...fullyProvisioned,
        reviewers: null,
        preventSelfReview: null,
        branchPolicy: undefined,
        branchPolicyPatterns: null,
      },
      allowlistedPolicy,
    );
    expect(readiness.ready).toBe(false);
    expect(
      readiness.blockers.filter((blocker) =>
        blocker.includes("owner verification required"),
      ).length,
    ).toBe(3);
  });

  test("treats unreadable custom policy patterns as a blocker", () => {
    const readiness = evaluateEnvironmentReadiness(
      { ...fullyProvisioned, branchPolicyPatterns: null },
      allowlistedPolicy,
    );
    expect(readiness.ready).toBe(false);
    expect(
      readiness.blockers.some((blocker) =>
        blocker.includes("custom deployment branch policies could not be read"),
      ),
    ).toBe(true);
  });
});
