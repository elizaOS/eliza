#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BOOLEAN_FIELDS = Object.freeze([
  {
    outputKey: "dryRunPassed",
    envKey: "MERGE_QUEUE_ROLLOUT_EVIDENCE_DRY_RUN_PASSED",
  },
  {
    outputKey: "stagedLiveDrillPassed",
    envKey: "MERGE_QUEUE_ROLLOUT_EVIDENCE_STAGED_LIVE_DRILL_PASSED",
  },
  {
    outputKey: "workerLeaseVerified",
    envKey: "MERGE_QUEUE_ROLLOUT_EVIDENCE_WORKER_LEASE_VERIFIED",
  },
  {
    outputKey: "rollbackDrillPassed",
    envKey: "MERGE_QUEUE_ROLLOUT_EVIDENCE_ROLLBACK_DRILL_PASSED",
  },
  {
    outputKey: "humanApprovalRecorded",
    envKey: "MERGE_QUEUE_ROLLOUT_EVIDENCE_HUMAN_APPROVAL_RECORDED",
  },
]);
const DRILL_JSON_ENV_KEY = "MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON";
const LIVE_DRILL_JSON_ENV_KEY = "MERGE_QUEUE_ROLLOUT_EVIDENCE_LIVE_DRILL_JSON";

const TRUE_PATTERN = /^(?:1|true|yes|on)$/i;
const FALSE_PATTERN = /^(?:0|false|no|off)$/i;

main();

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
      process.stdout.write(usage());
      return;
    }

    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const defaultEnvFile = path.resolve(scriptDir, "..", ".env");
    const envFile = options.envFile ?? process.env.ENV_FILE ?? defaultEnvFile;
    const values = readConfiguration(envFile, process.env);
    const errors = [];
    const drillJsonPath =
      options.drillJson ?? values[DRILL_JSON_ENV_KEY] ?? null;
    const liveDrillJsonPath =
      options.liveDrillJson ?? values[LIVE_DRILL_JSON_ENV_KEY] ?? null;
    const drillEvidence = drillJsonPath
      ? readDrillEvidence(drillJsonPath, errors)
      : null;
    const liveDrillEvidence = liveDrillJsonPath
      ? readLiveDrillEvidence(liveDrillJsonPath, errors)
      : null;
    const mergeQueueRollout = {};

    for (const field of BOOLEAN_FIELDS) {
      const parsed = readBooleanAttestation(values, field.envKey, errors);
      mergeQueueRollout[field.outputKey] = parsed ?? false;
    }

    applyDrillEvidence({
      rollout: mergeQueueRollout,
      drillEvidence,
      drillJsonPath,
      errors,
    });
    applyLiveDrillEvidence({
      rollout: mergeQueueRollout,
      liveDrillEvidence,
      liveDrillJsonPath,
      errors,
    });
    validatePositiveEvidence(mergeQueueRollout, errors);

    if (errors.length > 0) {
      for (const error of errors) {
        console.error(`[merge-queue-rollout-evidence] error: ${error}`);
      }
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      `${JSON.stringify({ mergeQueueRollout: publicRolloutEvidence(mergeQueueRollout) }, null, 2)}\n`,
    );
  } catch (error) {
    console.error(`[merge-queue-rollout-evidence] error: ${error.message}`);
    process.exitCode = 1;
  }
}

function parseArgs(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--env-file") {
      index += 1;
      if (!args[index]) {
        throw new Error("--env-file requires a path");
      }
      options.envFile = args[index];
      continue;
    }

    if (arg.startsWith("--env-file=")) {
      options.envFile = arg.slice("--env-file=".length);
      if (!options.envFile) {
        throw new Error("--env-file requires a path");
      }
      continue;
    }

    if (arg === "--drill-json") {
      index += 1;
      if (!args[index]) {
        throw new Error("--drill-json requires a path");
      }
      options.drillJson = args[index];
      continue;
    }

    if (arg.startsWith("--drill-json=")) {
      options.drillJson = arg.slice("--drill-json=".length);
      if (!options.drillJson) {
        throw new Error("--drill-json requires a path");
      }
      continue;
    }

    if (arg === "--live-drill-json") {
      index += 1;
      if (!args[index]) {
        throw new Error("--live-drill-json requires a path");
      }
      options.liveDrillJson = args[index];
      continue;
    }

    if (arg.startsWith("--live-drill-json=")) {
      options.liveDrillJson = arg.slice("--live-drill-json=".length);
      if (!options.liveDrillJson) {
        throw new Error("--live-drill-json requires a path");
      }
      continue;
    }

    throw new Error(`unknown argument: ${arg}`);
  }

  return options;
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

function inputKeys() {
  return [
    ...BOOLEAN_FIELDS.map((field) => field.envKey),
    DRILL_JSON_ENV_KEY,
    LIVE_DRILL_JSON_ENV_KEY,
  ];
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

function validatePositiveEvidence(rollout, errors) {
  if (rollout.dryRunPassed) {
    requireTruthyDrillEvidence(errors, rollout);
  }

  if (rollout.stagedLiveDrillPassed && !rollout.dryRunPassed) {
    errors.push(
      "MERGE_QUEUE_ROLLOUT_EVIDENCE_STAGED_LIVE_DRILL_PASSED requires dry-run evidence",
    );
  }
  if (rollout.stagedLiveDrillPassed && !rollout.liveDrillEvidence) {
    errors.push(
      `${BOOLEAN_FIELDS[1].envKey}=true requires ${LIVE_DRILL_JSON_ENV_KEY} from a staged live drill`,
    );
  }

  if (rollout.workerLeaseVerified && !rollout.stagedLiveDrillPassed) {
    errors.push(
      "MERGE_QUEUE_ROLLOUT_EVIDENCE_WORKER_LEASE_VERIFIED requires staged live drill evidence",
    );
  }
  if (rollout.workerLeaseVerified && !rollout.liveDrillEvidence) {
    errors.push(
      `${BOOLEAN_FIELDS[2].envKey}=true requires ${LIVE_DRILL_JSON_ENV_KEY} from a staged live drill`,
    );
  }

  if (rollout.rollbackDrillPassed && !rollout.stagedLiveDrillPassed) {
    errors.push(
      "MERGE_QUEUE_ROLLOUT_EVIDENCE_ROLLBACK_DRILL_PASSED requires staged live drill evidence",
    );
  }
  if (rollout.rollbackDrillPassed && !rollout.liveDrillEvidence) {
    errors.push(
      `${BOOLEAN_FIELDS[3].envKey}=true requires ${LIVE_DRILL_JSON_ENV_KEY} from a staged live drill`,
    );
  }

  if (rollout.humanApprovalRecorded && !rollout.stagedLiveDrillPassed) {
    errors.push(
      "MERGE_QUEUE_ROLLOUT_EVIDENCE_HUMAN_APPROVAL_RECORDED requires staged live drill evidence",
    );
  }
  if (rollout.humanApprovalRecorded && !rollout.liveDrillEvidence) {
    errors.push(
      `${BOOLEAN_FIELDS[4].envKey}=true requires ${LIVE_DRILL_JSON_ENV_KEY} from a staged live drill`,
    );
  }
}

function applyDrillEvidence({ rollout, drillEvidence, drillJsonPath, errors }) {
  if (!drillEvidence) return;

  if (drillEvidence.dryRunPassed !== true) {
    errors.push(`${DRILL_JSON_ENV_KEY} did not prove dryRunPassed=true`);
    return;
  }

  const failedChecks = drillEvidence.checks.filter(
    (check) => check.ok !== true,
  );
  if (failedChecks.length > 0) {
    errors.push(`${DRILL_JSON_ENV_KEY} contains failed rollout drill checks`);
    return;
  }

  rollout.dryRunPassed = true;
  rollout.dryRunEvidence = {
    source: drillJsonPath,
    sha256: sha256File(drillJsonPath),
    checkedAt: drillEvidence.checkedAt,
    checkCount: drillEvidence.checks.length,
  };
}

function applyLiveDrillEvidence({
  rollout,
  liveDrillEvidence,
  liveDrillJsonPath,
  errors,
}) {
  if (!liveDrillEvidence) return;

  if (liveDrillEvidence.stagedLiveDrillPassed !== true) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} did not prove stagedLiveDrillPassed=true`,
    );
    return;
  }
  if (liveDrillEvidence.strictWorkReservationsEnforced !== true) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} did not prove strictWorkReservationsEnforced=true`,
    );
    return;
  }
  if (liveDrillEvidence.strictWorkItemsEnforced !== true) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} did not prove strictWorkItemsEnforced=true`,
    );
    return;
  }
  if (liveDrillEvidence.strictAgentBranchNamespacesEnforced !== true) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} did not prove strictAgentBranchNamespacesEnforced=true`,
    );
    return;
  }
  if (liveDrillEvidence.verifiedAgentRunReceiptsEnforced !== true) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} did not prove verifiedAgentRunReceiptsEnforced=true`,
    );
    return;
  }
  if (liveDrillEvidence.agentIdentityRegistryEnforced !== true) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} did not prove agentIdentityRegistryEnforced=true`,
    );
    return;
  }
  if (liveDrillEvidence.stackDependencyOrderEnforced !== true) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} did not prove stackDependencyOrderEnforced=true`,
    );
    return;
  }

  rollout.stagedLiveDrillPassed = true;
  rollout.workerLeaseVerified = liveDrillEvidence.workerLeaseVerified === true;
  rollout.strictWorkReservationsEnforced =
    liveDrillEvidence.strictWorkReservationsEnforced === true;
  rollout.strictWorkItemsEnforced =
    liveDrillEvidence.strictWorkItemsEnforced === true;
  rollout.strictAgentBranchNamespacesEnforced =
    liveDrillEvidence.strictAgentBranchNamespacesEnforced === true;
  rollout.verifiedAgentRunReceiptsEnforced =
    liveDrillEvidence.verifiedAgentRunReceiptsEnforced === true;
  rollout.agentIdentityRegistryEnforced =
    liveDrillEvidence.agentIdentityRegistryEnforced === true;
  rollout.stackDependencyOrderEnforced =
    liveDrillEvidence.stackDependencyOrderEnforced === true;
  rollout.rollbackDrillPassed = liveDrillEvidence.rollbackDrillPassed === true;
  rollout.humanApprovalRecorded =
    liveDrillEvidence.humanApprovalRecorded === true;
  rollout.liveDrillEvidence = {
    source: liveDrillJsonPath,
    sha256: sha256File(liveDrillJsonPath),
    checkedAt: liveDrillEvidence.checkedAt,
    runId: liveDrillEvidence.runId,
  };
}

function requireTruthyDrillEvidence(errors, rollout) {
  if (!rollout.dryRunEvidence) {
    errors.push(
      `${BOOLEAN_FIELDS[0].envKey}=true requires ${DRILL_JSON_ENV_KEY} from merge-queue-rollout-drill.sh`,
    );
  }
}

function publicRolloutEvidence(rollout) {
  return {
    ...Object.fromEntries(
      BOOLEAN_FIELDS.map((field) => [
        field.outputKey,
        rollout[field.outputKey] === true,
      ]),
    ),
    strictWorkReservationsEnforced:
      rollout.strictWorkReservationsEnforced === true,
    strictWorkItemsEnforced: rollout.strictWorkItemsEnforced === true,
    strictAgentBranchNamespacesEnforced:
      rollout.strictAgentBranchNamespacesEnforced === true,
    verifiedAgentRunReceiptsEnforced:
      rollout.verifiedAgentRunReceiptsEnforced === true,
    agentIdentityRegistryEnforced:
      rollout.agentIdentityRegistryEnforced === true,
    stackDependencyOrderEnforced: rollout.stackDependencyOrderEnforced === true,
    dryRunEvidence: rollout.dryRunEvidence ?? null,
    liveDrillEvidence: rollout.liveDrillEvidence ?? null,
  };
}

function readLiveDrillEvidence(filePath, errors) {
  let body;
  try {
    body = readJsonFile(filePath);
  } catch (error) {
    errors.push(`${LIVE_DRILL_JSON_ENV_KEY} is unreadable: ${error.message}`);
    return null;
  }

  const live = body?.mergeQueueRolloutLiveDrill;
  if (!live || typeof live !== "object" || Array.isArray(live)) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} must contain mergeQueueRolloutLiveDrill`,
    );
    return null;
  }

  const runOnce = objectValue(live.runOnce);
  const execution = objectValue(live.execution ?? runOnce.execution);
  const runs = arrayValue(
    runOnce.runs ??
      live.runs ??
      (runOnce.run ? [runOnce.run] : live.run ? [live.run] : []),
  );
  const items = arrayValue(
    runOnce.items ??
      live.items ??
      (runOnce.item ? [runOnce.item] : live.item ? [live.item] : []),
  );
  const executions = arrayValue(execution.executions);
  const events = arrayValue(live.events ?? runOnce.events);
  const readiness = objectValue(live.readiness);
  const readinessConfig = objectValue(readiness.configuration);
  const checkedAt = normalizeIso(live.checkedAt);
  const stagedLiveDrillPassed =
    live.stagedLiveDrillPassed === true &&
    runs.some((run) => run?.status === "succeeded") &&
    items.some((item) => item?.queueState === "merged") &&
    executions.length > 0 &&
    executions.every((entry) => entry?.status === "executed") &&
    events.some((event) => event?.type === "IntegrationActionStarted") &&
    events.some((event) => event?.type === "IntegrationActionFinished");
  const strictWorkReservationsEnforced =
    live.strictWorkReservationsEnforced === true &&
    readinessConfig.requireWorkReservationForAgentPrs === true;
  const strictWorkItemsEnforced =
    live.strictWorkItemsEnforced === true &&
    readinessConfig.requireWorkItemForAgentPrs === true;
  const strictAgentBranchNamespacesEnforced =
    live.strictAgentBranchNamespacesEnforced === true &&
    readinessConfig.requireAgentBranchNamespaceForAgentPrs === true;
  const verifiedAgentRunReceiptsEnforced =
    live.verifiedAgentRunReceiptsEnforced === true &&
    readinessConfig.requireVerifiedAgentRunReceiptForAgentPrs === true;
  const agentIdentityRegistryEnforced =
    live.agentIdentityRegistryEnforced === true &&
    readinessConfig.requireAgentIdentityRegistryForAgentPrs === true &&
    Number(readinessConfig.knownAgentIdCount ?? 0) > 0;
  const stackDependencyOrderProof = objectValue(live.stackDependencyOrderProof);
  const stackDependencyOrderEnforced =
    live.stackDependencyOrderEnforced === true &&
    stackDependencyOrderProof.valid === true &&
    stackDependencyOrderProof.stackCheckStatus === "fail" &&
    Number(stackDependencyOrderProof.stackBlocked ?? 0) > 0 &&
    arrayValue(stackDependencyOrderProof.blockedItemIds).length > 0 &&
    arrayValue(stackDependencyOrderProof.nextMergeItemIds).length > 0 &&
    arrayValue(stackDependencyOrderProof.requiredActions).includes(
      "merge_stack_parents_first",
    );

  if (!checkedAt) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} must include a valid checkedAt timestamp`,
    );
  }
  if (stagedLiveDrillPassed !== true) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} must include a successful staged live run, merged item, executed actions, and action checkpoint events`,
    );
  }
  if (strictWorkReservationsEnforced !== true) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} must prove strict work reservations were enabled in /ready`,
    );
  }
  if (strictWorkItemsEnforced !== true) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} must prove strict Work items were enabled in /ready`,
    );
  }
  if (strictAgentBranchNamespacesEnforced !== true) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} must prove strict agent branch namespaces were enabled in /ready`,
    );
  }
  if (verifiedAgentRunReceiptsEnforced !== true) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} must prove verified agent run receipts were enabled in /ready`,
    );
  }
  if (agentIdentityRegistryEnforced !== true) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} must prove the allowed-agent identity registry was enabled in /ready`,
    );
  }
  if (stackDependencyOrderEnforced !== true) {
    errors.push(
      `${LIVE_DRILL_JSON_ENV_KEY} must prove stack dependency ordering with a release-readiness blocked-child snapshot`,
    );
  }

  return {
    stagedLiveDrillPassed,
    workerLeaseVerified: live.workerLeaseVerified === true,
    strictWorkReservationsEnforced,
    strictWorkItemsEnforced,
    strictAgentBranchNamespacesEnforced,
    verifiedAgentRunReceiptsEnforced,
    agentIdentityRegistryEnforced,
    stackDependencyOrderEnforced,
    rollbackDrillPassed: live.rollbackDrillPassed === true,
    humanApprovalRecorded: live.humanApprovalRecorded === true,
    checkedAt,
    runId: live.runId ?? runs.find((run) => run?.id)?.id ?? null,
  };
}

function readDrillEvidence(filePath, errors) {
  let body;
  try {
    body = readJsonFile(filePath);
  } catch (error) {
    errors.push(`${DRILL_JSON_ENV_KEY} is unreadable: ${error.message}`);
    return null;
  }

  const drill = body?.mergeQueueRolloutDrill;
  if (!drill || typeof drill !== "object" || Array.isArray(drill)) {
    errors.push(`${DRILL_JSON_ENV_KEY} must contain mergeQueueRolloutDrill`);
    return null;
  }

  const checks = Array.isArray(drill.checks) ? drill.checks : [];
  const normalized = {
    dryRunPassed: drill.dryRunPassed === true,
    safeMode: drill.safeMode === true,
    checkedAt: normalizeIso(drill.checkedAt),
    checks: checks.map((check) => ({
      name: typeof check?.name === "string" ? check.name : "",
      ok: check?.ok === true,
    })),
  };

  if (normalized.safeMode !== true) {
    errors.push(
      `${DRILL_JSON_ENV_KEY} must be generated from the safe rollout drill`,
    );
  }
  if (!normalized.checkedAt) {
    errors.push(
      `${DRILL_JSON_ENV_KEY} must include a valid checkedAt timestamp`,
    );
  }
  if (normalized.checks.length === 0) {
    errors.push(`${DRILL_JSON_ENV_KEY} must include rollout drill checks`);
  }

  return normalized;
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

function normalizeIso(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

function readBooleanAttestation(values, key, errors) {
  const parsed = parseBoolean(values[key]);

  if (parsed === undefined) {
    errors.push(`${key} must be true or false when set`);
    return false;
  }

  return parsed;
}

function parseBoolean(value) {
  const normalized = cleanValue(value);

  if (normalized === null) {
    return null;
  }

  if (TRUE_PATTERN.test(normalized)) {
    return true;
  }

  if (FALSE_PATTERN.test(normalized)) {
    return false;
  }

  return undefined;
}

function cleanValue(value) {
  if (value === undefined || value === null) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

function usage() {
  return `Usage: merge-queue-rollout-evidence.mjs [--env-file PATH] [--drill-json PATH] [--live-drill-json PATH]

Prints a production evidence mergeQueueRollout block as JSON.

Inputs are read from ENV_FILE, then explicit environment variables override the
same keys. The env file is parsed as data and is not sourced.

Dry-run evidence is inferred from MERGE_QUEUE_ROLLOUT_EVIDENCE_DRILL_JSON, which
must point at the JSON fragment produced by merge-queue-rollout-drill.sh with
MERGE_QUEUE_ROLLOUT_EVIDENCE_OUT.

Staged live drill, worker lease, strict work-reservation, strict Work items,
branch namespace, verified run receipt, agent identity registry, stack
dependency order, rollback, and human approval
evidence are inferred from
MERGE_QUEUE_ROLLOUT_EVIDENCE_LIVE_DRILL_JSON.
That file must contain mergeQueueRolloutLiveDrill with
strictWorkReservationsEnforced=true, strictWorkItemsEnforced=true,
strictAgentBranchNamespacesEnforced=true, verifiedAgentRunReceiptsEnforced=true,
agentIdentityRegistryEnforced=true, stackDependencyOrderEnforced=true, a
stackDependencyOrderProof release-readiness
snapshot with a blocked child, next merge parent, and merge_stack_parents_first
action, /ready enforcement for all five runtime policies, a successful run,
merged item, executed integration actions, and IntegrationActionStarted/Finished
run events.

Operator attestations default to false unless set:
  MERGE_QUEUE_ROLLOUT_EVIDENCE_DRY_RUN_PASSED
  MERGE_QUEUE_ROLLOUT_EVIDENCE_STAGED_LIVE_DRILL_PASSED
  MERGE_QUEUE_ROLLOUT_EVIDENCE_WORKER_LEASE_VERIFIED
  MERGE_QUEUE_ROLLOUT_EVIDENCE_ROLLBACK_DRILL_PASSED
  MERGE_QUEUE_ROLLOUT_EVIDENCE_HUMAN_APPROVAL_RECORDED
`;
}
