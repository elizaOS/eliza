#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMergeStewardClient } from "../../../services/merge-steward/src/client.js";
import { artifactPath } from "./artifact-paths.mjs";

const TRUE_PATTERN = /^(?:1|true|yes|on)$/i;
const FALSE_PATTERN = /^(?:0|false|no|off)$/i;
const DEFAULT_OUTPUT = artifactPath("merge-queue-live-drill.json");
const DEFAULT_WORKER_ID = "merge-queue-live-drill";
const DEFAULT_STACK_PROOF_REPO = "elizaos/eliza";

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const defaultEnvFile = path.resolve(scriptDir, "..", ".env");
  const envFile = options.envFile ?? process.env.ENV_FILE ?? defaultEnvFile;
  const values = readConfiguration(envFile, process.env);
  const baseUrl = requiredValue(
    options.stewardUrl ??
      values.MERGE_STEWARD_URL ??
      values.ELIZA_MERGE_STEWARD_URL,
    "MERGE_STEWARD_URL",
  );
  const token =
    values.MERGE_QUEUE_LIVE_DRILL_STEWARD_TOKEN ??
    values.MERGE_STEWARD_API_TOKEN ??
    "";
  const outputPath =
    options.output ?? values.MERGE_QUEUE_LIVE_DRILL_OUTPUT ?? DEFAULT_OUTPUT;
  const workerId =
    options.workerId ??
    values.MERGE_QUEUE_LIVE_DRILL_WORKER_ID ??
    DEFAULT_WORKER_ID;
  const confirmExecution =
    options.confirmLiveExecution ||
    parseBoolean(values.MERGE_QUEUE_LIVE_DRILL_CONFIRM_EXECUTION) === true;
  const rollbackDrillPassed =
    parseBoolean(values.MERGE_QUEUE_LIVE_DRILL_ROLLBACK_DRILL_PASSED) === true;
  const humanApprovalRecorded =
    parseBoolean(values.MERGE_QUEUE_LIVE_DRILL_HUMAN_APPROVAL_RECORDED) ===
    true;
  const stackDependencyOrderAttested =
    parseBoolean(
      values.MERGE_QUEUE_LIVE_DRILL_STACK_DEPENDENCY_ORDER_ENFORCED,
    ) === true;
  const stackProofRepo =
    cleanString(
      values.MERGE_QUEUE_LIVE_DRILL_STACK_PROOF_REPO ??
        values.MERGE_QUEUE_ROLLOUT_SMOKE_REPO ??
        values.MERGE_STEWARD_SMOKE_REPO,
    ) ?? DEFAULT_STACK_PROOF_REPO;
  const stackProofTargetBranch = cleanString(
    values.MERGE_QUEUE_LIVE_DRILL_STACK_PROOF_TARGET_BRANCH,
  );

  if (!confirmExecution) {
    throw new Error(
      "MERGE_QUEUE_LIVE_DRILL_CONFIRM_EXECUTION=true or --confirm-live-execution is required",
    );
  }
  if (!rollbackDrillPassed) {
    throw new Error(
      "MERGE_QUEUE_LIVE_DRILL_ROLLBACK_DRILL_PASSED=true is required",
    );
  }
  if (!humanApprovalRecorded) {
    throw new Error(
      "MERGE_QUEUE_LIVE_DRILL_HUMAN_APPROVAL_RECORDED=true is required",
    );
  }
  if (!stackDependencyOrderAttested) {
    throw new Error(
      "MERGE_QUEUE_LIVE_DRILL_STACK_DEPENDENCY_ORDER_ENFORCED=true is required",
    );
  }

  const client = createMergeStewardClient({ baseUrl, token });
  const checkedAt = new Date().toISOString();
  const stackDependencyOrderProof = await collectStackDependencyOrderProof(
    client,
    {
      checkedAt,
      repo: stackProofRepo,
      targetBranch: stackProofTargetBranch,
    },
  );
  const readiness = await client.getReady();
  const runOnce = await client.runOnce({ workerId, confirm: true });
  const events = await collectRunEvents(client, runOnce);
  const evidence = buildLiveDrillEvidence({
    checkedAt,
    readiness,
    runOnce,
    events,
    rollbackDrillPassed,
    humanApprovalRecorded,
    stackDependencyOrderAttested,
    stackDependencyOrderProof,
  });
  const errors = validateLiveDrillEvidence(evidence.mergeQueueRolloutLiveDrill);

  if (errors.length > 0) {
    throw new Error(
      `live merge queue drill evidence is incomplete:\n- ${errors.join("\n- ")}`,
    );
  }

  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    mode: 0o600,
  });
  log(`wrote merge queue live drill evidence to ${outputPath}`);
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--confirm-live-execution") {
      options.confirmLiveExecution = true;
      continue;
    }

    if (arg === "--env-file") {
      index += 1;
      options.envFile = requireArg(args[index], "--env-file");
      continue;
    }

    if (arg.startsWith("--env-file=")) {
      options.envFile = requireArg(
        arg.slice("--env-file=".length),
        "--env-file",
      );
      continue;
    }

    if (arg === "--steward-url") {
      index += 1;
      options.stewardUrl = requireArg(args[index], "--steward-url");
      continue;
    }

    if (arg.startsWith("--steward-url=")) {
      options.stewardUrl = requireArg(
        arg.slice("--steward-url=".length),
        "--steward-url",
      );
      continue;
    }

    if (arg === "--worker-id") {
      index += 1;
      options.workerId = requireArg(args[index], "--worker-id");
      continue;
    }

    if (arg.startsWith("--worker-id=")) {
      options.workerId = requireArg(
        arg.slice("--worker-id=".length),
        "--worker-id",
      );
      continue;
    }

    if (arg === "--output") {
      index += 1;
      options.output = requireArg(args[index], "--output");
      continue;
    }

    if (arg.startsWith("--output=")) {
      options.output = requireArg(arg.slice("--output=".length), "--output");
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
}

async function collectRunEvents(client, runOnce) {
  const runs =
    normalizeArray(runOnce?.runs).length > 0
      ? normalizeArray(runOnce.runs)
      : normalizeArray(runOnce?.run ? [runOnce.run] : []);
  const events = [];

  for (const run of runs) {
    if (!run?.id) continue;
    const response = await client.listRunEvents(run.id);
    events.push(...normalizeArray(response?.events));
  }

  return events;
}

async function collectStackDependencyOrderProof(
  client,
  { checkedAt, repo, targetBranch },
) {
  const query = {
    readiness: false,
    now: checkedAt,
  };

  if (repo) query.repo = repo;
  if (targetBranch) query.targetBranch = targetBranch;

  const response = await client.getReleaseReadiness(query);
  const releaseReadiness = objectValue(response?.releaseReadiness ?? response);
  const stackCheck = normalizeArray(releaseReadiness.checks).find(
    (check) => check?.name === "stack_dependency_order",
  );
  const details = objectValue(stackCheck?.details);
  const snapshots = objectValue(releaseReadiness.snapshots);
  const blockedItemIds = stringArray(
    snapshots.stackBlockedItemIds ?? details.blockedItemIds,
  );
  const nextMergeItemIds = stringArray(
    snapshots.stackNextMergeItemIds ?? details.nextMergeItemIds,
  );
  const requiredActions = uniqueStringArray([
    ...normalizeArray(stackCheck?.requiredActions),
    ...normalizeArray(releaseReadiness.requiredActions),
  ]);
  const stackBlocked = numberOrZero(
    details.stackBlocked ?? blockedItemIds.length,
  );

  return {
    source: "/api/release-readiness",
    repo: releaseReadiness.filters?.repo ?? repo ?? null,
    targetBranch:
      releaseReadiness.filters?.targetBranch ?? targetBranch ?? null,
    checkedAt: releaseReadiness.computedAt ?? checkedAt,
    status: releaseReadiness.status ?? null,
    stackCheckStatus: stackCheck?.status ?? null,
    stackBlocked,
    blockedItemIds,
    nextMergeItemIds,
    requiredActions,
    valid:
      stackCheck?.status === "fail" &&
      stackBlocked > 0 &&
      blockedItemIds.length > 0 &&
      nextMergeItemIds.length > 0 &&
      requiredActions.includes("merge_stack_parents_first"),
  };
}

function buildLiveDrillEvidence({
  checkedAt,
  readiness,
  runOnce,
  events,
  rollbackDrillPassed,
  humanApprovalRecorded,
  stackDependencyOrderAttested,
  stackDependencyOrderProof,
}) {
  const runs =
    normalizeArray(runOnce?.runs).length > 0
      ? normalizeArray(runOnce.runs)
      : normalizeArray(runOnce?.run ? [runOnce.run] : []);
  const items =
    normalizeArray(runOnce?.items).length > 0
      ? normalizeArray(runOnce.items)
      : normalizeArray(runOnce?.item ? [runOnce.item] : []);
  const execution = objectValue(runOnce?.execution);
  const executions = normalizeArray(execution.executions);
  const workerLease = findWorkerLeaseCheck(readiness);
  const workerLeaseVerified =
    readiness?.ok === true &&
    readiness?.configuration?.workerEnabled === true &&
    readiness?.configuration?.workerLeaseEnabled === true &&
    workerLease?.ok === true &&
    Boolean(workerLease.ownerId) &&
    validFutureIso(workerLease.expiresAt, checkedAt);
  const strictWorkReservationsEnforced =
    readiness?.configuration?.requireWorkReservationForAgentPrs === true;
  const strictWorkItemsEnforced =
    readiness?.configuration?.requireWorkItemForAgentPrs === true;
  const strictAgentBranchNamespacesEnforced =
    readiness?.configuration?.requireAgentBranchNamespaceForAgentPrs === true;
  const verifiedAgentRunReceiptsEnforced =
    readiness?.configuration?.requireVerifiedAgentRunReceiptForAgentPrs ===
    true;
  const agentIdentityRegistryEnforced =
    readiness?.configuration?.requireAgentIdentityRegistryForAgentPrs ===
      true && Number(readiness?.configuration?.knownAgentIdCount ?? 0) > 0;
  const stackDependencyOrderEnforced =
    stackDependencyOrderAttested === true &&
    stackDependencyOrderProof?.valid === true;
  const stagedLiveDrillPassed =
    runOnce?.claimed === true &&
    readiness?.configuration?.integrationDryRun === false &&
    runs.some((run) => run?.status === "succeeded") &&
    items.some((item) => item?.queueState === "merged") &&
    executions.length > 0 &&
    executions.every((entry) => entry?.status === "executed") &&
    events.some((event) => event?.type === "IntegrationActionStarted") &&
    events.some((event) => event?.type === "IntegrationActionFinished");

  return {
    mergeQueueRolloutLiveDrill: {
      stagedLiveDrillPassed,
      workerLeaseVerified,
      strictWorkReservationsEnforced,
      strictWorkItemsEnforced,
      strictAgentBranchNamespacesEnforced,
      verifiedAgentRunReceiptsEnforced,
      agentIdentityRegistryEnforced,
      stackDependencyOrderEnforced,
      stackDependencyOrderProof,
      rollbackDrillPassed,
      humanApprovalRecorded,
      checkedAt,
      runId: runs.find((run) => run?.id)?.id ?? null,
      runOnce,
      readiness: {
        ok: readiness?.ok === true,
        checkedAt: readiness?.checkedAt ?? null,
        configuration: {
          workerEnabled: readiness?.configuration?.workerEnabled === true,
          workerLeaseEnabled:
            readiness?.configuration?.workerLeaseEnabled === true,
          integrationDryRun:
            readiness?.configuration?.integrationDryRun === true,
          requireWorkReservationForAgentPrs:
            readiness?.configuration?.requireWorkReservationForAgentPrs ===
            true,
          requireWorkItemForAgentPrs:
            readiness?.configuration?.requireWorkItemForAgentPrs === true,
          requireAgentBranchNamespaceForAgentPrs:
            readiness?.configuration?.requireAgentBranchNamespaceForAgentPrs ===
            true,
          requireVerifiedAgentRunReceiptForAgentPrs:
            readiness?.configuration
              ?.requireVerifiedAgentRunReceiptForAgentPrs === true,
          requireAgentIdentityRegistryForAgentPrs:
            readiness?.configuration
              ?.requireAgentIdentityRegistryForAgentPrs === true,
          knownAgentIdCount: Number(
            readiness?.configuration?.knownAgentIdCount ?? 0,
          ),
        },
        workerLease: workerLease
          ? {
              ok: workerLease.ok === true,
              leaseId: workerLease.leaseId ?? null,
              ownerId: workerLease.ownerId ?? null,
              status: workerLease.status ?? null,
              expiresAt: workerLease.expiresAt ?? null,
            }
          : null,
      },
      events,
    },
  };
}

function validateLiveDrillEvidence(live) {
  const errors = [];

  if (live.stagedLiveDrillPassed !== true) {
    errors.push(
      "staged live run must disable dry-run mode, claim work, succeed, merge an item, execute integration actions, and record action checkpoint events",
    );
  }
  if (live.workerLeaseVerified !== true) {
    errors.push(
      "worker lease must be enabled, owned, healthy, and unexpired in /ready",
    );
  }
  if (live.strictWorkReservationsEnforced !== true) {
    errors.push(
      "strict work reservations must be enabled in /ready during the live rollout drill",
    );
  }
  if (live.strictWorkItemsEnforced !== true) {
    errors.push(
      "strict Work items must be enabled in /ready during the live rollout drill",
    );
  }
  if (live.strictAgentBranchNamespacesEnforced !== true) {
    errors.push(
      "strict agent branch namespaces must be enabled in /ready during the live rollout drill",
    );
  }
  if (live.verifiedAgentRunReceiptsEnforced !== true) {
    errors.push(
      "verified agent run receipts must be enabled in /ready during the live rollout drill",
    );
  }
  if (live.agentIdentityRegistryEnforced !== true) {
    errors.push(
      "allowed-agent identity registry must be enabled and non-empty in /ready during the live rollout drill",
    );
  }
  if (live.stackDependencyOrderEnforced !== true) {
    errors.push(
      "stack dependency ordering must be proven by release-readiness during the live rollout drill",
    );
  }
  if (live.stackDependencyOrderProof?.valid !== true) {
    errors.push(
      "stack dependency order proof must include a blocked stacked child, next merge parent, and merge_stack_parents_first action",
    );
  }
  if (live.rollbackDrillPassed !== true) {
    errors.push(
      "rollback drill must be recorded before generating live rollout evidence",
    );
  }
  if (live.humanApprovalRecorded !== true) {
    errors.push(
      "human approval must be recorded before generating live rollout evidence",
    );
  }
  if (!normalizeIso(live.checkedAt)) {
    errors.push("checkedAt must be an ISO timestamp");
  }

  return errors;
}

function findWorkerLeaseCheck(readiness) {
  return (
    normalizeArray(readiness?.checks).find(
      (check) => check?.name === "worker_lease",
    ) ?? null
  );
}

function validFutureIso(value, nowIso) {
  const time = Date.parse(value);
  const now = Date.parse(nowIso);
  return Number.isFinite(time) && Number.isFinite(now) && time > now;
}

function readConfiguration(envFile, processEnv) {
  const fileValues = readEnvFile(envFile, processEnv.ALLOW_ENV_ONLY);
  const values = { ...fileValues };

  for (const key of inputKeys()) {
    if (processEnv[key] !== undefined) {
      values[key] = processEnv[key];
    }
  }

  return values;
}

function inputKeys() {
  return [
    "MERGE_STEWARD_URL",
    "ELIZA_MERGE_STEWARD_URL",
    "MERGE_STEWARD_API_TOKEN",
    "MERGE_QUEUE_LIVE_DRILL_STEWARD_TOKEN",
    "MERGE_QUEUE_LIVE_DRILL_OUTPUT",
    "MERGE_QUEUE_LIVE_DRILL_WORKER_ID",
    "MERGE_QUEUE_LIVE_DRILL_CONFIRM_EXECUTION",
    "MERGE_QUEUE_LIVE_DRILL_ROLLBACK_DRILL_PASSED",
    "MERGE_QUEUE_LIVE_DRILL_HUMAN_APPROVAL_RECORDED",
    "MERGE_QUEUE_LIVE_DRILL_STACK_DEPENDENCY_ORDER_ENFORCED",
    "MERGE_QUEUE_LIVE_DRILL_STACK_PROOF_REPO",
    "MERGE_QUEUE_LIVE_DRILL_STACK_PROOF_TARGET_BRANCH",
    "MERGE_QUEUE_ROLLOUT_SMOKE_REPO",
    "MERGE_STEWARD_SMOKE_REPO",
  ];
}

function readEnvFile(envFile, allowEnvOnly) {
  if (!existsSync(envFile)) {
    if (parseBoolean(allowEnvOnly) === true) {
      return {};
    }
    throw new Error(
      `missing ENV_FILE=${envFile}; set ENV_FILE or ALLOW_ENV_ONLY=true`,
    );
  }

  return parseEnv(readFileSync(envFile, "utf8"));
}

function parseEnv(body) {
  const values = {};

  for (const line of body.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }

    const match =
      /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) {
      continue;
    }

    values[match[1]] = parseEnvValue(match[2]);
  }

  return values;
}

function parseEnvValue(rawValue) {
  const value = rawValue.trimStart();

  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end === -1 ? value.slice(1) : value.slice(1, end);
  }

  if (value.startsWith('"')) {
    const end = findClosingDoubleQuote(value);
    const quoted = end === -1 ? value.slice(1) : value.slice(1, end);
    return quoted.replace(/\\([\\nrt"])/gu, (_, escaped) => {
      switch (escaped) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        default:
          return escaped;
      }
    });
  }

  return value.replace(/[ \t]+#.*$/u, "").trimEnd();
}

function findClosingDoubleQuote(value) {
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === "\\" && index + 1 < value.length) {
      index += 1;
      continue;
    }

    if (value[index] === '"') {
      return index;
    }
  }

  return -1;
}

function parseBoolean(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  if (TRUE_PATTERN.test(String(value))) {
    return true;
  }

  if (FALSE_PATTERN.test(String(value))) {
    return false;
  }

  throw new Error(`expected boolean value but received ${value}`);
}

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function stringArray(value) {
  return normalizeArray(value)
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function uniqueStringArray(value) {
  return [...new Set(stringArray(value))];
}

function numberOrZero(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function normalizeIso(value) {
  if (value === undefined || value === null || value === "") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function requiredValue(value, key) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new Error(`${key} is required`);
  }

  return String(value).trim();
}

function requireArg(value, name) {
  if (!value) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

function log(message) {
  process.stderr.write(`[merge-queue-live-drill-evidence] ${message}\n`);
}

function usage() {
  return `usage: merge-queue-live-drill-evidence.mjs --confirm-live-execution [--steward-url URL] [--worker-id ID] [--output path]

Runs one confirmed Merge Steward queue item through the live run-once path and
writes the private mergeQueueRolloutLiveDrill artifact consumed by
merge-queue-rollout-evidence.mjs.

Environment:
  ENV_FILE                                      Private deployment env file.
  MERGE_STEWARD_URL                            Merge Steward base URL.
  MERGE_STEWARD_API_TOKEN                      Bearer token for control APIs.
  MERGE_QUEUE_LIVE_DRILL_STEWARD_TOKEN         Optional token override.
  MERGE_QUEUE_LIVE_DRILL_OUTPUT                Output path. Default: ${DEFAULT_OUTPUT}.
  MERGE_QUEUE_LIVE_DRILL_WORKER_ID             Worker id sent to run-once. Default: ${DEFAULT_WORKER_ID}.
  MERGE_QUEUE_LIVE_DRILL_CONFIRM_EXECUTION=true
                                                Required live execution confirmation.
  MERGE_QUEUE_LIVE_DRILL_ROLLBACK_DRILL_PASSED=true
                                                Required rollback drill sign-off.
  MERGE_QUEUE_LIVE_DRILL_HUMAN_APPROVAL_RECORDED=true
                                                Required human approval sign-off.
  MERGE_QUEUE_LIVE_DRILL_STACK_DEPENDENCY_ORDER_ENFORCED=true
                                                Required staged stack-order proof sign-off.
  MERGE_QUEUE_LIVE_DRILL_STACK_PROOF_REPO        Repo queried for release-readiness proof.
                                                Default: ${DEFAULT_STACK_PROOF_REPO}.
  MERGE_QUEUE_LIVE_DRILL_STACK_PROOF_TARGET_BRANCH
                                                Optional target branch for stack proof.

The token value is never printed. Do not run this against production until the
safe rollout drill has passed and the target queue contains the intended staged
live test pull request. For stack-order proof, use a staged stacked PR child and
record this sign-off only after the steward blocks the child until its parent is
mergeable first. The helper also embeds a release-readiness proof snapshot and
requires it to show the blocked child, next parent, and merge_stack_parents_first
action.
`;
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "Unknown error"}\n`,
  );
  process.exit(1);
});
