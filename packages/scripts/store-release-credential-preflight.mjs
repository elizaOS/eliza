#!/usr/bin/env node
/**
 * Reports whether the protected `production-release` GitHub Environment is
 * provisioned for every canonical store-publish lane, without touching a
 * single credential value.
 *
 * Default operation is offline: it prints the authored credential contract and
 * verifies it still matches the names the shipped workflows reference, which is
 * the drift guard for `.github/workflows/{snap,store-mobile,store-windows}`.
 * `--audit` additionally reads the live environment through `gh api` and lists
 * the names that a repository owner still has to provision. The GitHub API
 * never returns secret values, and this script only ever compares names, so a
 * `--audit` run is safe to paste into an issue.
 *
 * Exit codes: 0 ready, 1 contract drift or unreadable live state, 2 the live
 * environment is not yet fully provisioned.
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
        hasRequiredReviewers: false,
        hasBranchPolicy: false,
      };
    }
    return { error: environment.error };
  }

  const rules = environment.body.protection_rules ?? [];
  const hasRequiredReviewers = rules.some(
    (rule) => rule.type === "required_reviewers",
  );
  const hasBranchPolicy = Boolean(environment.body.deployment_branch_policy);

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
    hasRequiredReviewers,
    hasBranchPolicy,
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
      hasRequiredReviewers: live.hasRequiredReviewers,
      hasBranchPolicy: live.hasBranchPolicy,
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
      report.live.ready ? "Live audit: READY" : "Live audit: NOT PROVISIONED",
    );
    for (const blocker of report.live.blockers) lines.push(`  - ${blocker}`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
}

process.exit(exitCode);
