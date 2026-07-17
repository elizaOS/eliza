#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVIDENCE_KEYS = Object.freeze([
  "domain",
  "sso",
  "backups",
  "database",
  "imageProvenance",
  "runner",
  "repository",
  "githubMigration",
  "secrets",
  "mail",
  "storage",
  "observability",
  "steward",
  "mergeQueueRollout",
  "securityReview",
  "deployment",
]);

main();

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
      process.stdout.write(usage());
      return;
    }

    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const defaultTemplate = path.resolve(
      scriptDir,
      "..",
      "release",
      "production-evidence.example.json",
    );
    const templatePath = options.template ?? defaultTemplate;
    const evidence = readJsonFile(templatePath);

    for (const fragmentPath of options.fragments) {
      const fragment = readJsonFile(fragmentPath);
      const updates = evidenceUpdates(fragment, fragmentPath);

      for (const [key, value] of Object.entries(updates)) {
        evidence[key] = value;
      }
    }

    const output = `${JSON.stringify(evidence, null, 2)}\n`;

    if (options.out) {
      writeFileSync(options.out, output, { mode: 0o600 });
      return;
    }

    process.stdout.write(output);
  } catch (error) {
    console.error(`[production-evidence-assemble] error: ${error.message}`);
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = {
    fragments: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--template") {
      index += 1;
      if (!args[index]) {
        throw new Error("--template requires a path");
      }
      options.template = args[index];
      continue;
    }

    if (arg.startsWith("--template=")) {
      options.template = arg.slice("--template=".length);
      if (!options.template) {
        throw new Error("--template requires a path");
      }
      continue;
    }

    if (arg === "--out") {
      index += 1;
      if (!args[index]) {
        throw new Error("--out requires a path");
      }
      options.out = args[index];
      continue;
    }

    if (arg.startsWith("--out=")) {
      options.out = arg.slice("--out=".length);
      if (!options.out) {
        throw new Error("--out requires a path");
      }
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`unknown argument: ${arg}`);
    }

    options.fragments.push(arg);
  }

  if (!options.help && options.fragments.length === 0) {
    throw new Error("at least one evidence fragment path is required");
  }

  return options;
}

function readJsonFile(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`missing JSON file: ${filePath}`);
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`invalid JSON in ${filePath}: ${error.message}`);
  }
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function evidenceUpdates(fragment, fragmentPath) {
  const updates = {};

  if (fragment?.domainEvidence?.domain) {
    updates.domain = {
      ...fragment.domainEvidence.domain,
      probeEvidence: {
        source: fragmentPath,
        sha256: sha256File(fragmentPath),
        checkedAt: fragment.domainEvidence.checkedAt ?? null,
        status: fragment.domainEvidence.status ?? null,
        checkCount: Array.isArray(fragment.domainEvidence.checks)
          ? fragment.domainEvidence.checks.length
          : 0,
      },
    };
  }

  if (fragment?.runnerIsolation?.evidence?.runner) {
    updates.runner = {
      smokeEvidence: null,
      auditEvidence: null,
      ...fragment.runnerIsolation.evidence.runner,
    };
  }

  if (fragment?.schema === "https://eliza.hub/schemas/deploy-evidence.v1") {
    updates.deployment = deploymentEvidenceFromDeploy(fragment, fragmentPath);
  }

  if (
    fragment?.schema === "https://eliza.hub/schemas/pilot-bootstrap-evidence.v1"
  ) {
    updates.githubMigration = githubMigrationEvidenceFromPilotBootstrap(
      fragment,
      fragmentPath,
    );
  }

  for (const key of EVIDENCE_KEYS) {
    if (Object.hasOwn(fragment, key)) {
      updates[key] = fragment[key];
    }
  }

  if (Object.keys(updates).length === 0) {
    throw new Error(
      `${fragmentPath} does not contain a supported production evidence object`,
    );
  }

  return updates;
}

function githubMigrationEvidenceFromPilotBootstrap(receipt, receiptPath) {
  const summary = pilotBootstrapSummary(receipt);

  return {
    pilotBootstrapEvidence: {
      source: receiptPath,
      sha256: sha256File(receiptPath),
      checkedAt: receipt.finishedAt ?? null,
      status: receipt.status ?? null,
      dryRun: receipt.dryRun ?? null,
      repo: receipt.repo?.fullName ?? null,
      upstreamHost: receipt.upstream?.host ?? null,
      stepCount: summary.stepCount,
      requiredCheckCount: summary.requiredCheckCount,
      trustedAgentCount: summary.trustedAgentCount,
    },
    pilotBootstrapPassed:
      receipt.status === "passed" &&
      receipt.dryRun === false &&
      summary.productionReady === true,
    mirrorVerified: summary.mirrorVerified,
    defaultBranchVerified: summary.defaultBranchVerified,
    webhookVerified: summary.webhookVerified,
    branchProtectionVerified: summary.branchProtectionVerified,
    repoPolicyVerified: summary.repoPolicyVerified,
    agentIdentitiesSynced: summary.agentIdentitiesSynced,
    pilotSurfacesVerified: summary.pilotSurfacesVerified,
    pullMirrorOnly: summary.pullMirrorOnly,
  };
}

function pilotBootstrapSummary(receipt) {
  const steps = Array.isArray(receipt.steps) ? receipt.steps : [];
  const embedded =
    receipt.summary && typeof receipt.summary === "object"
      ? receipt.summary
      : {};
  const stepCount =
    typeof embedded.stepCount === "number" ? embedded.stepCount : steps.length;
  const requiredCheckCount =
    typeof embedded.requiredCheckCount === "number"
      ? embedded.requiredCheckCount
      : Array.isArray(receipt.requiredChecks)
        ? receipt.requiredChecks.length
        : 0;
  const trustedAgentCount =
    typeof embedded.trustedAgentCount === "number"
      ? embedded.trustedAgentCount
      : Array.isArray(receipt.trustedAgentIds)
        ? receipt.trustedAgentIds.length
        : 0;

  const mirrorVerified =
    embedded.mirrorVerified === true ||
    successfulPilotStep(
      steps,
      "mirror-repository",
      (step) => step.status === "created" || step.mirror === true,
    );
  const defaultBranchVerified =
    embedded.defaultBranchVerified === true ||
    successfulPilotStep(steps, "verify-default-branch");
  const webhookVerified =
    embedded.webhookVerified === true ||
    successfulPilotStep(steps, "steward-webhook");
  const branchProtectionVerified =
    embedded.branchProtectionVerified === true ||
    successfulPilotStep(steps, "branch-protection");
  const repoPolicyVerified =
    embedded.repoPolicyVerified === true ||
    (successfulPilotStep(steps, "repo-policy") &&
      successfulPilotStep(steps, "repo-policy-verify"));
  const agentIdentitiesSynced =
    embedded.agentIdentitiesSynced === true ||
    successfulPilotStep(steps, "agent-identities");
  const pilotSurfacesVerified =
    embedded.pilotSurfacesVerified === true ||
    successfulPilotStep(steps, "pilot-surfaces");
  const pullMirrorOnly =
    embedded.pullMirrorOnly === true ||
    (receipt.upstream?.host === "github.com" &&
      receipt.migration?.direction === "pull" &&
      receipt.migration?.mirror === true);

  return {
    productionReady:
      embedded.productionReady === true ||
      (receipt.status === "passed" &&
        receipt.dryRun === false &&
        requiredCheckCount > 0 &&
        trustedAgentCount > 0 &&
        mirrorVerified &&
        defaultBranchVerified &&
        webhookVerified &&
        branchProtectionVerified &&
        repoPolicyVerified &&
        agentIdentitiesSynced &&
        pilotSurfacesVerified &&
        pullMirrorOnly),
    stepCount,
    requiredCheckCount,
    trustedAgentCount,
    mirrorVerified,
    defaultBranchVerified,
    webhookVerified,
    branchProtectionVerified,
    repoPolicyVerified,
    agentIdentitiesSynced,
    pilotSurfacesVerified,
    pullMirrorOnly,
  };
}

function successfulPilotStep(steps, name, predicate = () => true) {
  const passStatuses = new Set([
    "verified",
    "verified-existing",
    "created",
    "updated",
    "upserted",
    "synced",
  ]);
  return steps.some(
    (step) =>
      step?.name === name && passStatuses.has(step.status) && predicate(step),
  );
}

function deploymentEvidenceFromDeploy(deployEvidence, deployEvidencePath) {
  const postDeploySource = deployEvidence.files?.postDeployEvidence;
  if (!postDeploySource) {
    throw new Error(
      `${deployEvidencePath} is missing files.postDeployEvidence`,
    );
  }

  const resolvedPostDeploySource = path.isAbsolute(postDeploySource)
    ? postDeploySource
    : path.resolve(path.dirname(deployEvidencePath), postDeploySource);
  const postDeployEvidence = readJsonFile(resolvedPostDeploySource);
  const postDeploySummary = postDeployEvidence.summary ?? {};
  const postDeployTargets = postDeployEvidence.targets ?? {};

  return {
    deployEvidence: {
      source: deployEvidencePath,
      sha256: sha256File(deployEvidencePath),
      checkedAt: deployEvidence.finishedAt ?? null,
      status: deployEvidence.status ?? null,
      mode: deployEvidence.mode ?? null,
      dryRun: deployEvidence.dryRun ?? null,
      stepCount: Array.isArray(deployEvidence.steps)
        ? deployEvidence.steps.length
        : 0,
      postDeployEvidenceSource: resolvedPostDeploySource,
      postDeployEvidenceSha256: sha256File(resolvedPostDeploySource),
    },
    postDeployEvidence: {
      source: resolvedPostDeploySource,
      sha256: sha256File(resolvedPostDeploySource),
      checkedAt: postDeployEvidence.finishedAt ?? null,
      status: postDeployEvidence.status ?? null,
      checkCount:
        typeof postDeploySummary.total === "number"
          ? postDeploySummary.total
          : 0,
      failedCount:
        typeof postDeploySummary.failed === "number"
          ? postDeploySummary.failed
          : 0,
      forgejoLocalUrl: postDeployTargets.forgejoLocalUrl ?? null,
      stewardLocalUrl: postDeployTargets.stewardLocalUrl ?? null,
    },
    mode: deployEvidence.mode ?? null,
    applied:
      deployEvidence.status === "passed" && deployEvidence.dryRun === false,
    postDeployVerified:
      postDeployEvidence.status === "passed" && postDeploySummary.failed === 0,
  };
}

function usage() {
  return `Usage: production-evidence-assemble.mjs [--template PATH] [--out PATH] FRAGMENT...

Merges generated production evidence fragments into a private evidence JSON
document. Without --out, the assembled JSON is printed to stdout.

Supported fragments include direct production-evidence keys such as:
  domain, sso, backups, database, imageProvenance, runner, repository, secrets,
  githubMigration, mail, storage, observability, steward, mergeQueueRollout,
  securityReview, deployment

The assembler also understands these helper outputs:
  { "domainEvidence": { "domain": ... } }
  { "runnerIsolation": { "evidence": { "runner": ... } } }
  { "schema": "https://eliza.hub/schemas/deploy-evidence.v1", ... }
  { "schema": "https://eliza.hub/schemas/pilot-bootstrap-evidence.v1", ... }

For runner production cutover, prefer the direct { "runner": ... } fragment
written by scripts/runner-evidence.sh because it includes smoke and audit
artifact provenance.

Write the assembled private file outside Git, then run:
  node services/merge-steward/src/cli.js production-gate --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"
`;
}
