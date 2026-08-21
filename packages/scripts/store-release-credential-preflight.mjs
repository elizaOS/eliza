#!/usr/bin/env node
/**
 * Reports whether the protected `production-release` GitHub Environment is
 * provisioned for every canonical store-publish lane, without touching a
 * single credential value.
 *
 * Default operation is offline: it prints the authored credential contract and
 * verifies it still matches the names the shipped workflows reference, which is
 * the drift guard for `.github/workflows/{snap,store-mobile,store-windows}`.
 * `--audit` additionally reads the live environment through `gh api`: the name
 * inventory an owner still has to provision, the resolved required-reviewer
 * principals, `prevent_self_review`, and the custom deployment branch/tag
 * policy patterns, all validated against `RELEASE_ENVIRONMENT_POLICY`. A
 * setting the API cannot prove is a blocker, never a pass. The GitHub API
 * never returns secret values, and this script only ever compares names and
 * policy metadata, so a `--audit` transcript is safe to paste into an issue.
 * Name presence cannot prove a credential value is valid; that proof comes
 * only from a real protected store publish.
 *
 * Exit codes: 0 ready, 1 contract drift or unreadable live state, 2 the live
 * environment is not provisioned or its protection policy is unproven or
 * violates the contract.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  auditWorkflowCoverage,
  evaluateEnvironmentReadiness,
  RELEASE_ENVIRONMENT,
  requiredSecretNames,
  requiredVariableNames,
  STORE_LANES,
} from "./lib/store-release-credentials.mjs";

const repoRoot = new URL("../../", import.meta.url);
const args = new Set(process.argv.slice(2));
const jsonOutput = args.has("--json");
const auditLive = args.has("--audit");

function readWorkflow(path) {
  return readFileSync(new URL(path, repoRoot), "utf8");
}

function gh(endpoint) {
  const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8" });
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr || "").trim() };
  }
  // error-policy:J3 gh can return non-JSON on an unexpected response shape;
  // that is an explicit unreadable result, never an empty-but-valid inventory.
  try {
    return { ok: true, body: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: `Unparsable gh api response for ${endpoint}` };
  }
}

function repoSlug() {
  const override = process.env.ELIZA_RELEASE_REPO;
  if (override?.trim()) return override.trim();
  const result = spawnSync(
    "gh",
    ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function readLiveEnvironment() {
  const slug = repoSlug();
  if (!slug) {
    return {
      error:
        "Unable to resolve the repository slug; run `gh auth login` or set ELIZA_RELEASE_REPO.",
    };
  }
  const environment = gh(`repos/${slug}/environments/${RELEASE_ENVIRONMENT}`);
  if (!environment.ok) {
    if (/HTTP 404/.test(environment.error)) {
      return {
        environmentExists: false,
        secretNames: [],
        variableNames: [],
        reviewers: [],
        preventSelfReview: null,
        branchPolicy: undefined,
        branchPolicyPatterns: null,
      };
    }
    return { error: environment.error };
  }

  const rules = environment.body.protection_rules ?? [];
  const reviewerRule = rules.find((rule) => rule.type === "required_reviewers");
  // An absent rule is an empty reviewer list (a definite blocker); a present
  // rule whose principals cannot be resolved stays null so the evaluation
  // reports unreadable state instead of a healthy-looking empty list.
  let reviewers = [];
  if (reviewerRule) {
    const resolved = (reviewerRule.reviewers ?? []).map((entry) => ({
      type: entry.type ?? "unknown",
      login: entry.reviewer?.login ?? entry.reviewer?.slug ?? null,
    }));
    reviewers = resolved.some((entry) => entry.login === null)
      ? null
      : resolved;
  }
  const preventSelfReview =
    typeof reviewerRule?.prevent_self_review === "boolean"
      ? reviewerRule.prevent_self_review
      : null;

  const rawBranchPolicy = environment.body.deployment_branch_policy;
  const branchPolicy = rawBranchPolicy
    ? {
        protectedBranches: Boolean(rawBranchPolicy.protected_branches),
        customBranchPolicies: Boolean(rawBranchPolicy.custom_branch_policies),
      }
    : null;

  let branchPolicyPatterns = null;
  if (branchPolicy?.customBranchPolicies) {
    const policies = gh(
      `repos/${slug}/environments/${RELEASE_ENVIRONMENT}/deployment-branch-policies?per_page=100`,
    );
    if (!policies.ok) return { error: policies.error };
    branchPolicyPatterns = (policies.body.branch_policies ?? []).map(
      (entry) => ({ name: entry.name, type: entry.type ?? "branch" }),
    );
  }

  const secrets = gh(
    `repos/${slug}/environments/${RELEASE_ENVIRONMENT}/secrets?per_page=100`,
  );
  const variables = gh(
    `repos/${slug}/environments/${RELEASE_ENVIRONMENT}/variables?per_page=100`,
  );
  if (!secrets.ok) return { error: secrets.error };
  if (!variables.ok) return { error: variables.error };

  return {
    environmentExists: true,
    secretNames: (secrets.body.secrets ?? []).map((entry) => entry.name),
    variableNames: (variables.body.variables ?? []).map((entry) => entry.name),
    reviewers,
    preventSelfReview,
    branchPolicy,
    branchPolicyPatterns,
  };
}

const workflowPaths = [...new Set(STORE_LANES.map((lane) => lane.workflow))];
const workflowSources = Object.fromEntries(
  workflowPaths.map((path) => [path, readWorkflow(path)]),
);
const coverage = auditWorkflowCoverage(workflowSources);

const report = {
  environment: RELEASE_ENVIRONMENT,
  contract: STORE_LANES.map((lane) => ({
    id: lane.id,
    provider: lane.provider,
    workflow: lane.workflow,
    secrets: [...lane.secrets],
    variables: [...lane.variables],
    prerequisite: lane.prerequisite,
    owner: lane.owner,
    rotation: lane.rotation,
    revocation: lane.revocation,
  })),
  requiredSecrets: requiredSecretNames(),
  requiredVariables: requiredVariableNames(),
  workflowCoverage: coverage,
  live: null,
};

let exitCode = coverage.ok ? 0 : 1;

if (auditLive) {
  const live = readLiveEnvironment();
  if (live.error) {
    report.live = { error: live.error };
    exitCode = 1;
  } else {
    const readiness = evaluateEnvironmentReadiness(live);
    report.live = {
      environmentExists: live.environmentExists,
      reviewers: live.reviewers,
      preventSelfReview: live.preventSelfReview,
      branchPolicy: live.branchPolicy,
      branchPolicyPatterns: live.branchPolicyPatterns,
      ...readiness,
    };
    if (!readiness.ready && exitCode === 0) exitCode = 2;
  }
}

if (jsonOutput) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const lines = [`Protected release environment: ${RELEASE_ENVIRONMENT}`, ""];
  for (const lane of report.contract) {
    lines.push(`${lane.provider} (${lane.workflow})`);
    lines.push(`  prerequisite: ${lane.prerequisite}`);
    lines.push(`  owner:        ${lane.owner}`);
    lines.push(`  rotation:     ${lane.rotation}`);
    lines.push(`  revocation:   ${lane.revocation}`);
    lines.push(
      `  secrets:      ${lane.secrets.length ? lane.secrets.join(", ") : "(none)"}`,
    );
    lines.push(
      `  variables:    ${lane.variables.length ? lane.variables.join(", ") : "(none)"}`,
    );
    lines.push("");
  }

  if (coverage.ok) {
    lines.push("Workflow coverage: contract matches the shipped workflows.");
  } else {
    lines.push("Workflow coverage: DRIFT");
    for (const entry of coverage.missingInWorkflows) {
      lines.push(`  contract name not referenced by its workflow: ${entry}`);
    }
    for (const entry of coverage.missingInContract) {
      lines.push(`  workflow reference missing from the contract: ${entry}`);
    }
  }

  if (report.live?.error) {
    lines.push("", `Live audit: FAILED — ${report.live.error}`);
  } else if (report.live) {
    lines.push(
      "",
      report.live.ready ? "Live audit: READY" : "Live audit: NOT READY",
    );
    if (report.live.environmentExists) {
      const reviewers = report.live.reviewers;
      lines.push(
        `  reviewers:           ${
          reviewers === null
            ? "(unreadable)"
            : reviewers.length
              ? reviewers
                  .map((entry) => `${entry.login} (${entry.type})`)
                  .join(", ")
              : "(none)"
        }`,
      );
      lines.push(
        `  prevent self-review: ${report.live.preventSelfReview ?? "(unreadable)"}`,
      );
      const patterns = report.live.branchPolicyPatterns;
      lines.push(
        `  deployment policy:   ${
          report.live.branchPolicy === undefined
            ? "(unreadable)"
            : report.live.branchPolicy === null
              ? "any branch"
              : report.live.branchPolicy.protectedBranches
                ? "protected branches only"
                : patterns === null
                  ? "custom (patterns unreadable)"
                  : `custom: ${
                      patterns.length
                        ? patterns
                            .map((entry) => `${entry.type} ${entry.name}`)
                            .join(", ")
                        : "(no patterns)"
                    }`
        }`,
      );
    }
    for (const blocker of report.live.blockers) lines.push(`  - ${blocker}`);
    lines.push(`  note: ${report.live.caveat}`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

process.exit(exitCode);
