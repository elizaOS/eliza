#!/usr/bin/env node

/**
 * Staging-only Railway reconciliation for the Gateway webhook transaction.
 *
 * The exported state machine accepts injected clients so every failure boundary
 * can be simulated without invoking Railway or GitHub. The CLI adapters below
 * are intentionally thin and keep all provider mutations behind the durable
 * journal and exact-current-develop checks.
 */

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import {
  decryptCandidateEnvelope,
  GitHubApi,
  httpStatusForDiagnostic,
  main as journalMain,
  parseJsonWithUniqueObjectKeys,
  providerDeploymentIdDigest,
  RedactedActionError,
  readJournalState,
  writeRedactedActionAnnotation,
  writeRedactedActionFailure,
} from "./gateway-webhook-transaction-journal.mjs";

const execFile = promisify(execFileCallback);
const UUID =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SNAPSHOT = /^[0-9A-Za-z_-]{8,256}$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const TERMINAL = new Set([
  "SUCCESS",
  "FAILED",
  "CRASHED",
  "REMOVED",
  "SLEEPING",
  "SKIPPED",
  "CANCELED",
  "CANCELLED",
]);
const NONTERMINAL = new Set([
  "BUILDING",
  "DEPLOYING",
  "INITIALIZING",
  "REMOVING",
  "WAITING",
  "QUEUED",
]);
const READY = new Set(["SUCCESS", "SLEEPING"]);
const RESTORATION_DIGEST_DOMAIN = "gateway-webhook-restoration-id-v1\0";
const ACTIVE_TOPOLOGY_DIGEST_DOMAIN = "gateway-webhook-active-topology-v1\0";
const RECEIPT_SEMANTIC_DIGEST_DOMAIN =
  "gateway-webhook-deployment-receipt-v1\0";
const PLAN_FILES = [
  "deployment-baseline.json",
  "prior-active-deployments.json",
  "rollback-plan.json",
];
const RECEIPT_FILE = "gateway-webhook-deployment.json";
const MAX_RECEIPT_ARCHIVE_BYTES = 2_000_000;
const MAX_RECEIPT_BYTES = 2_000_000;
const SOURCE_SETTLEMENT_SECONDS = 600;
const SOURCE_TERMINAL_CONCLUSIONS = new Set([
  "success",
  "failure",
  "cancelled",
  "timed_out",
]);
// An intent may be created before the final provider/scope reads complete. Keep
// the irreversible call close to that durable timestamp, then wait an extra
// full provider-settlement horizon before a later run may classify a lost ACK.
const ROLLBACK_CALL_MAX_DELAY_SECONDS = 60;
const ROLLBACK_MUTATION_TIMEOUT_SECONDS = 30;
const ROLLBACK_PROVIDER_SETTLEMENT_SECONDS = 600;
const ROLLBACK_SETTLEMENT_SECONDS =
  ROLLBACK_CALL_MAX_DELAY_SECONDS +
  ROLLBACK_MUTATION_TIMEOUT_SECONDS +
  ROLLBACK_PROVIDER_SETTLEMENT_SECONDS;
const MAX_ROLLBACK_ATTEMPTS = 2;

function observedStatusMatches(observedStatus, currentStatus) {
  return (
    observedStatus === currentStatus ||
    (READY.has(observedStatus) && READY.has(currentStatus))
  );
}

function fail(message, diagnosticClass = "fail-closed-validation") {
  throw new RedactedActionError(message, diagnosticClass);
}

export function writeReconcileFailureAnnotation(stream, error) {
  return writeRedactedActionFailure(stream, "gateway-webhook-reconcile", error);
}

export function writeReconcileWarningAnnotation(stream, diagnosticClass) {
  return writeRedactedActionAnnotation(
    stream,
    "warning",
    "gateway-webhook-reconcile",
    diagnosticClass,
  );
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonical(value));
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function parseUniqueJson(text, failureMessage) {
  try {
    return parseJsonWithUniqueObjectKeys(text);
  } catch {
    fail(failureMessage);
  }
}

function isSuccessfulGraphqlEnvelope(payload) {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      (!Object.hasOwn(payload, "errors") ||
        (Array.isArray(payload.errors) && payload.errors.length === 0)) &&
      payload.data &&
      typeof payload.data === "object" &&
      !Array.isArray(payload.data),
  );
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function deploymentReceiptSemanticDigest(receipt) {
  return createHash("sha256")
    .update(RECEIPT_SEMANTIC_DIGEST_DOMAIN)
    .update(canonicalJson(receipt))
    .digest("hex");
}

function journalPlanPlaintextDigest(files) {
  const payload = {
    version: 1,
    files: PLAN_FILES.map((name) => {
      const bytes = files.get(name);
      if (!Buffer.isBuffer(bytes)) {
        fail(`rollback-plan file ${name} is absent from the exact manifest`);
      }
      return {
        name,
        sha256: sha256(bytes),
        content: bytes.toString("base64"),
      };
    }),
  };
  return sha256(Buffer.from(JSON.stringify(payload), "utf8"));
}

export function restorationIdDigest(id) {
  if (!UUID.test(id)) fail("restoration deployment identity is malformed");
  return createHash("sha256")
    .update(RESTORATION_DIGEST_DOMAIN)
    .update(id)
    .digest("hex");
}

function statusClass(status) {
  if (TERMINAL.has(status)) return "terminal";
  if (NONTERMINAL.has(status)) return "nonterminal";
  fail("Railway returned an unsupported deployment status");
}

function validateDeployment(
  deployment,
  scope,
  { allowNullSnapshot = false } = {},
) {
  if (
    !deployment ||
    !UUID.test(deployment.id ?? "") ||
    deployment.projectId !== scope.projectId ||
    deployment.environmentId !== scope.environmentId ||
    deployment.serviceId !== scope.serviceId ||
    typeof deployment.status !== "string" ||
    !(
      (allowNullSnapshot && deployment.snapshotId === null) ||
      SNAPSHOT.test(deployment.snapshotId ?? "")
    ) ||
    !Object.hasOwn(deployment, "deploymentStopped") ||
    ![true, false, null].includes(deployment.deploymentStopped ?? null) ||
    !(
      deployment.meta === null ||
      (typeof deployment.meta === "object" && !Array.isArray(deployment.meta))
    )
  ) {
    fail("Railway deployment readback is malformed or outside the exact scope");
  }
  statusClass(deployment.status);
  return deployment;
}

function validateHistoryRow(row) {
  if (
    !row ||
    !UUID.test(row.id ?? "") ||
    typeof row.createdAt !== "string" ||
    !Number.isFinite(Date.parse(row.createdAt)) ||
    typeof row.status !== "string" ||
    !(
      row.meta === null ||
      (typeof row.meta === "object" && !Array.isArray(row.meta))
    )
  ) {
    fail("Railway deployment-history row is malformed");
  }
  statusClass(row.status);
  return row;
}

function validateActive(active, scope) {
  if (!Array.isArray(active))
    fail("Railway active deployment readback is malformed");
  const ids = new Set();
  for (const deployment of active) {
    validateDeployment(deployment, scope);
    if (ids.has(deployment.id))
      fail("Railway active deployment identity is duplicated");
    ids.add(deployment.id);
  }
  return active;
}

function exactSoleActive(active, predicate) {
  return (
    active.length === 1 &&
    READY.has(active[0].status) &&
    active[0].deploymentStopped === false &&
    predicate(active[0])
  );
}

export function validatePlanBundle(config, bundle) {
  const { plan, baseline, priorActive, digests } = bundle;
  if (
    !plan ||
    plan.version !== 1 ||
    plan.repository !== config.repository ||
    plan.environment !== "staging" ||
    plan.sourceSha !== config.sourceSha ||
    String(plan.workflowRunId) !== config.sourceRunId ||
    String(plan.workflowRunAttempt) !== config.sourceRunAttempt ||
    plan.railwayProjectId !== config.scope.projectId ||
    plan.railwayEnvironmentId !== config.scope.environmentId ||
    plan.railwayServiceId !== config.scope.serviceId ||
    plan.railwayServiceName !== config.scope.serviceName ||
    !UUID.test(plan.priorActiveDeploymentId ?? "") ||
    !SNAPSHOT.test(plan.priorSnapshotId ?? "") ||
    !/^[0-9a-f]{32}$/.test(plan.deploymentNonce ?? "") ||
    plan.expectedDeploymentMessage !==
      `gateway-webhook ${config.sourceSha} (staging) run:${config.sourceRunId}:${config.sourceRunAttempt} nonce:${plan.deploymentNonce}` ||
    plan.deploymentBaselineSha256 !== digests.baseline ||
    plan.priorActiveDeploymentsSha256 !== digests.priorActive ||
    !DIGEST.test(digests.journalPlanPlaintext ?? "")
  ) {
    fail("immutable rollback plan identity or digest validation failed");
  }
  if (!Array.isArray(baseline) || baseline.length === 0) {
    fail("immutable Railway baseline is empty or malformed");
  }
  const baselineIds = new Set();
  for (const row of baseline) {
    validateHistoryRow(row);
    if (statusClass(row.status) !== "terminal")
      fail("immutable Railway baseline contains a nonterminal deployment");
    if (baselineIds.has(row.id))
      fail("immutable Railway baseline contains duplicate ids");
    baselineIds.add(row.id);
  }
  if (
    !baselineIds.has(plan.priorActiveDeploymentId) ||
    baseline.filter(
      (row) => row.id === plan.priorActiveDeploymentId && READY.has(row.status),
    ).length !== 1
  ) {
    fail(
      "immutable Railway baseline does not contain the successful prior deployment",
    );
  }
  const instance = priorActive?.data?.serviceInstance;
  if (
    !isSuccessfulGraphqlEnvelope(priorActive) ||
    instance?.environmentId !== config.scope.environmentId ||
    instance?.serviceId !== config.scope.serviceId ||
    instance?.serviceName !== config.scope.serviceName ||
    !Array.isArray(instance?.activeDeployments)
  ) {
    fail("immutable prior-active proof is malformed");
  }
  validateActive(instance.activeDeployments, config.scope);
  if (
    !exactSoleActive(
      instance.activeDeployments,
      (deployment) =>
        deployment.id === plan.priorActiveDeploymentId &&
        deployment.snapshotId === plan.priorSnapshotId,
    )
  ) {
    fail("immutable prior-active proof does not match the rollback plan");
  }
  return { ...bundle, baselineIds };
}

export async function verifySourcePreMutationSnapshot(
  config,
  bundle,
  dependencies,
) {
  const validated = validatePlanBundle(config, bundle);
  const readHistory = async () => {
    const history = await dependencies.railway.listDeployments();
    if (!Array.isArray(history) || history.length === 0)
      fail("pre-upload Railway deployment history is empty");
    const rows = history.map(validateHistoryRow);
    const ids = new Set(rows.map((row) => row.id));
    if (ids.size !== rows.length)
      fail("pre-upload Railway deployment history contains duplicate ids");
    if (
      ids.size !== validated.baselineIds.size ||
      [...validated.baselineIds].some((id) => !ids.has(id))
    ) {
      fail("Railway deployment history changed after the immutable baseline");
    }
    if (rows.some((row) => statusClass(row.status) !== "terminal")) {
      fail("pre-upload Railway deployment history contains a nonterminal row");
    }
    return rows.sort((left, right) => left.id.localeCompare(right.id));
  };
  const first = await readHistory();
  await dependencies.sleep(5_000);
  const second = await readHistory();
  if (canonicalJson(first) !== canonicalJson(second)) {
    fail("pre-upload Railway deployment history did not remain stable");
  }
  const active = validateActive(
    await dependencies.railway.getActiveDeployments(),
    config.scope,
  );
  if (
    !exactSoleActive(
      active,
      (deployment) =>
        deployment.id === validated.plan.priorActiveDeploymentId &&
        deployment.snapshotId === validated.plan.priorSnapshotId,
    )
  ) {
    fail("exact active Railway baseline changed before upload");
  }
  const priorRows = second.filter(
    (row) => row.id === validated.plan.priorActiveDeploymentId,
  );
  if (
    priorRows.length !== 1 ||
    priorRows[0].status !== active[0].status ||
    !READY.has(priorRows[0].status)
  ) {
    fail("pre-upload Railway history and active prior deployment disagree");
  }
  return {
    deploymentCount: second.length,
    priorActiveDeploymentIdSha256: providerDeploymentIdDigest(active[0].id),
  };
}

export function validateJournalState(config, state, bundle) {
  const expectedPlanArtifactName = `gateway-webhook-rollback-plan-staging-${config.sourceRunId}-${config.sourceRunAttempt}`;
  if (
    state?.status !== "open" ||
    state.open?.repository !== config.repository ||
    state.open?.environment !== "staging" ||
    state.open?.sourceSha !== config.sourceSha ||
    state.open?.sourceRunId !== config.sourceRunId ||
    state.open?.sourceRunAttempt !== config.sourceRunAttempt ||
    state.open?.commentId !== config.openRecordId ||
    !DIGEST.test(state.open.commentId ?? "") ||
    state.open?.planArtifactName !== expectedPlanArtifactName ||
    state.open?.planArtifactId !== config.planArtifactId ||
    state.open?.planArtifactDigest !== config.planArtifactDigest ||
    state.open?.journalPlanPlaintextSha256 !==
      bundle?.digests?.journalPlanPlaintext ||
    !DIGEST.test(state.open?.journalPlanPlaintextSha256 ?? "") ||
    !Array.isArray(state.rollbackIntents) ||
    !Array.isArray(state.rollbackObservations) ||
    !Array.isArray(state.rollbackIntentCreatedAts) ||
    state.rollbackIntents.length > MAX_ROLLBACK_ATTEMPTS ||
    state.rollbackObservations.length > state.rollbackIntents.length ||
    state.rollbackIntents.length - state.rollbackObservations.length > 1 ||
    state.rollbackIntentCreatedAts.length !== state.rollbackIntents.length ||
    state.rollbackIntentCreatedAts.some(
      (createdAt) =>
        typeof createdAt !== "string" ||
        !Number.isFinite(Date.parse(createdAt)),
    ) ||
    state.rollbackIntents.some(
      (intent, index) =>
        intent?.ordinal !== index + 1 ||
        !Array.isArray(intent.providerDeploymentIdWatermarkSha256) ||
        intent.providerDeploymentIdWatermarkSha256.length < 1 ||
        intent.providerDeploymentIdWatermarkSha256.length >
          MAX_ROLLBACK_ATTEMPTS + 1 ||
        intent.providerDeploymentIdWatermarkSha256.some(
          (digest) => !DIGEST.test(digest),
        ) ||
        new Set(intent.providerDeploymentIdWatermarkSha256).size !==
          intent.providerDeploymentIdWatermarkSha256.length ||
        canonicalJson(intent.providerDeploymentIdWatermarkSha256) !==
          canonicalJson(
            [...intent.providerDeploymentIdWatermarkSha256].sort(),
          ) ||
        !DIGEST.test(intent.providerActiveTopologySha256 ?? ""),
    ) ||
    state.rollbackObservations.some(
      (observation, index) => observation?.ordinal !== index + 1,
    ) ||
    state.rollbackObservations.filter((observation) =>
      READY.has(observation?.status),
    ).length > 1
  ) {
    fail("durable journal no longer binds the exact staging transaction");
  }
  return state;
}

export function validateDeploymentReceipt(config, plan, receipt, candidateId) {
  const keys = [
    "credentialProof",
    "deploymentId",
    "environment",
    "expectedDeploymentMessage",
    "openCommentId",
    "redisBackend",
    "reminderAuthorityReadiness",
    "rollbackPlanArtifactDigest",
    "rollbackPlanArtifactId",
    "service",
    "sourceSha",
    "telegramIdentity",
    "telegramProviderSmoke",
    "telegramProviderWebhookSecret",
    "workflowRunAttempt",
    "workflowRunId",
  ];
  return Boolean(
    exactKeys(receipt, keys) &&
      receipt.sourceSha === config.sourceSha &&
      receipt.environment === "staging" &&
      receipt.deploymentId === candidateId &&
      receipt.service === config.scope.serviceName &&
      String(receipt.workflowRunId) === config.sourceRunId &&
      String(receipt.workflowRunAttempt) === config.sourceRunAttempt &&
      receipt.expectedDeploymentMessage === plan.expectedDeploymentMessage &&
      String(receipt.rollbackPlanArtifactId) === config.planArtifactId &&
      receipt.rollbackPlanArtifactDigest === config.planArtifactDigest &&
      receipt.openCommentId === config.openRecordId &&
      receipt.telegramIdentity === "credential-attested" &&
      receipt.telegramProviderWebhookSecret === "requires-ingress-proof" &&
      receipt.telegramProviderSmoke === "unproven" &&
      receipt.reminderAuthorityReadiness === "attested" &&
      receipt.redisBackend === "distributed" &&
      DIGEST.test(receipt.credentialProof ?? "") &&
      config.receiptSemanticDigest === deploymentReceiptSemanticDigest(receipt),
  );
}

function expectedReceiptArtifactName(config) {
  return `gateway-webhook-deployment-staging-${config.sourceSha}-${config.sourceRunId}-${config.sourceRunAttempt}`;
}

function validateExactSourceRun(
  config,
  sourceRun,
  nowMilliseconds,
  failureMessage = "exact source workflow attempt is not durably terminal",
) {
  const completedAt = Date.parse(sourceRun?.completed_at ?? "");
  if (
    !Number.isFinite(nowMilliseconds) ||
    !Number.isSafeInteger(config.sourceDeployCompletedEpoch) ||
    config.sourceDeployCompletedEpoch <= 0 ||
    String(sourceRun?.id) !== config.sourceRunId ||
    String(sourceRun?.run_attempt) !== config.sourceRunAttempt ||
    sourceRun?.head_sha !== config.sourceSha ||
    sourceRun?.head_branch !== "develop" ||
    sourceRun?.head_repository?.full_name !== config.repository ||
    sourceRun?.path !== ".github/workflows/deploy-gateway-webhook.yml" ||
    sourceRun?.event !== "workflow_dispatch" ||
    sourceRun?.status !== "completed" ||
    !SOURCE_TERMINAL_CONCLUSIONS.has(sourceRun?.conclusion) ||
    !Number.isFinite(completedAt) ||
    completedAt > nowMilliseconds ||
    Math.floor(completedAt / 1_000) !== config.sourceDeployCompletedEpoch
  ) {
    fail(failureMessage);
  }
  return sourceRun;
}

async function attestExactSourceRun(config, dependencies) {
  if (typeof dependencies.sourceRun?.read !== "function") {
    fail("exact source workflow attempt readback is unavailable");
  }
  let sourceRun;
  try {
    sourceRun = await dependencies.sourceRun.read();
  } catch (error) {
    if (error instanceof RedactedActionError) throw error;
    fail(
      "GitHub source workflow metadata request failed",
      "github-api-request-failure",
    );
  }
  return validateExactSourceRun(config, sourceRun, dependencies.wallNow());
}

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function receiptBytesFromArchive(archiveBytes) {
  const minimumEocdOffset = Math.max(0, archiveBytes.length - 65_557);
  let eocdOffset = -1;
  for (
    let offset = archiveBytes.length - 22;
    offset >= minimumEocdOffset;
    offset -= 1
  ) {
    if (archiveBytes.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (
    eocdOffset < 0 ||
    archiveBytes.readUInt16LE(eocdOffset + 4) !== 0 ||
    archiveBytes.readUInt16LE(eocdOffset + 6) !== 0 ||
    archiveBytes.readUInt16LE(eocdOffset + 8) !== 1 ||
    archiveBytes.readUInt16LE(eocdOffset + 10) !== 1 ||
    eocdOffset + 22 + archiveBytes.readUInt16LE(eocdOffset + 20) !==
      archiveBytes.length
  ) {
    fail("GitHub receipt artifact archive has an unsafe file manifest");
  }
  const centralSize = archiveBytes.readUInt32LE(eocdOffset + 12);
  const centralOffset = archiveBytes.readUInt32LE(eocdOffset + 16);
  if (
    centralOffset + centralSize !== eocdOffset ||
    centralSize < 46 ||
    archiveBytes.readUInt32LE(centralOffset) !== 0x02014b50
  ) {
    fail("GitHub receipt artifact archive is malformed");
  }
  const flags = archiveBytes.readUInt16LE(centralOffset + 8);
  const method = archiveBytes.readUInt16LE(centralOffset + 10);
  const expectedCrc = archiveBytes.readUInt32LE(centralOffset + 16);
  const compressedSize = archiveBytes.readUInt32LE(centralOffset + 20);
  const uncompressedSize = archiveBytes.readUInt32LE(centralOffset + 24);
  const nameLength = archiveBytes.readUInt16LE(centralOffset + 28);
  const extraLength = archiveBytes.readUInt16LE(centralOffset + 30);
  const commentLength = archiveBytes.readUInt16LE(centralOffset + 32);
  const localOffset = archiveBytes.readUInt32LE(centralOffset + 42);
  const centralEnd =
    centralOffset + 46 + nameLength + extraLength + commentLength;
  const name = archiveBytes
    .subarray(centralOffset + 46, centralOffset + 46 + nameLength)
    .toString("utf8");
  if (
    centralEnd !== centralOffset + centralSize ||
    name !== RECEIPT_FILE ||
    (flags & 1) !== 0 ||
    ![0, 8].includes(method) ||
    compressedSize <= 0 ||
    uncompressedSize <= 0 ||
    uncompressedSize > MAX_RECEIPT_BYTES ||
    localOffset + 30 > centralOffset ||
    archiveBytes.readUInt32LE(localOffset) !== 0x04034b50
  ) {
    fail("GitHub receipt artifact archive has an unsafe file manifest");
  }
  const localFlags = archiveBytes.readUInt16LE(localOffset + 6);
  const localMethod = archiveBytes.readUInt16LE(localOffset + 8);
  const localNameLength = archiveBytes.readUInt16LE(localOffset + 26);
  const localExtraLength = archiveBytes.readUInt16LE(localOffset + 28);
  const localName = archiveBytes
    .subarray(localOffset + 30, localOffset + 30 + localNameLength)
    .toString("utf8");
  const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
  const dataEnd = dataOffset + compressedSize;
  if (
    localName !== RECEIPT_FILE ||
    localFlags !== flags ||
    localMethod !== method ||
    dataEnd > centralOffset
  ) {
    fail("GitHub receipt artifact local file header is inconsistent");
  }
  let receiptBytes;
  try {
    const compressed = archiveBytes.subarray(dataOffset, dataEnd);
    receiptBytes =
      method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: MAX_RECEIPT_BYTES });
  } catch {
    fail("GitHub receipt artifact file failed authenticated extraction");
  }
  if (
    receiptBytes.length !== uncompressedSize ||
    receiptBytes.length > MAX_RECEIPT_BYTES ||
    crc32(receiptBytes) !== expectedCrc
  ) {
    fail("GitHub receipt artifact file size changed during extraction");
  }
  return receiptBytes;
}

export function validateReceiptArtifactAttestation(
  config,
  attestation,
  nowMilliseconds,
) {
  if (
    !POSITIVE_INTEGER.test(config.receiptArtifactId ?? "") ||
    !DIGEST.test(config.receiptArtifactDigest ?? "")
  ) {
    fail("deployment receipt artifact identity is malformed");
  }
  const { artifact, sourceRun, archiveBytes } = attestation ?? {};
  if (
    !Number.isFinite(nowMilliseconds) ||
    !Buffer.isBuffer(archiveBytes) ||
    archiveBytes.length === 0 ||
    archiveBytes.length > MAX_RECEIPT_ARCHIVE_BYTES ||
    String(artifact?.id) !== config.receiptArtifactId ||
    artifact?.name !== expectedReceiptArtifactName(config) ||
    artifact?.expired !== false ||
    String(artifact?.workflow_run?.id) !== config.sourceRunId ||
    artifact?.workflow_run?.head_sha !== config.sourceSha ||
    String(artifact?.digest ?? "").replace(/^sha256:/, "") !==
      config.receiptArtifactDigest ||
    typeof artifact?.expires_at !== "string" ||
    !Number.isFinite(Date.parse(artifact.expires_at)) ||
    Date.parse(artifact.expires_at) <= nowMilliseconds ||
    sha256(archiveBytes) !== config.receiptArtifactDigest
  ) {
    fail(
      "deployment receipt artifact is not an unexpired exact-source GitHub artifact",
    );
  }
  validateExactSourceRun(
    config,
    sourceRun,
    nowMilliseconds,
    "deployment receipt artifact is not an unexpired exact-source GitHub artifact",
  );
  const receiptBytes = receiptBytesFromArchive(archiveBytes);
  const receipt = parseUniqueJson(
    receiptBytes.toString("utf8"),
    "authoritative deployment receipt is not strict JSON",
  );
  const semanticDigest = deploymentReceiptSemanticDigest(receipt);
  return {
    receipt,
    receiptBytesSha256: sha256(receiptBytes),
    receiptSemanticDigest: semanticDigest,
  };
}

async function readSnapshot(config, bundle, state, candidateId, railway) {
  const history = await railway.listDeployments();
  if (!Array.isArray(history) || history.length === 0) {
    fail("complete Railway deployment history is empty");
  }
  const rows = history.map(validateHistoryRow);
  const ids = new Set(rows.map((row) => row.id));
  if (ids.size !== rows.length)
    fail("complete Railway deployment history contains duplicate ids");
  for (const baselineId of bundle.baselineIds) {
    if (!ids.has(baselineId)) {
      fail(
        "complete Railway history no longer contains the immutable baseline",
      );
    }
  }
  const baselineRows = rows.filter((row) => bundle.baselineIds.has(row.id));
  if (baselineRows.some((row) => statusClass(row.status) !== "terminal")) {
    fail("complete Railway baseline contains a nonterminal deployment");
  }
  const postRows = rows.filter((row) => !bundle.baselineIds.has(row.id));
  const deployments = new Map();
  for (const row of postRows) {
    const exact = validateDeployment(
      await railway.getDeployment(row.id),
      config.scope,
      {
        allowNullSnapshot: true,
      },
    );
    if (exact.status !== row.status) {
      fail("Railway history and exact deployment status disagree");
    }
    deployments.set(row.id, { ...exact, createdAt: row.createdAt });
  }
  const prior = validateDeployment(
    await railway.getDeployment(bundle.plan.priorActiveDeploymentId),
    config.scope,
  );
  if (prior.snapshotId !== bundle.plan.priorSnapshotId) {
    fail("Railway no longer proves the immutable prior deployment snapshot");
  }
  const priorRow = baselineRows.find(
    (row) => row.id === bundle.plan.priorActiveDeploymentId,
  );
  if (
    !priorRow ||
    priorRow.status !== prior.status ||
    statusClass(prior.status) !== "terminal"
  ) {
    fail(
      "Railway prior deployment history/status is nonterminal or inconsistent",
    );
  }
  if (candidateId && !deployments.has(candidateId)) {
    fail("durable candidate is absent from the complete Railway history");
  }
  const active = validateActive(
    await railway.getActiveDeployments(),
    config.scope,
  );
  const restorations = [];
  const unknown = [];
  for (const row of postRows) {
    const exact = deployments.get(row.id);
    if (
      row.id === candidateId ||
      (candidateId === null &&
        exact?.meta?.commitMessage === bundle.plan.expectedDeploymentMessage)
    ) {
      if (
        exact?.meta?.commitMessage !== bundle.plan.expectedDeploymentMessage
      ) {
        fail("nonce-bound candidate lost its exact deployment-message binding");
      }
      continue;
    }
    if (
      state.rollbackIntents.length > 0 &&
      exact?.snapshotId === bundle.plan.priorSnapshotId
    ) {
      restorations.push(exact);
    } else {
      unknown.push(exact);
    }
  }
  if (unknown.length > 0) {
    fail("post-baseline Railway history contains an unattributed deployment");
  }
  if (restorations.length > state.rollbackIntents.length) {
    fail(
      "Railway history contains more restorations than durable rollback intents",
    );
  }
  const exactById = new Map(deployments);
  exactById.set(prior.id, prior);
  const attributableIds = new Set([
    prior.id,
    ...candidateIds({ postRows }, bundle.plan.expectedDeploymentMessage),
    ...restorations.map((deployment) => deployment.id),
  ]);
  if (active.length === 0) {
    fail("Railway active deployment topology is empty");
  }
  for (const deployment of active) {
    const exact = exactById.get(deployment.id);
    if (
      !ids.has(deployment.id) ||
      !attributableIds.has(deployment.id) ||
      !exact ||
      canonicalJson(deployment) !==
        canonicalJson({
          id: exact.id,
          projectId: exact.projectId,
          environmentId: exact.environmentId,
          serviceId: exact.serviceId,
          snapshotId: exact.snapshotId,
          status: exact.status,
          deploymentStopped: exact.deploymentStopped,
          meta: exact.meta,
        })
    ) {
      fail(
        "Railway active deployment is absent from or unattributed by the complete history",
      );
    }
  }
  return {
    active,
    candidate: candidateId ? deployments.get(candidateId) : null,
    history: rows,
    postRows,
    restorations,
  };
}

async function stableSnapshot(
  config,
  bundle,
  state,
  candidateId,
  dependencies,
) {
  const first = await readSnapshot(
    config,
    bundle,
    state,
    candidateId,
    dependencies.railway,
  );
  await dependencies.sleep(5_000);
  const second = await readSnapshot(
    config,
    bundle,
    state,
    candidateId,
    dependencies.railway,
  );
  if (canonicalJson(first) !== canonicalJson(second)) {
    fail("Railway topology did not remain stable across exhaustive reads");
  }
  return second;
}

function candidateIds(snapshot, expectedMessage) {
  return snapshot.postRows
    .filter((row) => row?.meta?.commitMessage === expectedMessage)
    .map((row) => row.id);
}

function candidateIsTerminal(snapshot) {
  return (
    snapshot.candidate && statusClass(snapshot.candidate.status) === "terminal"
  );
}

function allAttributableRowsTerminal(snapshot) {
  return snapshot.postRows.every(
    (row) => statusClass(row.status) === "terminal",
  );
}

function solePrior(snapshot, plan) {
  return exactSoleActive(
    snapshot.active,
    (deployment) => deployment.snapshotId === plan.priorSnapshotId,
  );
}

function soleCandidate(snapshot, candidateId) {
  return exactSoleActive(
    snapshot.active,
    (deployment) => deployment.id === candidateId,
  );
}

function restorationForObservation(observation, snapshot) {
  if (observation.restorationIdSha256 === null) return null;
  const digest = observation.restorationIdSha256;
  const matches = snapshot.restorations.filter(
    (deployment) => restorationIdDigest(deployment.id) === digest,
  );
  if (matches.length !== 1) {
    fail(
      "durable rollback observation does not identify one exact restoration",
    );
  }
  return matches[0];
}

function providerWatermark(snapshot) {
  return snapshot.postRows
    .map((deployment) => providerDeploymentIdDigest(deployment.id))
    .sort();
}

function activeTopologyDigest(snapshot) {
  const topology = snapshot.active
    .map((deployment) => ({
      deploymentStopped: deployment.deploymentStopped,
      id: deployment.id,
      snapshotId: deployment.snapshotId,
      status: deployment.status,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256")
    .update(ACTIVE_TOPOLOGY_DIGEST_DOMAIN)
    .update(canonicalJson(topology))
    .digest("hex");
}

function sameProviderWatermark(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function restorationsWithoutObservation(state, snapshot) {
  const observed = new Set(
    state.rollbackObservations
      .map((observation) => observation.restorationIdSha256)
      .filter(Boolean),
  );
  return snapshot.restorations.filter(
    (deployment) => !observed.has(restorationIdDigest(deployment.id)),
  );
}

function rollbackAttempts(state, snapshot) {
  return state.rollbackObservations.map((observation) => {
    const restoration = restorationForObservation(observation, snapshot);
    return {
      ordinal: observation.ordinal,
      restorationDeploymentId: restoration?.id ?? null,
      status: observation.status,
    };
  });
}

function resolution(
  config,
  bundle,
  state,
  snapshot,
  result,
  candidateId,
  active,
) {
  return {
    version: 1,
    result,
    repository: config.repository,
    sourceSha: config.sourceSha,
    environment: "staging",
    workflowRunId: config.sourceRunId,
    workflowRunAttempt: config.sourceRunAttempt,
    recoveryWorkflowRunId: config.recoveryRunId,
    recoveryWorkflowRunAttempt: config.recoveryRunAttempt,
    rollbackPlanArtifactId: config.planArtifactId,
    rollbackPlanArtifactDigest: config.planArtifactDigest,
    openCommentId: config.openRecordId,
    receiptArtifactId: config.receiptArtifactId ?? null,
    receiptArtifactDigest: config.receiptArtifactDigest ?? null,
    receiptSemanticDigest: config.receiptSemanticDigest ?? null,
    priorSnapshotId: bundle.plan.priorSnapshotId,
    candidateDeploymentId: candidateId,
    observedActiveDeploymentId: active?.id ?? null,
    observedActiveSnapshotId: active?.snapshotId ?? null,
    rollbackAttempts: rollbackAttempts(state, snapshot),
  };
}

async function waitForMonotonicHorizon(
  dependencies,
  invocationStartedAt,
  durationMilliseconds,
) {
  for (;;) {
    const elapsed = dependencies.monotonicNow() - invocationStartedAt;
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      fail("monotonic reconciliation clock is malformed");
    }
    if (elapsed >= durationMilliseconds) return;
    await dependencies.sleep(Math.min(15_000, durationMilliseconds - elapsed));
  }
}

async function waitForSourceSettlement(dependencies, invocationStartedAt) {
  await waitForMonotonicHorizon(
    dependencies,
    invocationStartedAt,
    SOURCE_SETTLEMENT_SECONDS * 1_000,
  );
}

async function assertPreMutation(
  config,
  expectedIntentRecordId,
  candidateId,
  bundle,
  dependencies,
) {
  await dependencies.authority.assertCurrentDevelop();
  const current = validateJournalState(
    config,
    await dependencies.journal.read(),
    bundle,
  );
  if (
    current.rollbackIntents.length < 1 ||
    current.rollbackIntents.length > MAX_ROLLBACK_ATTEMPTS ||
    current.rollbackObservations.length !==
      current.rollbackIntents.length - 1 ||
    current.rollbackIntent?.commentId !== expectedIntentRecordId ||
    current.rollbackObservations.some((observation) =>
      READY.has(observation.status),
    )
  ) {
    fail(
      "provider mutation lacks its newly-created exact durable rollback intent",
    );
  }
  const currentCandidate = await dependencies.journal.restoreCandidate(
    current,
    bundle.plan.expectedDeploymentMessage,
  );
  if (currentCandidate !== candidateId) {
    fail("durable rollback intent changed candidate identity before mutation");
  }
  const expectedWatermark =
    current.rollbackIntent?.providerDeploymentIdWatermarkSha256;
  if (!expectedWatermark?.includes(providerDeploymentIdDigest(candidateId))) {
    fail("durable rollback intent watermark lost its candidate identity");
  }
  const snapshot = await readSnapshot(
    config,
    bundle,
    current,
    candidateId,
    dependencies.railway,
  );
  if (!candidateIsTerminal(snapshot)) {
    fail("candidate became nonterminal immediately before rollback");
  }
  if (!sameProviderWatermark(providerWatermark(snapshot), expectedWatermark)) {
    fail(
      "Railway topology changed outside the durable provider watermark before rollback",
    );
  }
  if (
    activeTopologyDigest(snapshot) !==
    current.rollbackIntent?.providerActiveTopologySha256
  ) {
    fail("Railway active topology changed after the durable rollback intent");
  }
  const prior = validateDeployment(
    await dependencies.railway.getDeployment(
      bundle.plan.priorActiveDeploymentId,
    ),
    config.scope,
  );
  if (prior.snapshotId !== bundle.plan.priorSnapshotId) {
    fail("immutable prior snapshot changed immediately before rollback");
  }
  return current;
}

async function appendObservationAndRead(
  config,
  bundle,
  dependencies,
  status,
  restorationId,
  refineOrdinal = null,
) {
  await dependencies.journal.observe(status, restorationId, refineOrdinal);
  const state = validateJournalState(
    config,
    await dependencies.journal.read(),
    bundle,
  );
  const ordinal = refineOrdinal ?? state.rollbackIntents.length;
  const observation = state.rollbackObservations[ordinal - 1] ?? null;
  if (
    state.rollbackObservations.length !== state.rollbackIntents.length ||
    observation?.ordinal !== ordinal ||
    observation?.status !== status ||
    observation?.restorationIdSha256 !==
      (restorationId === null ? null : restorationIdDigest(restorationId))
  ) {
    fail(
      "rollback observation did not become the canonical logical journal head",
    );
  }
  if (
    state.rollbackIntents[0]?.candidateDeploymentIdSha256 !==
    state.rollbackIntent?.candidateDeploymentIdSha256
  ) {
    fail("rollback sequence changed its durable candidate identity");
  }
  return state;
}

async function refineLateObservation(
  config,
  bundle,
  candidateId,
  state,
  dependencies,
) {
  const ambiguous = state.rollbackObservations.filter(
    (observation) => observation.status === "AMBIGUOUS",
  );
  if (
    ambiguous.length === 0 ||
    state.rollbackObservations.length !== state.rollbackIntents.length
  ) {
    return state;
  }
  const stable = await stableSnapshot(
    config,
    bundle,
    state,
    candidateId,
    dependencies,
  );
  if (!candidateIsTerminal(stable)) {
    fail("nonce-bound candidate remains nonterminal; convergence stays OPEN");
  }
  const unmatched = restorationsWithoutObservation(state, stable);
  if (unmatched.length === 0) return state;
  if (unmatched.length > 1) {
    fail("multiple late Railway restorations cannot refine one observation");
  }
  const restoration = unmatched[0];
  if (statusClass(restoration.status) !== "terminal") {
    fail("late Railway restoration remains nonterminal");
  }
  const digest = providerDeploymentIdDigest(restoration.id);
  const eligible = ambiguous.filter((observation) => {
    const intent = state.rollbackIntents[observation.ordinal - 1];
    return !intent.providerDeploymentIdWatermarkSha256.includes(digest);
  });
  if (eligible.length !== 1) {
    fail("late Railway restoration is ambiguous across rollback ordinals");
  }
  return appendObservationAndRead(
    config,
    bundle,
    dependencies,
    restoration.status,
    restoration.id,
    eligible[0].ordinal,
  );
}

async function waitForIntentSettlement(dependencies, invocationStartedAt) {
  await waitForMonotonicHorizon(
    dependencies,
    invocationStartedAt,
    ROLLBACK_SETTLEMENT_SECONDS * 1_000,
  );
}

function assertRollbackCallRunway(intentPublicationStartedAt, dependencies) {
  const elapsed = dependencies.monotonicNow() - intentPublicationStartedAt;
  if (
    !Number.isFinite(elapsed) ||
    elapsed < 0 ||
    elapsed > ROLLBACK_CALL_MAX_DELAY_SECONDS * 1_000
  ) {
    fail(
      "durable rollback intent is too old for a full provider-settlement runway; no Railway mutation was issued",
    );
  }
}

function unobservedRestorations(state, snapshot) {
  const watermark = new Set(
    state.rollbackIntent?.providerDeploymentIdWatermarkSha256 ?? [],
  );
  return snapshot.restorations.filter(
    (deployment) => !watermark.has(providerDeploymentIdDigest(deployment.id)),
  );
}

function assertRestorationCannotRefineEarlierAmbiguousIntent(
  state,
  restoration,
) {
  const digest = providerDeploymentIdDigest(restoration.id);
  if (
    state.rollbackObservations.some((observation) => {
      if (observation.status !== "AMBIGUOUS") return false;
      const intent = state.rollbackIntents[observation.ordinal - 1];
      return !intent.providerDeploymentIdWatermarkSha256.includes(digest);
    })
  ) {
    fail(
      "Railway restoration could refine an earlier ambiguous rollback ordinal",
    );
  }
}

async function observeExistingIntent(
  config,
  bundle,
  candidateId,
  state,
  dependencies,
  invocationStartedAt,
) {
  await waitForIntentSettlement(dependencies, invocationStartedAt);
  const stable = await stableSnapshot(
    config,
    bundle,
    state,
    candidateId,
    dependencies,
  );
  if (!candidateIsTerminal(stable)) {
    fail("nonce-bound candidate remains nonterminal; convergence stays OPEN");
  }
  const matches = unobservedRestorations(state, stable);
  if (matches.length > 1) {
    fail("one durable rollback intent maps to multiple Railway restorations");
  }
  if (matches.length === 0) {
    return appendObservationAndRead(
      config,
      bundle,
      dependencies,
      "AMBIGUOUS",
      null,
    );
  }
  const restoration = matches[0];
  assertRestorationCannotRefineEarlierAmbiguousIntent(state, restoration);
  if (statusClass(restoration.status) !== "terminal") {
    fail("the exact restoration for the current intent remains nonterminal");
  }
  return appendObservationAndRead(
    config,
    bundle,
    dependencies,
    restoration.status,
    restoration.id,
  );
}

async function proveRestored(config, bundle, candidateId, state, dependencies) {
  const stable = await stableSnapshot(
    config,
    bundle,
    state,
    candidateId,
    dependencies,
  );
  const successful = state.rollbackObservations.filter((observation) =>
    READY.has(observation.status),
  );
  if (successful.length !== 1) {
    fail(
      "bounded rollback observations contain no unique successful restoration",
    );
  }
  for (const observation of state.rollbackObservations) {
    const restoration = restorationForObservation(observation, stable);
    if (
      restoration &&
      !observedStatusMatches(observation.status, restoration.status)
    ) {
      fail("Railway restoration status differs from its durable observation");
    }
  }
  const activeRestoration = restorationForObservation(successful[0], stable);
  if (
    !activeRestoration ||
    !READY.has(activeRestoration.status) ||
    !allAttributableRowsTerminal(stable) ||
    !candidateIsTerminal(stable) ||
    !solePrior(stable, bundle.plan) ||
    stable.active[0].id !== activeRestoration.id
  ) {
    fail(
      "successful restoration is not the sole stable immutable prior snapshot",
    );
  }
  return resolution(
    config,
    bundle,
    state,
    stable,
    "prior-snapshot-restored",
    candidateId,
    stable.active[0],
  );
}

async function provePriorPreservedAfterIntents(
  config,
  bundle,
  candidateId,
  state,
  dependencies,
) {
  const stable = await stableSnapshot(
    config,
    bundle,
    state,
    candidateId,
    dependencies,
  );
  if (restorationsWithoutObservation(state, stable).length > 0) {
    fail(
      "a Railway restoration appeared after its durable observation boundary; convergence stays OPEN",
    );
  }
  for (const observation of state.rollbackObservations) {
    const restoration = restorationForObservation(observation, stable);
    if (
      restoration &&
      !observedStatusMatches(observation.status, restoration.status)
    ) {
      fail("Railway restoration status differs from its durable observation");
    }
  }
  if (
    state.rollbackObservations.some((observation) =>
      READY.has(observation.status),
    ) ||
    !allAttributableRowsTerminal(stable) ||
    !candidateIsTerminal(stable) ||
    !solePrior(stable, bundle.plan) ||
    stable.active[0].id !== bundle.plan.priorActiveDeploymentId
  ) {
    return null;
  }
  return resolution(
    config,
    bundle,
    state,
    stable,
    "prior-snapshot-preserved",
    candidateId,
    stable.active[0],
  );
}

async function createAndIssueRollback(
  config,
  bundle,
  candidateId,
  state,
  dependencies,
) {
  const beforeIntent = await stableSnapshot(
    config,
    bundle,
    state,
    candidateId,
    dependencies,
  );
  if (!candidateIsTerminal(beforeIntent)) {
    fail("nonce-bound candidate became nonterminal before rollback intent");
  }
  if (restorationsWithoutObservation(state, beforeIntent).length > 0) {
    fail(
      "a Railway restoration appeared after its durable observation boundary; no later rollback is safe",
    );
  }
  if (solePrior(beforeIntent, bundle.plan)) {
    fail(
      "immutable prior snapshot is already sole active; no later rollback is safe",
    );
  }
  const watermark = providerWatermark(beforeIntent);
  const activeDigest = activeTopologyDigest(beforeIntent);
  const intentPublicationStartedAt = dependencies.monotonicNow();
  const created = await dependencies.journal.ensureIntent(
    candidateId,
    bundle.plan.expectedDeploymentMessage,
    watermark,
    activeDigest,
  );
  const createdIntentRecordId =
    created?.commentId ?? created?.recordId ?? created;
  if (
    !DIGEST.test(createdIntentRecordId ?? "") ||
    created?.newlyPublished !== true
  ) {
    fail(
      "rollback intent was not first-published by this run; its ordinal will not be replayed",
    );
  }
  if (
    !sameProviderWatermark(
      created.providerDeploymentIdWatermarkSha256,
      watermark,
    )
  ) {
    fail("rollback intent did not seal the exact Railway provider watermark");
  }
  if (created.providerActiveTopologySha256 !== activeDigest) {
    fail("rollback intent did not seal the exact Railway active topology");
  }
  await assertPreMutation(
    config,
    createdIntentRecordId,
    candidateId,
    bundle,
    dependencies,
  );
  await dependencies.railway.assertExactStagingScope();
  // The independent scope read creates a race window for a late provider
  // effect. Re-run every intent, journal, candidate, provider-watermark, active
  // topology, and immutable-prior check after that network boundary.
  const current = await assertPreMutation(
    config,
    createdIntentRecordId,
    candidateId,
    bundle,
    dependencies,
  );
  // The final provider reads may themselves take long enough for develop to
  // move. Leave no asynchronous boundary after this last GitHub authority
  // fence and before the irreversible provider call.
  await attestExactSourceRun(config, dependencies);
  await dependencies.authority.assertCurrentDevelop();
  assertRollbackCallRunway(intentPublicationStartedAt, dependencies);
  let acknowledged;
  try {
    acknowledged = await dependencies.railway.rollback(
      bundle.plan.priorActiveDeploymentId,
    );
  } catch {
    dependencies.warn?.("rollback-acknowledgement-unresolved");
    fail(
      "Railway rollback acknowledgement is unresolved; the durable intent will be observed by a later run",
    );
  }
  if (acknowledged !== true) {
    fail(
      "Railway rollback did not return an authoritative true acknowledgement; the durable intent will be observed by a later run",
    );
  }
  // Railway's live GraphQL contract returns only Boolean, not a restoration
  // deployment identity. Wait the complete settlement horizon before binding
  // at most one exact prior-snapshot restoration outside the intent's sealed
  // provider watermark.
  await waitForMonotonicHorizon(
    dependencies,
    intentPublicationStartedAt,
    ROLLBACK_SETTLEMENT_SECONDS * 1_000,
  );
  const settled = await stableSnapshot(
    config,
    bundle,
    current,
    candidateId,
    dependencies,
  );
  const matches = unobservedRestorations(current, settled);
  if (matches.length > 1) {
    fail("one acknowledged Railway rollback maps to multiple restorations");
  }
  if (matches.length === 0) {
    await appendObservationAndRead(
      config,
      bundle,
      dependencies,
      "AMBIGUOUS",
      null,
    );
    fail(
      "Railway acknowledged rollback produced no restoration after the full settlement horizon; a fresh authorized run must evaluate any next attempt",
    );
  }
  const restoration = matches[0];
  assertRestorationCannotRefineEarlierAmbiguousIntent(current, restoration);
  if (statusClass(restoration.status) !== "terminal") {
    fail(
      "acknowledged Railway restoration remains nonterminal after the full settlement horizon; a later run will observe it without replay",
    );
  }
  await appendObservationAndRead(
    config,
    bundle,
    dependencies,
    restoration.status,
    restoration.id,
  );
  fail(
    "one rollback effect was durably observed; a fresh authorized run must evaluate any next attempt",
  );
}

export async function reconcileGatewayWebhook(
  rawConfig,
  rawBundle,
  dependencies,
) {
  let config = {
    ...rawConfig,
    receipt: null,
    receiptSemanticDigest: null,
  };
  const invocationStartedAt = dependencies.monotonicNow();
  const receiptArtifactAbsent =
    config.receiptArtifactId === null && config.receiptArtifactDigest === null;
  const receiptArtifactPresent =
    POSITIVE_INTEGER.test(config.receiptArtifactId ?? "") &&
    DIGEST.test(config.receiptArtifactDigest ?? "");
  if (
    config.environment !== "staging" ||
    !SHA.test(config.sourceSha ?? "") ||
    !POSITIVE_INTEGER.test(config.sourceRunId ?? "") ||
    !POSITIVE_INTEGER.test(config.sourceRunAttempt ?? "") ||
    !POSITIVE_INTEGER.test(config.recoveryRunId ?? "") ||
    !POSITIVE_INTEGER.test(config.recoveryRunAttempt ?? "") ||
    !DIGEST.test(config.openRecordId ?? "") ||
    !POSITIVE_INTEGER.test(config.planArtifactId ?? "") ||
    !DIGEST.test(config.planArtifactDigest ?? "") ||
    !(receiptArtifactAbsent || receiptArtifactPresent)
  ) {
    fail("staging reconciliation inputs are malformed");
  }
  const bundle = validatePlanBundle(config, rawBundle);
  await attestExactSourceRun(config, dependencies);
  await waitForSourceSettlement(dependencies, invocationStartedAt);
  let state = validateJournalState(
    config,
    await dependencies.journal.read(),
    bundle,
  );
  if (receiptArtifactPresent) {
    const authoritativeReceipt = validateReceiptArtifactAttestation(
      config,
      await dependencies.artifacts.attestReceipt(config),
      dependencies.wallNow(),
    );
    config = {
      ...config,
      receipt: authoritativeReceipt.receipt,
      receiptSemanticDigest: authoritativeReceipt.receiptSemanticDigest,
    };
  }

  let candidateId = null;
  let initial = await readSnapshot(
    config,
    bundle,
    state,
    null,
    dependencies.railway,
  );
  if (state.rollbackIntents.length > 0) {
    candidateId = await dependencies.journal.restoreCandidate(
      state,
      bundle.plan.expectedDeploymentMessage,
    );
    if (!UUID.test(candidateId ?? ""))
      fail("durable candidate identity is malformed");
    initial = await readSnapshot(
      config,
      bundle,
      state,
      candidateId,
      dependencies.railway,
    );
  } else {
    const matches = candidateIds(
      initial,
      bundle.plan.expectedDeploymentMessage,
    );
    if (matches.length > 1) {
      fail("nonce-bound message identifies multiple post-baseline deployments");
    }
    candidateId = matches[0] ?? null;
    if (candidateId) {
      initial = await readSnapshot(
        config,
        bundle,
        state,
        candidateId,
        dependencies.railway,
      );
    }
  }

  if (!candidateId) {
    if (state.rollbackIntents.length !== 0 || initial.postRows.length !== 0) {
      fail(
        "candidate is absent while durable or post-baseline state remains unresolved",
      );
    }
    const stable = await stableSnapshot(
      config,
      bundle,
      state,
      null,
      dependencies,
    );
    if (stable.postRows.length !== 0 || !solePrior(stable, bundle.plan)) {
      fail("no-candidate resolution lacks an exhaustive stable prior snapshot");
    }
    return resolution(
      config,
      bundle,
      state,
      stable,
      "baseline-preserved-no-candidate",
      null,
      stable.active[0],
    );
  }

  if (
    !initial.candidate ||
    initial.candidate.meta?.commitMessage !==
      bundle.plan.expectedDeploymentMessage
  ) {
    fail("candidate lacks exact nonce/message provider readback");
  }

  if (state.rollbackIntents.length === 0) {
    const stable = await stableSnapshot(
      config,
      bundle,
      state,
      candidateId,
      dependencies,
    );
    if (
      stable.postRows.length === 1 &&
      stable.postRows[0].id === candidateId &&
      READY.has(stable.candidate.status) &&
      stable.candidate.deploymentStopped === false &&
      validateDeploymentReceipt(
        config,
        bundle.plan,
        config.receipt,
        candidateId,
      ) &&
      soleCandidate(stable, candidateId)
    ) {
      return resolution(
        config,
        bundle,
        state,
        stable,
        "candidate-proven",
        candidateId,
        stable.active[0],
      );
    }
    if (
      stable.postRows.length === 1 &&
      stable.postRows[0].id === candidateId &&
      candidateIsTerminal(stable) &&
      solePrior(stable, bundle.plan)
    ) {
      return resolution(
        config,
        bundle,
        state,
        stable,
        "prior-snapshot-preserved",
        candidateId,
        stable.active[0],
      );
    }
    if (!candidateIsTerminal(stable)) {
      fail(
        "nonce-bound candidate is nonterminal; transaction remains OPEN without mutation",
      );
    }
    state = await createAndIssueRollback(
      config,
      bundle,
      candidateId,
      state,
      dependencies,
    );
  }

  for (;;) {
    if (state.rollbackObservations.length < state.rollbackIntents.length) {
      state = await observeExistingIntent(
        config,
        bundle,
        candidateId,
        state,
        dependencies,
        invocationStartedAt,
      );
    }
    state = await refineLateObservation(
      config,
      bundle,
      candidateId,
      state,
      dependencies,
    );
    if (
      state.rollbackObservations.some((observation) =>
        READY.has(observation.status),
      )
    ) {
      return proveRestored(config, bundle, candidateId, state, dependencies);
    }
    const preserved = await provePriorPreservedAfterIntents(
      config,
      bundle,
      candidateId,
      state,
      dependencies,
    );
    if (preserved) return preserved;
    if (state.rollbackIntents.length >= MAX_ROLLBACK_ATTEMPTS) {
      fail(
        "both durable Railway rollback attempts are terminal or ambiguous without success; transaction remains OPEN",
      );
    }
    state = await createAndIssueRollback(
      config,
      bundle,
      candidateId,
      state,
      dependencies,
    );
  }
}

export class RailwayCliClient {
  constructor({ scope, environment = process.env, execute = execFile }) {
    this.scope = scope;
    this.environment = Object.fromEntries(
      [
        "CI",
        "HOME",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "NO_COLOR",
        "PATH",
        "RAILWAY_TOKEN",
        "TZ",
      ]
        .filter((name) => typeof environment[name] === "string")
        .map((name) => [name, environment[name]]),
    );
    this.execute = execute;
  }

  async query(document, variables, timeout = 20_000) {
    let stdout;
    try {
      const result = await this.execute(
        "railway",
        [
          "api",
          document,
          "--variables",
          JSON.stringify(variables),
          "--compact",
        ],
        {
          env: this.environment,
          timeout,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
      stdout = result?.stdout;
    } catch {
      fail("Railway CLI request failed", "railway-cli-request-failure");
    }
    if (typeof stdout !== "string") {
      fail("Railway returned non-text GraphQL output");
    }
    const payload = parseUniqueJson(
      stdout,
      "Railway returned non-strict GraphQL JSON output",
    );
    if (!isSuccessfulGraphqlEnvelope(payload)) {
      fail("Railway GraphQL request did not return a valid success envelope");
    }
    return payload.data;
  }

  async listDeployments() {
    const document = `query DeploymentHistory($input: DeploymentListInput!, $first: Int!, $after: String) {
      deployments(input: $input, first: $first, after: $after) {
        edges { node { id createdAt status meta } }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    const rows = [];
    const ids = new Set();
    const cursors = new Set();
    let after = null;
    for (let page = 0; page < 10_000; page += 1) {
      const data = await this.query(document, {
        input: {
          projectId: this.scope.projectId,
          environmentId: this.scope.environmentId,
          serviceId: this.scope.serviceId,
        },
        first: 100,
        after,
      });
      const connection = data?.deployments;
      if (
        !Array.isArray(connection?.edges) ||
        typeof connection?.pageInfo?.hasNextPage !== "boolean" ||
        !(
          connection.pageInfo.endCursor === null ||
          typeof connection.pageInfo.endCursor === "string"
        )
      ) {
        fail("Railway deployment pagination returned a malformed connection");
      }
      for (const edge of connection.edges) {
        const row = validateHistoryRow(edge?.node);
        if (ids.has(row.id))
          fail("Railway deployment pagination repeated an id");
        ids.add(row.id);
        rows.push(row);
      }
      if (!connection.pageInfo.hasNextPage) return rows;
      const cursor = connection.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor)) {
        fail("Railway deployment pagination repeated or omitted its cursor");
      }
      cursors.add(cursor);
      after = cursor;
    }
    fail("Railway deployment pagination exceeded its fail-closed page bound");
  }

  async getDeployment(id) {
    const data = await this.query(
      `query ExactDeployment($id: String!) {
        deployment(id: $id) {
          id projectId environmentId serviceId snapshotId status deploymentStopped meta
        }
      }`,
      { id },
    );
    return data?.deployment;
  }

  async getActiveDeployments() {
    const data = await this.query(
      `query ActiveDeployments($environmentId: String!, $serviceId: String!) {
        serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
          environmentId serviceId serviceName
          activeDeployments {
            id projectId environmentId serviceId snapshotId status deploymentStopped meta
          }
        }
      }`,
      {
        environmentId: this.scope.environmentId,
        serviceId: this.scope.serviceId,
      },
    );
    const instance = data?.serviceInstance;
    if (
      instance?.environmentId !== this.scope.environmentId ||
      instance?.serviceId !== this.scope.serviceId ||
      instance?.serviceName !== this.scope.serviceName
    ) {
      fail("Railway active service instance is outside the exact scope");
    }
    return instance.activeDeployments;
  }

  async assertExactStagingScope() {
    if (!this.environment.RAILWAY_TOKEN) {
      fail("environment-scoped Railway project token is missing");
    }
    const data = await this.query(
      `query ExactRollbackScope($projectId: String!) {
        projectToken { projectId environmentId }
        project(id: $projectId) {
          id
          environments { edges { node { id name } } }
          services { edges { node { id name } } }
        }
      }`,
      { projectId: this.scope.projectId },
    );
    const environments = data?.project?.environments?.edges;
    const services = data?.project?.services?.edges;
    const exactEnvironments = Array.isArray(environments)
      ? environments.filter(
          (edge) => edge?.node?.id === this.scope.environmentId,
        )
      : [];
    const exactServices = Array.isArray(services)
      ? services.filter((edge) => edge?.node?.id === this.scope.serviceId)
      : [];
    if (
      data?.project?.id !== this.scope.projectId ||
      data?.projectToken?.projectId !== this.scope.projectId ||
      data?.projectToken?.environmentId !== this.scope.environmentId ||
      exactEnvironments.length !== 1 ||
      exactEnvironments[0]?.node?.name !== "staging" ||
      exactServices.length !== 1 ||
      exactServices[0]?.node?.name !== this.scope.serviceName
    ) {
      fail(
        "Railway project token or project/environment/service identity is outside exact staging scope",
      );
    }
    return {
      environmentId: exactEnvironments[0].node.id,
      environmentName: exactEnvironments[0].node.name,
      projectId: data.project.id,
      serviceId: exactServices[0].node.id,
      serviceName: exactServices[0].node.name,
    };
  }

  async rollback(priorDeploymentId) {
    const data = await this.query(
      `mutation DeploymentRollback($id: String!) {
        deploymentRollback(id: $id)
      }`,
      { id: priorDeploymentId },
      ROLLBACK_MUTATION_TIMEOUT_SECONDS * 1_000,
    );
    if (data?.deploymentRollback !== true) {
      fail(
        "Railway rollback mutation did not return an authoritative true acknowledgement",
      );
    }
    return true;
  }
}

async function boundedResponseBytes(response, maximumBytes) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    fail("GitHub artifact archive exceeds the fail-closed size bound");
  }
  if (!response.body) fail("GitHub artifact archive body is absent");
  const chunks = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      fail("GitHub artifact archive exceeds the fail-closed size bound");
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) fail("GitHub artifact archive is empty");
  return Buffer.concat(chunks, total);
}

export class GitHubReceiptArtifactClient {
  constructor({
    api,
    token,
    repository,
    apiUrl = "https://api.github.com",
    fetchImpl = fetch,
  }) {
    if (!api || !token || !/^[^/\s]+\/[^/\s]+$/.test(repository ?? "")) {
      fail("GitHub receipt artifact credentials are missing");
    }
    this.api = api;
    this.token = token;
    this.repository = repository;
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
  }

  async attestReceipt(config) {
    let artifact;
    let sourceRun;
    try {
      artifact = await this.api.request(
        "GET",
        `/actions/artifacts/${config.receiptArtifactId}`,
      );
      sourceRun = await this.api.request(
        "GET",
        `/actions/runs/${config.sourceRunId}/attempts/${config.sourceRunAttempt}`,
      );
    } catch (error) {
      if (error instanceof RedactedActionError) throw error;
      fail(
        "GitHub receipt metadata request failed",
        "github-api-request-failure",
      );
    }
    let response;
    try {
      response = await this.fetchImpl(
        `${this.apiUrl}/repos/${this.repository}/actions/artifacts/${config.receiptArtifactId}/zip`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${this.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
          },
          redirect: "follow",
        },
      );
    } catch {
      fail(
        "GitHub receipt artifact download request failed",
        "github-artifact-download-failure",
      );
    }
    if (!response.ok) {
      fail(
        `GitHub receipt artifact download failed (HTTP ${httpStatusForDiagnostic(response)})`,
        "github-artifact-download-failure",
      );
    }
    let archiveBytes;
    try {
      archiveBytes = await boundedResponseBytes(
        response,
        MAX_RECEIPT_ARCHIVE_BYTES,
      );
    } catch (error) {
      if (error instanceof RedactedActionError) throw error;
      fail(
        "GitHub receipt artifact response read failed",
        "github-artifact-download-failure",
      );
    }
    return { artifact, sourceRun, archiveBytes };
  }
}

function required(environment, name) {
  const value = environment[name];
  if (!value) fail(`required reconciliation environment ${name} is missing`);
  return value;
}

async function readPlanBundle(temp) {
  const planDirectory = join(temp, "gateway-webhook-rollback-plan");
  const files = new Map();
  for (const name of PLAN_FILES) {
    const path = join(planDirectory, name);
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 2_000_000) {
      fail(`rollback-plan file ${name} is missing, unsafe, or too large`);
    }
    files.set(name, await readFile(path));
  }
  const baselineBytes = files.get("deployment-baseline.json");
  const priorActiveBytes = files.get("prior-active-deployments.json");
  const planBytes = files.get("rollback-plan.json");
  return {
    plan: parseUniqueJson(
      planBytes.toString("utf8"),
      "immutable rollback plan is not strict JSON",
    ),
    baseline: parseUniqueJson(
      baselineBytes.toString("utf8"),
      "immutable Railway baseline is not strict JSON",
    ),
    priorActive: parseUniqueJson(
      priorActiveBytes.toString("utf8"),
      "immutable prior-active proof is not strict JSON",
    ),
    digests: {
      baseline: sha256(baselineBytes),
      priorActive: sha256(priorActiveBytes),
      journalPlanPlaintext: journalPlanPlaintextDigest(files),
    },
  };
}

async function defaultDependencies(config, environment) {
  const githubToken = required(environment, "GITHUB_TOKEN");
  const api = new GitHubApi({
    token: githubToken,
    repository: config.repository,
    apiUrl: environment.GITHUB_API_URL,
  });
  const authKey = required(environment, "GATEWAY_JOURNAL_AUTH_KEY");
  const source = {
    repository: config.repository,
    environment: "staging",
    sourceSha: config.sourceSha,
    sourceRunId: config.sourceRunId,
    sourceRunAttempt: config.sourceRunAttempt,
  };
  const journalEnvironment = { ...environment };
  return {
    railway: new RailwayCliClient({ scope: config.scope, environment }),
    artifacts: new GitHubReceiptArtifactClient({
      api,
      token: githubToken,
      repository: config.repository,
      apiUrl: environment.GITHUB_API_URL,
    }),
    sourceRun: {
      read: () =>
        api.request(
          "GET",
          `/actions/runs/${config.sourceRunId}/attempts/${config.sourceRunAttempt}`,
        ),
    },
    authority: {
      assertCurrentDevelop: async () => {
        if (
          environment.GITHUB_SHA !== config.recoverySha ||
          environment.GITHUB_REF !== "refs/heads/develop" ||
          ![
            `${config.repository}/.github/workflows/deploy-gateway-webhook.yml@refs/heads/develop`,
            `${config.repository}/.github/workflows/recover-gateway-webhook-transactions.yml@refs/heads/develop`,
          ].includes(environment.GITHUB_WORKFLOW_REF)
        ) {
          fail(
            "reconciliation is not running under the staging develop authority",
          );
        }
        const branch = await api.request("GET", "/branches/develop");
        if (branch?.commit?.sha !== config.recoverySha) {
          fail("develop advanced immediately before the Railway mutation");
        }
      },
    },
    journal: {
      read: () => readJournalState(api, config.repository, "staging", authKey),
      restoreCandidate: async (state, message) =>
        decryptCandidateEnvelope(
          state.rollbackIntents[0],
          message,
          source,
          state.open,
          authKey,
        ),
      ensureIntent: async (
        candidateId,
        message,
        providerWatermarkSha256,
        providerActiveTopologySha256,
      ) => {
        return journalMain(
          [
            "rollback-intent",
            "--environment",
            "staging",
            "--source-sha",
            config.sourceSha,
            "--source-run-id",
            config.sourceRunId,
            "--source-run-attempt",
            config.sourceRunAttempt,
            "--candidate-deployment-id",
            candidateId,
            "--expected-deployment-message",
            message,
            "--provider-deployment-id-watermark-sha256",
            JSON.stringify(providerWatermarkSha256),
            "--provider-active-topology-sha256",
            providerActiveTopologySha256,
          ],
          journalEnvironment,
        );
      },
      observe: async (status, restorationId, refineOrdinal = null) => {
        const args = [
          "rollback-observation",
          "--environment",
          "staging",
          "--source-sha",
          config.sourceSha,
          "--source-run-id",
          config.sourceRunId,
          "--source-run-attempt",
          config.sourceRunAttempt,
          "--status",
          status,
        ];
        if (restorationId !== null) {
          args.push(
            "--restoration-id-sha256",
            restorationIdDigest(restorationId),
          );
        }
        if (refineOrdinal !== null) {
          args.push("--refine-ordinal", String(refineOrdinal));
        }
        return journalMain(args, journalEnvironment);
      },
    },
    monotonicNow: () => performance.now(),
    wallNow: () => Date.now(),
    sleep: (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    warn: (diagnosticClass) =>
      writeReconcileWarningAnnotation(process.stderr, diagnosticClass),
  };
}

export async function main(
  environment = process.env,
  argv = process.argv.slice(2),
  injected = {},
) {
  const temp = required(environment, "RUNNER_TEMP");
  const bundle = injected.bundle ?? (await readPlanBundle(temp));
  if (argv[0] === "verify-source-baseline") {
    if (argv.length !== 1 || environment.TARGET_ENVIRONMENT !== "staging") {
      fail("source baseline verification is staging-only");
    }
    const sourceConfig = {
      repository: required(environment, "GITHUB_REPOSITORY"),
      sourceSha: required(environment, "GITHUB_SHA"),
      sourceRunId: required(environment, "GITHUB_RUN_ID"),
      sourceRunAttempt: required(environment, "GITHUB_RUN_ATTEMPT"),
      scope: {
        projectId: required(environment, "RAILWAY_PROJECT_ID"),
        environmentId: required(environment, "RAILWAY_ENVIRONMENT_ID"),
        serviceId: required(environment, "RAILWAY_SERVICE_ID"),
        serviceName: required(environment, "EXPECTED_SERVICE_NAME"),
      },
    };
    const result = await verifySourcePreMutationSnapshot(sourceConfig, bundle, {
      railway:
        injected.railway ??
        new RailwayCliClient({
          scope: sourceConfig.scope,
          environment,
        }),
      sleep:
        injected.sleep ??
        ((milliseconds) =>
          new Promise((resolve) => setTimeout(resolve, milliseconds))),
    });
    (injected.stdout ?? process.stdout).write(`${canonicalJson(result)}\n`);
    return result;
  }
  if (argv.length !== 0) fail("unsupported gateway reconciliation command");
  const receiptPresent = required(environment, "RECEIPT_PRESENT");
  if (!["true", "false"].includes(receiptPresent)) {
    fail("RECEIPT_PRESENT must be exactly true or false");
  }
  const config = {
    repository: required(environment, "GITHUB_REPOSITORY"),
    environment: required(environment, "TARGET_ENVIRONMENT"),
    sourceSha: required(environment, "SOURCE_SHA"),
    sourceRunId: required(environment, "SOURCE_RUN_ID"),
    sourceRunAttempt: required(environment, "SOURCE_RUN_ATTEMPT"),
    recoveryRunId: required(environment, "GITHUB_RUN_ID"),
    recoveryRunAttempt: required(environment, "GITHUB_RUN_ATTEMPT"),
    recoverySha: required(environment, "GITHUB_SHA"),
    openRecordId: required(environment, "OPEN_COMMENT_ID"),
    planArtifactId: required(environment, "PLAN_ARTIFACT_ID"),
    planArtifactDigest: required(environment, "PLAN_ARTIFACT_DIGEST"),
    receiptArtifactId:
      receiptPresent === "true"
        ? required(environment, "RECEIPT_ARTIFACT_ID")
        : null,
    receiptArtifactDigest:
      receiptPresent === "true"
        ? required(environment, "RECEIPT_ARTIFACT_DIGEST")
        : null,
    sourceDeployCompletedEpoch: Number(
      required(environment, "SOURCE_DEPLOY_COMPLETED_EPOCH"),
    ),
    scope: {
      projectId: required(environment, "RAILWAY_PROJECT_ID"),
      environmentId: required(environment, "RAILWAY_ENVIRONMENT_ID"),
      serviceId: required(environment, "RAILWAY_SERVICE_ID"),
      serviceName: required(environment, "EXPECTED_SERVICE_NAME"),
    },
    receipt: null,
  };
  const dependencies = await defaultDependencies(config, environment);
  const result = await reconcileGatewayWebhook(config, bundle, dependencies);
  const outputDirectory = join(temp, "gateway-webhook-reconciliation");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const outputPath = join(
    outputDirectory,
    "gateway-webhook-reconciliation.json",
  );
  await writeFile(outputPath, `${canonicalJson(result)}\n`, { mode: 0o600 });
  if (environment.GITHUB_OUTPUT) {
    await writeFile(environment.GITHUB_OUTPUT, `result=${result.result}\n`, {
      flag: "a",
    });
  }
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href
) {
  main().catch((error) => {
    writeReconcileFailureAnnotation(process.stderr, error);
    process.exitCode = 1;
  });
}
