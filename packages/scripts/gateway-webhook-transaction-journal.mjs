#!/usr/bin/env node

/**
 * Maintains the authenticated, environment-scoped recovery ledger for Gateway
 * Railway transactions and the encrypted rollback plans referenced by it.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const JOURNAL_ISSUE = 29763;
export const MARKER_PREFIX = "<!-- gateway-webhook-transaction:v1\n";
export const RECORD_PREFIX = "<!-- gateway-webhook-transaction-record:v2\n";
export const PLAN_CHUNK_PREFIX = "<!-- gateway-webhook-plan-chunk:v1\n";
const PREPARED_OPEN_ARTIFACT_PREFIX = "gateway-webhook-prepared-open-staging-";
const PREPARED_OPEN_FILE = "gateway-webhook-prepared-open.json";
const PREPARED_OPEN_KIND = "gateway-webhook-prepared-open";
const MARKER_SUFFIX = "\n-->";
const API_VERSION = "2022-11-28";
const PAGE_SIZE = 100;
const MAX_PAGES = 100;
const ARTIFACT_RETENTION_HORIZON_MS = 31 * 24 * 60 * 60 * 1_000;
const ARTIFACT_DISCOVERY_REQUEST_BUDGET = 400;
const PLAN_CHUNK_CHARACTERS = 45_000;
const MAX_PLAN_CHUNKS = 100;
const RECORD_AUTH_DOMAIN = "gateway-webhook-transaction-record-auth-v2\0";
const RECORD_OPERATION_NONCE_DOMAIN =
  "gateway-webhook-transaction-operation-nonce-v1\0";
const LOGICAL_RECORD_ID_DOMAIN =
  "gateway-webhook-transaction-logical-record-v1\0";
const MARKER_DIGEST_DOMAIN = "gateway-webhook-transaction-marker-digest-v2\0";
const RECORD_KEY_ID_DOMAIN = "gateway-webhook-transaction-record-key-id-v1\0";
const REKEY_PREVIOUS_AUTH_DOMAIN =
  "gateway-webhook-transaction-rekey-previous-auth-v1\0";
const RESTORATION_ID_DIGEST_DOMAIN = "gateway-webhook-restoration-id-v1\0";
const CANDIDATE_ID_DIGEST_DOMAIN = "gateway-webhook-candidate-id-v1\0";
const PROVIDER_DEPLOYMENT_ID_DIGEST_DOMAIN =
  "gateway-webhook-provider-deployment-id-v1\0";
const CANDIDATE_MESSAGE_DIGEST_DOMAIN =
  "gateway-webhook-candidate-message-v1\0";
const PLAN_KEY_DOMAIN = "gateway-webhook-journal-encryption-v2\0";
const PLAN_WRAP_KEY_DOMAIN = "gateway-webhook-journal-key-wrap-v1\0";
const PLAN_FILES = [
  "deployment-baseline.json",
  "prior-active-deployments.json",
  "rollback-plan.json",
];
const ENVIRONMENTS = new Set(["staging", "production"]);
const CLOSE_RESULTS = new Set([
  "baseline-preserved-no-candidate",
  "candidate-proven",
  "prior-snapshot-preserved",
  "prior-snapshot-restored",
]);
const ROLLBACK_OBSERVATION_STATUSES = new Set([
  "SUCCESS",
  "FAILED",
  "CRASHED",
  "REMOVED",
  "SLEEPING",
  "SKIPPED",
  "CANCELED",
  "CANCELLED",
  "AMBIGUOUS",
]);
const ROLLBACK_READY_STATUSES = new Set(["SUCCESS", "SLEEPING"]);
const MAX_ROLLBACK_ATTEMPTS = 2;
const TRUSTED_RECOVERY_PATHS = new Set([
  ".github/workflows/deploy-gateway-webhook.yml",
  ".github/workflows/recover-gateway-webhook-transactions.yml",
]);

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function isPositiveIntegerString(value) {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isJournalReference(value) {
  return isDigest(value) || isPositiveIntegerString(value);
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      value,
    )
  );
}

function isSnapshotId(value) {
  return typeof value === "string" && /^[0-9A-Za-z_-]{8,256}$/.test(value);
}

function isRepository(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
  );
}

function authKeyBytes(value) {
  if (typeof value !== "string") {
    fail("protected gateway journal authentication key is missing");
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length < 32 || bytes.length > 4096) {
    fail("protected gateway journal authentication key is malformed");
  }
  return bytes;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function journalAuthKeyId(authKey) {
  return createHash("sha256")
    .update(RECORD_KEY_ID_DOMAIN)
    .update(authKeyBytes(authKey))
    .digest("hex");
}

function recordAuthentication(unsignedRecord, authKey) {
  return createHmac("sha256", authKeyBytes(authKey))
    .update(RECORD_AUTH_DOMAIN)
    .update(canonicalJson(unsignedRecord))
    .digest("hex");
}

function semanticMarker(marker) {
  if (!marker || marker.kind === "open") return marker;
  const {
    recoveryJobId: _recoveryJobId,
    recoveryJobName: _recoveryJobName,
    recoveryRunAttempt: _recoveryRunAttempt,
    recoveryRunId: _recoveryRunId,
    recoveryWorkflowSha: _recoveryWorkflowSha,
    ...semantic
  } = marker;
  if (marker.kind === "rollback-intent") {
    const { candidateDeploymentEnvelope: _candidateEnvelope, ...intent } =
      semantic;
    return intent;
  }
  return semantic;
}

function logicalRecordPayload(record) {
  const {
    auth: _auth,
    commentId: _commentId,
    createdAt: _createdAt,
    logicalRecordId: _logicalRecordId,
    operationNonce: _operationNonce,
    physicalCommentIds: _physicalCommentIds,
    previousAuth: _previousAuth,
    recordId: _recordId,
    recordSha256: _recordSha256,
    writer: _writer,
    ...logical
  } = record;
  if (logical.kind === "marker") {
    logical.marker = semanticMarker(logical.marker);
  }
  return logical;
}

function recordOperationNonce(record, authKey) {
  return createHmac("sha256", authKeyBytes(authKey))
    .update(RECORD_OPERATION_NONCE_DOMAIN)
    .update(canonicalJson(logicalRecordPayload(record)))
    .digest("hex")
    .slice(0, 32);
}

function logicalRecordDigest(record) {
  return createHash("sha256")
    .update(LOGICAL_RECORD_ID_DOMAIN)
    .update(canonicalJson(logicalRecordPayload(record)))
    .digest("hex");
}

function exactDigestEqual(left, right) {
  if (!isDigest(left) || !isDigest(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

const SOURCE_KEYS = [
  "environment",
  "repository",
  "sourceRunAttempt",
  "sourceRunId",
  "sourceSha",
];

function validSource(marker) {
  return (
    ENVIRONMENTS.has(marker.environment) &&
    isRepository(marker.repository) &&
    isSha(marker.sourceSha) &&
    isPositiveIntegerString(marker.sourceRunId) &&
    isPositiveIntegerString(marker.sourceRunAttempt)
  );
}

function sameSource(left, right) {
  return SOURCE_KEYS.every((key) => left[key] === right[key]);
}

function validateMarker(marker) {
  if (!validSource(marker) || marker.version !== 1) {
    fail("gateway transaction marker has an invalid source identity");
  }
  if (marker.kind === "open") {
    const keys = [
      "environment",
      "kind",
      "journalPlanChunkCommentIds",
      "journalPlanChunkSha256",
      "journalEncryptionKeyId",
      "journalPlanId",
      "journalPlanPlaintextSha256",
      "journalProviderKeyEnvelope",
      "planArtifactDigest",
      "planArtifactId",
      "planArtifactName",
      "previousCloseCommentId",
      "previousCloseMarkerSha256",
      "repository",
      "sourceRunAttempt",
      "sourceRunId",
      "sourceSha",
      "version",
    ];
    if (
      !exactKeys(marker, keys) ||
      marker.planArtifactName !==
        `gateway-webhook-rollback-plan-${marker.environment}-${marker.sourceRunId}-${marker.sourceRunAttempt}` ||
      !isPositiveIntegerString(marker.planArtifactId) ||
      !isDigest(marker.planArtifactDigest) ||
      typeof marker.journalPlanId !== "string" ||
      !/^[0-9a-f]{32}$/.test(marker.journalPlanId) ||
      !isDigest(marker.journalPlanPlaintextSha256) ||
      !isDigest(marker.journalEncryptionKeyId) ||
      typeof marker.journalProviderKeyEnvelope !== "string" ||
      !/^[A-Za-z0-9+/=]{40,2048}$/.test(marker.journalProviderKeyEnvelope) ||
      !Array.isArray(marker.journalPlanChunkCommentIds) ||
      !Array.isArray(marker.journalPlanChunkSha256) ||
      marker.journalPlanChunkCommentIds.length < 1 ||
      marker.journalPlanChunkCommentIds.length > MAX_PLAN_CHUNKS ||
      marker.journalPlanChunkCommentIds.length !==
        marker.journalPlanChunkSha256.length ||
      !marker.journalPlanChunkCommentIds.every(isPositiveIntegerString) ||
      new Set(marker.journalPlanChunkCommentIds).size !==
        marker.journalPlanChunkCommentIds.length ||
      !marker.journalPlanChunkSha256.every(isDigest) ||
      !(
        (marker.previousCloseCommentId === null &&
          marker.previousCloseMarkerSha256 === null) ||
        (isJournalReference(marker.previousCloseCommentId) &&
          isDigest(marker.previousCloseMarkerSha256))
      )
    ) {
      fail("gateway transaction OPEN marker is malformed");
    }
    return;
  }
  if (marker.kind === "rollback-intent") {
    const keys = [
      "environment",
      "candidateDeploymentEnvelope",
      "candidateDeploymentIdSha256",
      "expectedDeploymentMessageSha256",
      "failedRestorationIdSha256",
      "kind",
      "openCommentId",
      "ordinal",
      "previousIntentCommentId",
      "previousIntentMarkerSha256",
      "providerActiveTopologySha256",
      "providerDeploymentIdWatermarkSha256",
      "recoveryJobId",
      "recoveryJobName",
      "recoveryRunAttempt",
      "recoveryRunId",
      "recoveryWorkflowSha",
      "repository",
      "sourceRunAttempt",
      "sourceRunId",
      "sourceSha",
      "version",
    ];
    if (
      !exactKeys(marker, keys) ||
      !isJournalReference(marker.openCommentId) ||
      !isPositiveIntegerString(marker.recoveryRunId) ||
      !isPositiveIntegerString(marker.recoveryRunAttempt) ||
      !isPositiveIntegerString(marker.recoveryJobId) ||
      !Number.isSafeInteger(marker.ordinal) ||
      marker.ordinal < 1 ||
      marker.ordinal > MAX_ROLLBACK_ATTEMPTS ||
      !(
        (marker.ordinal === 1 &&
          marker.previousIntentCommentId === null &&
          marker.previousIntentMarkerSha256 === null &&
          marker.failedRestorationIdSha256 === null) ||
        (marker.ordinal === 2 &&
          isJournalReference(marker.previousIntentCommentId) &&
          isDigest(marker.previousIntentMarkerSha256) &&
          (marker.failedRestorationIdSha256 === null ||
            isDigest(marker.failedRestorationIdSha256)))
      ) ||
      !isDigest(marker.candidateDeploymentIdSha256) ||
      !isDigest(marker.expectedDeploymentMessageSha256) ||
      !isDigest(marker.providerActiveTopologySha256) ||
      !Array.isArray(marker.providerDeploymentIdWatermarkSha256) ||
      marker.providerDeploymentIdWatermarkSha256.length < 1 ||
      marker.providerDeploymentIdWatermarkSha256.length >
        MAX_ROLLBACK_ATTEMPTS + 1 ||
      !marker.providerDeploymentIdWatermarkSha256.every(isDigest) ||
      new Set(marker.providerDeploymentIdWatermarkSha256).size !==
        marker.providerDeploymentIdWatermarkSha256.length ||
      canonicalJson(marker.providerDeploymentIdWatermarkSha256) !==
        canonicalJson([...marker.providerDeploymentIdWatermarkSha256].sort()) ||
      typeof marker.candidateDeploymentEnvelope !== "string" ||
      !/^[A-Za-z0-9+/=]{40,2048}$/.test(marker.candidateDeploymentEnvelope) ||
      typeof marker.recoveryJobName !== "string" ||
      !marker.recoveryJobName.endsWith(
        "Reconcile Railway candidate (staging)",
      ) ||
      !isSha(marker.recoveryWorkflowSha)
    ) {
      fail("gateway transaction rollback-intent marker is malformed");
    }
    return;
  }
  if (marker.kind === "rollback-observation") {
    const keys = [
      "environment",
      "intentCommentId",
      "intentMarkerSha256",
      "kind",
      "openCommentId",
      "ordinal",
      "refinesObservationCommentId",
      "refinesObservationMarkerSha256",
      "recoveryJobId",
      "recoveryJobName",
      "recoveryRunAttempt",
      "recoveryRunId",
      "recoveryWorkflowSha",
      "repository",
      "restorationIdSha256",
      "status",
      "sourceRunAttempt",
      "sourceRunId",
      "sourceSha",
      "version",
    ];
    if (
      !exactKeys(marker, keys) ||
      !isJournalReference(marker.openCommentId) ||
      !Number.isSafeInteger(marker.ordinal) ||
      marker.ordinal < 1 ||
      marker.ordinal > MAX_ROLLBACK_ATTEMPTS ||
      !isJournalReference(marker.intentCommentId) ||
      !isDigest(marker.intentMarkerSha256) ||
      !ROLLBACK_OBSERVATION_STATUSES.has(marker.status) ||
      !(
        (marker.refinesObservationCommentId === null &&
          marker.refinesObservationMarkerSha256 === null) ||
        (marker.status !== "AMBIGUOUS" &&
          isJournalReference(marker.refinesObservationCommentId) &&
          isDigest(marker.refinesObservationMarkerSha256))
      ) ||
      !(
        (marker.status === "AMBIGUOUS" &&
          marker.restorationIdSha256 === null) ||
        (marker.status !== "AMBIGUOUS" && isDigest(marker.restorationIdSha256))
      ) ||
      !isPositiveIntegerString(marker.recoveryRunId) ||
      !isPositiveIntegerString(marker.recoveryRunAttempt) ||
      !isPositiveIntegerString(marker.recoveryJobId) ||
      typeof marker.recoveryJobName !== "string" ||
      !marker.recoveryJobName.endsWith(
        "Reconcile Railway candidate (staging)",
      ) ||
      !isSha(marker.recoveryWorkflowSha)
    ) {
      fail("gateway transaction rollback-observation marker is malformed");
    }
    return;
  }
  if (marker.kind === "close") {
    const keys = [
      "environment",
      "kind",
      "lastRollbackIntentCommentId",
      "lastRollbackIntentMarkerSha256",
      "lastRollbackObservationCommentId",
      "lastRollbackObservationMarkerSha256",
      "openCommentId",
      "recoveryJobId",
      "recoveryJobName",
      "recoveryRunAttempt",
      "recoveryRunId",
      "recoveryWorkflowSha",
      "repository",
      "resolutionArtifactDigest",
      "resolutionArtifactId",
      "resolutionArtifactName",
      "resolutionReceiptSha256",
      "result",
      "rollbackIntentCount",
      "rollbackObservationCount",
      "sourceRunAttempt",
      "sourceRunId",
      "sourceSha",
      "version",
    ];
    if (
      !exactKeys(marker, keys) ||
      !isJournalReference(marker.openCommentId) ||
      !isPositiveIntegerString(marker.recoveryRunId) ||
      !isPositiveIntegerString(marker.recoveryRunAttempt) ||
      !isPositiveIntegerString(marker.recoveryJobId) ||
      typeof marker.recoveryJobName !== "string" ||
      !marker.recoveryJobName.endsWith(
        "Reconcile Railway candidate (staging)",
      ) ||
      !isSha(marker.recoveryWorkflowSha) ||
      marker.resolutionArtifactName !==
        `gateway-webhook-reconciliation-${marker.environment}-${marker.sourceRunId}-${marker.sourceRunAttempt}-${marker.recoveryRunId}-${marker.recoveryRunAttempt}` ||
      !isPositiveIntegerString(marker.resolutionArtifactId) ||
      !isDigest(marker.resolutionArtifactDigest) ||
      !isDigest(marker.resolutionReceiptSha256) ||
      !CLOSE_RESULTS.has(marker.result) ||
      !Number.isSafeInteger(marker.rollbackIntentCount) ||
      marker.rollbackIntentCount < 0 ||
      marker.rollbackIntentCount > MAX_ROLLBACK_ATTEMPTS ||
      !Number.isSafeInteger(marker.rollbackObservationCount) ||
      marker.rollbackObservationCount < 0 ||
      marker.rollbackObservationCount > MAX_ROLLBACK_ATTEMPTS ||
      !(
        (marker.rollbackIntentCount === 0 &&
          marker.lastRollbackIntentCommentId === null &&
          marker.lastRollbackIntentMarkerSha256 === null) ||
        (marker.rollbackIntentCount > 0 &&
          isJournalReference(marker.lastRollbackIntentCommentId) &&
          isDigest(marker.lastRollbackIntentMarkerSha256))
      ) ||
      !(
        (marker.rollbackObservationCount === 0 &&
          marker.lastRollbackObservationCommentId === null &&
          marker.lastRollbackObservationMarkerSha256 === null) ||
        (marker.rollbackObservationCount > 0 &&
          isJournalReference(marker.lastRollbackObservationCommentId) &&
          isDigest(marker.lastRollbackObservationMarkerSha256))
      ) ||
      (marker.result === "prior-snapshot-restored"
        ? marker.rollbackIntentCount < 1 ||
          marker.rollbackIntentCount > MAX_ROLLBACK_ATTEMPTS ||
          marker.rollbackObservationCount !== marker.rollbackIntentCount
        : marker.result === "prior-snapshot-preserved"
          ? marker.rollbackObservationCount !== marker.rollbackIntentCount
          : marker.rollbackIntentCount !== 0 ||
            marker.rollbackObservationCount !== 0)
    ) {
      fail("gateway transaction CLOSE marker is malformed");
    }
    return;
  }
  fail("gateway transaction marker kind is unsupported");
}

function markerUsesLogicalRecordLinks(marker) {
  if (marker.kind === "open") {
    return (
      marker.previousCloseCommentId === null ||
      isDigest(marker.previousCloseCommentId)
    );
  }
  if (marker.kind === "rollback-intent") {
    return isDigest(marker.openCommentId);
  }
  if (marker.kind === "rollback-observation") {
    return isDigest(marker.openCommentId) && isDigest(marker.intentCommentId);
  }
  if (marker.kind === "close") {
    return (
      isDigest(marker.openCommentId) &&
      (marker.lastRollbackIntentCommentId === null ||
        isDigest(marker.lastRollbackIntentCommentId)) &&
      (marker.lastRollbackObservationCommentId === null ||
        isDigest(marker.lastRollbackObservationCommentId))
    );
  }
  return false;
}

export function markerBody(marker) {
  validateMarker(marker);
  const encoded = Buffer.from(canonicalJson(marker), "utf8").toString("base64");
  return `${MARKER_PREFIX}${encoded}${MARKER_SUFFIX}`;
}

function markerWithoutCommentId(marker) {
  const { commentId: _commentId, ...payload } = marker;
  return payload;
}

export function markerDigest(marker) {
  return createHash("sha256")
    .update(MARKER_DIGEST_DOMAIN)
    .update(canonicalJson(semanticMarker(markerWithoutCommentId(marker))))
    .digest("hex");
}

function planChunkBody(chunk) {
  const keys = [
    "ciphertext",
    "environment",
    "index",
    "journalPlanId",
    "kind",
    "repository",
    "sourceRunAttempt",
    "sourceRunId",
    "sourceSha",
    "total",
    "version",
  ];
  if (
    !exactKeys(chunk, keys) ||
    chunk.version !== 1 ||
    chunk.kind !== "plan-chunk" ||
    !validSource(chunk) ||
    !/^[0-9a-f]{32}$/.test(chunk.journalPlanId) ||
    !Number.isSafeInteger(chunk.index) ||
    !Number.isSafeInteger(chunk.total) ||
    chunk.index < 0 ||
    chunk.total < 1 ||
    chunk.total > MAX_PLAN_CHUNKS ||
    chunk.index >= chunk.total ||
    typeof chunk.ciphertext !== "string" ||
    !/^[A-Za-z0-9+/=]+$/.test(chunk.ciphertext) ||
    chunk.ciphertext.length > PLAN_CHUNK_CHARACTERS
  ) {
    fail("encrypted gateway rollback-plan chunk is malformed");
  }
  return `${PLAN_CHUNK_PREFIX}${Buffer.from(JSON.stringify(chunk), "utf8").toString("base64")}${MARKER_SUFFIX}`;
}

function parsePlanChunkComment(comment) {
  if (!comment?.body?.startsWith(PLAN_CHUNK_PREFIX)) return null;
  if (comment?.user?.login !== "github-actions[bot]") return null;
  if (
    comment?.user?.type !== "Bot" ||
    comment.created_at !== comment.updated_at ||
    !Number.isSafeInteger(comment.id) ||
    comment.id <= 0 ||
    !comment.body.endsWith(MARKER_SUFFIX)
  ) {
    fail("encrypted rollback-plan chunk is not an unedited bot comment");
  }
  const encoded = comment.body.slice(
    PLAN_CHUNK_PREFIX.length,
    -MARKER_SUFFIX.length,
  );
  let chunk;
  try {
    chunk = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    fail("encrypted rollback-plan chunk payload is not JSON");
  }
  if (planChunkBody(chunk) !== comment.body) {
    fail("encrypted rollback-plan chunk is not canonical");
  }
  return { ...chunk, commentId: String(comment.id) };
}

export function parseMarkerComment(comment) {
  if (!comment?.body?.startsWith(MARKER_PREFIX)) return null;
  if (comment?.user?.login !== "github-actions[bot]") return null;
  if (
    comment?.user?.type !== "Bot" ||
    comment.created_at !== comment.updated_at ||
    !Number.isSafeInteger(comment.id) ||
    comment.id <= 0
  ) {
    fail(
      "gateway transaction marker is not an unedited github-actions[bot] comment",
    );
  }
  if (!comment.body.endsWith(MARKER_SUFFIX)) {
    fail("gateway transaction marker framing is malformed");
  }
  const encoded = comment.body.slice(
    MARKER_PREFIX.length,
    -MARKER_SUFFIX.length,
  );
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    fail("gateway transaction marker encoding is malformed");
  }
  let marker;
  try {
    marker = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    fail("gateway transaction marker payload is not JSON");
  }
  if (markerBody(marker) !== comment.body) {
    fail("gateway transaction marker is not canonical");
  }
  return { ...marker, commentId: String(comment.id) };
}

function validWriter(writer, marker) {
  if (
    !exactKeys(writer, [
      "event",
      "path",
      "ref",
      "runAttempt",
      "runId",
      "sha",
    ]) ||
    !isPositiveIntegerString(writer.runId) ||
    !isPositiveIntegerString(writer.runAttempt) ||
    !isSha(writer.sha) ||
    typeof writer.path !== "string" ||
    typeof writer.event !== "string" ||
    typeof writer.ref !== "string"
  ) {
    return false;
  }
  const branch = marker.environment === "production" ? "main" : "develop";
  if (marker.kind === "open") {
    return (
      writer.runId === marker.sourceRunId &&
      writer.runAttempt === marker.sourceRunAttempt &&
      writer.sha === marker.sourceSha &&
      writer.ref === `refs/heads/${branch}` &&
      writer.path === ".github/workflows/deploy-gateway-webhook.yml" &&
      writer.event === "workflow_dispatch"
    );
  }
  return (
    writer.runId === marker.recoveryRunId &&
    writer.runAttempt === marker.recoveryRunAttempt &&
    writer.sha === marker.recoveryWorkflowSha &&
    TRUSTED_RECOVERY_PATHS.has(writer.path) &&
    ((writer.path === ".github/workflows/deploy-gateway-webhook.yml" &&
      writer.event === "workflow_dispatch" &&
      writer.ref === `refs/heads/${branch}`) ||
      (writer.path ===
        ".github/workflows/recover-gateway-webhook-transactions.yml" &&
        marker.environment === "staging" &&
        ["workflow_run", "schedule"].includes(writer.event) &&
        writer.ref === "refs/heads/develop"))
  );
}

function validCheckpointWriter(writer, environment) {
  return (
    environment === "staging" &&
    exactKeys(writer, ["event", "path", "ref", "runAttempt", "runId", "sha"]) &&
    isPositiveIntegerString(writer.runId) &&
    isPositiveIntegerString(writer.runAttempt) &&
    isSha(writer.sha) &&
    writer.ref === "refs/heads/develop" &&
    writer.path ===
      ".github/workflows/recover-gateway-webhook-transactions.yml" &&
    ["workflow_run", "schedule"].includes(writer.event)
  );
}

function unsignedRecord(marker, previousRecord, writer, authKey) {
  const record = {
    version: 1,
    kind: "marker",
    repository: marker.repository,
    environment: marker.environment,
    marker,
    previousLogicalRecordId: previousRecord?.logicalRecordId ?? null,
    previousLogicalRecordSha256: previousRecord?.recordSha256 ?? null,
    writer,
    authKeyId: journalAuthKeyId(authKey),
  };
  return {
    ...record,
    operationNonce: recordOperationNonce(record, authKey),
    logicalRecordId: logicalRecordDigest(record),
  };
}

export function journalRecordPayload(marker, previousRecord, writer, authKey) {
  const unsigned = unsignedRecord(marker, previousRecord, writer, authKey);
  return {
    ...unsigned,
    auth: recordAuthentication(unsigned, authKey),
  };
}

export function journalCheckpointPayload(
  repository,
  environment,
  previousRecord,
  writer,
  previousAuthKey,
  authKey,
) {
  const previousAuthKeyId = journalAuthKeyId(previousAuthKey);
  if (
    !isRepository(repository) ||
    !ENVIRONMENTS.has(environment) ||
    !(
      previousRecord === null ||
      (isDigest(previousRecord?.logicalRecordId) &&
        isDigest(previousRecord?.recordSha256) &&
        (previousRecord.kind === "checkpoint" ||
          (previousRecord.kind === "marker" &&
            previousRecord.marker?.kind === "close")))
    ) ||
    previousAuthKeyId === journalAuthKeyId(authKey) ||
    !validCheckpointWriter(writer, environment)
  ) {
    fail("gateway journal rekey checkpoint inputs are malformed");
  }
  const checkpointBase = {
    version: 1,
    kind: "checkpoint",
    repository,
    environment,
    checkpointState: "clear",
    previousLogicalRecordId: previousRecord?.logicalRecordId ?? null,
    previousLogicalRecordSha256: previousRecord?.recordSha256 ?? null,
    previousAuthKeyId,
    writer,
    authKeyId: journalAuthKeyId(authKey),
  };
  const checkpoint = {
    ...checkpointBase,
    operationNonce: recordOperationNonce(checkpointBase, authKey),
    logicalRecordId: logicalRecordDigest(checkpointBase),
  };
  const previousAuth = createHmac("sha256", authKeyBytes(previousAuthKey))
    .update(REKEY_PREVIOUS_AUTH_DOMAIN)
    .update(canonicalJson(checkpoint))
    .digest("hex");
  const unsigned = { ...checkpoint, previousAuth };
  return { ...unsigned, auth: recordAuthentication(unsigned, authKey) };
}

export function journalRecordDigest(record) {
  return createHash("sha256")
    .update(canonicalJson(logicalRecordPayload(record)))
    .digest("hex");
}

export function journalRecordCommentBody(record) {
  const encoded = Buffer.from(canonicalJson(record), "utf8").toString("base64");
  return `${RECORD_PREFIX}${encoded}${MARKER_SUFFIX}`;
}

function decodeRecordComment(comment) {
  if (!comment?.body?.startsWith(RECORD_PREFIX)) return null;
  if (
    comment?.user?.login !== "github-actions[bot]" ||
    comment?.user?.type !== "Bot" ||
    typeof comment?.created_at !== "string" ||
    !Number.isFinite(Date.parse(comment.created_at)) ||
    typeof comment?.updated_at !== "string" ||
    !Number.isFinite(Date.parse(comment.updated_at)) ||
    comment.updated_at !== comment.created_at ||
    !Number.isSafeInteger(comment?.id) ||
    comment.id <= 0 ||
    !comment.body.endsWith(MARKER_SUFFIX)
  ) {
    return null;
  }
  const encoded = comment.body.slice(
    RECORD_PREFIX.length,
    -MARKER_SUFFIX.length,
  );
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    return null;
  }
  let record;
  try {
    record = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (journalRecordCommentBody(record) !== comment.body) return null;
  return {
    record,
    recordId: String(comment.id),
    createdAt: comment.created_at,
  };
}

function checkpointWithoutAuthenticators(record) {
  const { auth: _auth, previousAuth: _previousAuth, ...checkpoint } = record;
  return checkpoint;
}

function parseJournalRecordComment(comment, repository, environment, authKey) {
  const decoded = decodeRecordComment(comment);
  if (!decoded) return null;
  const { record } = decoded;
  const currentAuthKeyId = journalAuthKeyId(authKey);
  const { auth, ...unsigned } = record ?? {};
  const currentAuthValid =
    record?.authKeyId === currentAuthKeyId &&
    isDigest(auth) &&
    exactDigestEqual(auth, recordAuthentication(unsigned, authKey));
  const supersedingCheckpoint =
    record?.kind === "checkpoint" &&
    record?.previousAuthKeyId === currentAuthKeyId &&
    isDigest(record?.previousAuth) &&
    exactDigestEqual(
      record.previousAuth,
      createHmac("sha256", authKeyBytes(authKey))
        .update(REKEY_PREVIOUS_AUTH_DOMAIN)
        .update(canonicalJson(checkpointWithoutAuthenticators(record)))
        .digest("hex"),
    );
  if (!currentAuthValid && !supersedingCheckpoint) return null;
  const markerKeys = [
    "auth",
    "authKeyId",
    "environment",
    "kind",
    "logicalRecordId",
    "marker",
    "operationNonce",
    "previousLogicalRecordId",
    "previousLogicalRecordSha256",
    "repository",
    "version",
    "writer",
  ];
  const checkpointKeys = [
    "auth",
    "authKeyId",
    "checkpointState",
    "environment",
    "kind",
    "logicalRecordId",
    "operationNonce",
    "previousAuth",
    "previousAuthKeyId",
    "previousLogicalRecordId",
    "previousLogicalRecordSha256",
    "repository",
    "version",
    "writer",
  ];
  if (
    !exactKeys(
      record,
      record?.kind === "checkpoint" ? checkpointKeys : markerKeys,
    ) ||
    record.version !== 1 ||
    !["marker", "checkpoint"].includes(record.kind) ||
    record.repository !== repository ||
    record.environment !== environment ||
    !isDigest(record.authKeyId) ||
    !isDigest(record.logicalRecordId) ||
    record.logicalRecordId !== logicalRecordDigest(record) ||
    !/^[0-9a-f]{32}$/.test(record.operationNonce) ||
    (currentAuthValid &&
      record.operationNonce !== recordOperationNonce(record, authKey)) ||
    !(
      (record.previousLogicalRecordId === null &&
        record.previousLogicalRecordSha256 === null) ||
      (isDigest(record.previousLogicalRecordId) &&
        isDigest(record.previousLogicalRecordSha256))
    ) ||
    !isDigest(record.auth)
  ) {
    fail("authenticated gateway journal record is malformed");
  }
  if (record.kind === "marker") {
    if (
      record.marker?.repository !== repository ||
      record.marker?.environment !== environment
    ) {
      fail("gateway journal marker target is malformed");
    }
    validateMarker(record.marker);
    if (!markerUsesLogicalRecordLinks(record.marker)) {
      fail("gateway journal marker does not use logical record links");
    }
    if (!validWriter(record.writer, record.marker)) {
      fail("gateway journal writer does not bind the exact workflow authority");
    }
  } else if (
    record.checkpointState !== "clear" ||
    !isDigest(record.previousAuthKeyId) ||
    !isDigest(record.previousAuth) ||
    record.previousAuthKeyId === record.authKeyId ||
    !validCheckpointWriter(record.writer, environment)
  ) {
    fail("gateway journal rekey checkpoint is malformed");
  }
  if (supersedingCheckpoint && !currentAuthValid) {
    const parsed = {
      ...record,
      kind: "superseded",
      recordId: record.logicalRecordId,
      commentId: decoded.recordId,
      createdAt: decoded.createdAt,
    };
    return { ...parsed, recordSha256: journalRecordDigest(record) };
  }
  const parsed = {
    ...record,
    recordId: record.logicalRecordId,
    commentId: decoded.recordId,
    createdAt: decoded.createdAt,
  };
  return { ...parsed, recordSha256: journalRecordDigest(record) };
}

function markerAsComment(record) {
  return {
    id: Number(record.commentId),
    body: markerBody(record.marker),
    created_at: record.createdAt,
    updated_at: record.createdAt,
    user: { login: "github-actions[bot]", type: "Bot" },
  };
}

function reduceMarkers(markers, repository, environment, initialClose = null) {
  if (!isRepository(repository) || !ENVIRONMENTS.has(environment)) {
    fail("invalid gateway transaction journal target");
  }
  let open = null;
  let rollbackIntent = null;
  let rollbackIntents = [];
  let rollbackObservation = null;
  let rollbackObservations = [];
  let lastRollbackObservationMarker = null;
  let lastClose = initialClose;
  const closes = [];
  const rollbackMarkers = [];
  for (const marker of markers) {
    if (marker.kind === "open") {
      if (open)
        fail(
          `${environment} gateway journal contains overlapping OPEN markers`,
        );
      const expectedPreviousId = lastClose?.commentId ?? null;
      const expectedPreviousDigest = lastClose ? markerDigest(lastClose) : null;
      if (
        marker.previousCloseCommentId !== expectedPreviousId ||
        marker.previousCloseMarkerSha256 !== expectedPreviousDigest
      ) {
        fail(
          `${environment} gateway journal OPEN does not extend the exact CLOSE hash chain`,
        );
      }
      open = marker;
      rollbackIntent = null;
      rollbackIntents = [];
      rollbackObservation = null;
      rollbackObservations = [];
      lastRollbackObservationMarker = null;
      continue;
    }
    if (!open) {
      fail(
        `${environment} gateway journal contains an orphan ${marker.kind} marker`,
      );
    }
    if (!sameSource(open, marker) || marker.openCommentId !== open.commentId) {
      fail(
        `${environment} gateway journal marker does not bind the current OPEN`,
      );
    }
    if (marker.kind === "rollback-intent") {
      const previousIntent = rollbackIntent;
      const previousObservation = rollbackObservation;
      if (
        rollbackIntents.length >= MAX_ROLLBACK_ATTEMPTS ||
        rollbackObservations.length !== rollbackIntents.length ||
        marker.ordinal !== rollbackIntents.length + 1 ||
        (marker.ordinal === 1
          ? marker.previousIntentCommentId !== null ||
            marker.previousIntentMarkerSha256 !== null ||
            marker.failedRestorationIdSha256 !== null
          : !previousIntent ||
            !previousObservation ||
            ROLLBACK_READY_STATUSES.has(previousObservation.status) ||
            marker.previousIntentCommentId !== previousIntent.commentId ||
            marker.previousIntentMarkerSha256 !==
              markerDigest(previousIntent) ||
            marker.failedRestorationIdSha256 !==
              previousObservation.restorationIdSha256 ||
            marker.candidateDeploymentIdSha256 !==
              rollbackIntents[0].candidateDeploymentIdSha256 ||
            marker.expectedDeploymentMessageSha256 !==
              rollbackIntents[0].expectedDeploymentMessageSha256)
      ) {
        fail(
          `${environment} gateway journal rollback intents are not one bounded linear sequence`,
        );
      }
      rollbackIntent = marker;
      rollbackIntents.push(marker);
      rollbackMarkers.push(marker);
      continue;
    }
    if (marker.kind === "rollback-observation") {
      const intent = rollbackIntents[marker.ordinal - 1] ?? null;
      const existing = rollbackObservations[marker.ordinal - 1] ?? null;
      const refinement = marker.refinesObservationCommentId !== null;
      const initialValid =
        !refinement &&
        !existing &&
        marker.ordinal === rollbackIntents.length &&
        rollbackObservations.length === rollbackIntents.length - 1;
      const refinementValid =
        refinement &&
        existing?.status === "AMBIGUOUS" &&
        marker.status !== "AMBIGUOUS" &&
        marker.refinesObservationCommentId === existing.commentId &&
        marker.refinesObservationMarkerSha256 === markerDigest(existing) &&
        rollbackObservations.length === rollbackIntents.length;
      if (
        !intent ||
        marker.intentCommentId !== intent.commentId ||
        marker.intentMarkerSha256 !== markerDigest(intent) ||
        !ROLLBACK_OBSERVATION_STATUSES.has(marker.status) ||
        (!initialValid && !refinementValid)
      ) {
        fail(
          `${environment} gateway journal rollback observation does not bind or uniquely refine its intent`,
        );
      }
      if (
        ROLLBACK_READY_STATUSES.has(marker.status) &&
        rollbackObservations.some(
          (observation, index) =>
            index !== marker.ordinal - 1 &&
            ROLLBACK_READY_STATUSES.has(observation.status),
        )
      ) {
        fail(
          `${environment} gateway journal contains multiple ready rollback observations`,
        );
      }
      if (refinement) rollbackObservations[marker.ordinal - 1] = marker;
      else rollbackObservations.push(marker);
      rollbackObservation = rollbackObservations.at(-1) ?? null;
      lastRollbackObservationMarker = marker;
      rollbackMarkers.push(marker);
      continue;
    }
    if (
      marker.rollbackIntentCount !== rollbackIntents.length ||
      marker.lastRollbackIntentCommentId !==
        (rollbackIntent?.commentId ?? null) ||
      marker.lastRollbackIntentMarkerSha256 !==
        (rollbackIntent ? markerDigest(rollbackIntent) : null) ||
      marker.rollbackObservationCount !== rollbackObservations.length ||
      marker.lastRollbackObservationCommentId !==
        (lastRollbackObservationMarker?.commentId ?? null) ||
      marker.lastRollbackObservationMarkerSha256 !==
        (lastRollbackObservationMarker
          ? markerDigest(lastRollbackObservationMarker)
          : null) ||
      rollbackObservations.length !== rollbackIntents.length ||
      (marker.result === "prior-snapshot-restored" &&
        !rollbackObservations.some((observation) =>
          ROLLBACK_READY_STATUSES.has(observation.status),
        )) ||
      (marker.result === "prior-snapshot-preserved" &&
        rollbackObservations.some((observation) =>
          ROLLBACK_READY_STATUSES.has(observation.status),
        )) ||
      (!["prior-snapshot-restored", "prior-snapshot-preserved"].includes(
        marker.result,
      ) &&
        rollbackIntents.length > 0)
    ) {
      fail(
        `${environment} gateway journal CLOSE does not bind the exact rollback-intent sequence`,
      );
    }
    lastClose = { ...marker, openCommentId: open.commentId };
    closes.push(lastClose);
    open = null;
    rollbackIntent = null;
    rollbackIntents = [];
    rollbackObservation = null;
    rollbackObservations = [];
    lastRollbackObservationMarker = null;
  }
  return {
    version: 1,
    environment,
    status: open ? "open" : "clear",
    open,
    rollbackIntent,
    rollbackIntents,
    rollbackObservation,
    rollbackObservations,
    lastRollbackObservationMarker,
    rollbackMarkers,
    lastClose,
    closes,
  };
}

export function reduceJournal(
  comments,
  repository,
  environment,
  initialClose = null,
) {
  const markers = comments
    .map(parseMarkerComment)
    .filter(Boolean)
    .filter(
      (marker) =>
        marker.repository === repository && marker.environment === environment,
    )
    .sort((left, right) => Number(left.commentId) - Number(right.commentId));
  return reduceMarkers(markers, repository, environment, initialClose);
}

export class GitHubApi {
  constructor({ token, repository, apiUrl = "https://api.github.com" }) {
    if (!token || !isRepository(repository))
      fail("GitHub journal credentials are missing");
    this.token = token;
    this.repository = repository;
    this.apiUrl = apiUrl.replace(/\/$/, "");
  }

  async request(method, endpoint, body) {
    const response = await fetch(
      `${this.apiUrl}/repos/${this.repository}${endpoint}`,
      {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": API_VERSION,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const text = await response.text();
    if (!response.ok) {
      fail(
        `GitHub ${method} ${endpoint} failed (${response.status}): ${text.slice(0, 200)}`,
      );
    }
    return text ? JSON.parse(text) : null;
  }
}

async function paginatedJobs(api, endpoint) {
  const jobs = [];
  let totalCount = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const response = await api.request(
      "GET",
      `${endpoint}${separator}per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (
      !response ||
      typeof response !== "object" ||
      Array.isArray(response) ||
      !Number.isSafeInteger(response.total_count) ||
      response.total_count < 0 ||
      !Array.isArray(response.jobs) ||
      response.jobs.length > PAGE_SIZE ||
      (totalCount !== null && response.total_count !== totalCount)
    ) {
      fail("GitHub Actions jobs pagination returned a malformed envelope");
    }
    totalCount ??= response.total_count;
    jobs.push(...response.jobs);
    if (jobs.length > totalCount) {
      fail("GitHub Actions jobs pagination exceeded total_count");
    }
    if (jobs.length === totalCount) return jobs;
    if (response.jobs.length === 0) {
      fail("GitHub Actions jobs pagination ended before total_count");
    }
  }
  fail(
    `GitHub Actions jobs exceed the fail-closed ${MAX_PAGES * PAGE_SIZE}-job bound`,
  );
}

async function artifactDiscoveryRequest(api, budget, endpoint) {
  if (budget.used >= ARTIFACT_DISCOVERY_REQUEST_BUDGET) {
    fail(
      `gateway prepared-OPEN discovery exceeded its fail-closed ${ARTIFACT_DISCOVERY_REQUEST_BUDGET}-request budget`,
    );
  }
  budget.used += 1;
  return api.request("GET", endpoint);
}

async function completeRunArtifactScan(api, runId, purpose, budget) {
  const artifacts = [];
  const seenIds = new Set();
  let totalCount = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await artifactDiscoveryRequest(
      api,
      budget,
      `/actions/runs/${runId}/artifacts?per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (
      !response ||
      typeof response !== "object" ||
      Array.isArray(response) ||
      !Number.isSafeInteger(response.total_count) ||
      response.total_count < 0 ||
      !Array.isArray(response.artifacts) ||
      response.artifacts.length > PAGE_SIZE ||
      (totalCount !== null && response.total_count !== totalCount)
    ) {
      fail(
        `gateway ${purpose} artifact pagination returned a malformed envelope`,
      );
    }
    totalCount ??= response.total_count;
    for (const artifact of response.artifacts) {
      if (
        !Number.isSafeInteger(artifact?.id) ||
        artifact.id <= 0 ||
        seenIds.has(artifact.id)
      ) {
        fail(
          `gateway ${purpose} artifact pagination returned duplicate or malformed ids`,
        );
      }
      seenIds.add(artifact.id);
      artifacts.push(artifact);
    }
    if (artifacts.length > totalCount) {
      fail(`gateway ${purpose} artifact pagination exceeded total_count`);
    }
    if (artifacts.length === totalCount) {
      return artifacts.sort((left, right) => left.id - right.id);
    }
    if (response.artifacts.length === 0) {
      fail(`gateway ${purpose} artifact pagination ended before total_count`);
    }
  }
  fail(
    `gateway ${purpose} artifacts exceed the fail-closed ${MAX_PAGES * PAGE_SIZE}-artifact bound`,
  );
}

function runCanRetainUnresolvedPreparedOpen(run, retentionCutoff) {
  if (typeof run?.status !== "string") {
    fail("gateway prepared-OPEN workflow run has no valid status");
  }
  if (run.status !== "completed") return true;
  const updatedAt = Date.parse(run.updated_at ?? "");
  const completedAt = Date.parse(run.completed_at ?? "");
  if (!Number.isFinite(updatedAt) || !Number.isFinite(completedAt)) {
    fail(
      "gateway prepared-OPEN completed workflow run has malformed timestamps",
    );
  }
  return Math.max(updatedAt, completedAt) >= retentionCutoff;
}

async function completeGatewayDeployArtifactScan(
  api,
  purpose,
  retentionCutoff,
  budget,
) {
  const runs = [];
  const seenRunIds = new Set();
  let totalCount = null;
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await artifactDiscoveryRequest(
      api,
      budget,
      `/actions/workflows/deploy-gateway-webhook.yml/runs?branch=develop&event=workflow_dispatch&per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (
      !response ||
      typeof response !== "object" ||
      Array.isArray(response) ||
      !Number.isSafeInteger(response.total_count) ||
      response.total_count < 0 ||
      !Array.isArray(response.workflow_runs) ||
      response.workflow_runs.length > PAGE_SIZE ||
      (totalCount !== null && response.total_count !== totalCount)
    ) {
      fail(
        `gateway ${purpose} workflow-run pagination returned a malformed envelope`,
      );
    }
    totalCount ??= response.total_count;
    for (const run of response.workflow_runs) {
      if (
        !Number.isSafeInteger(run?.id) ||
        run.id <= 0 ||
        seenRunIds.has(run.id) ||
        run?.head_branch !== "develop" ||
        run?.event !== "workflow_dispatch"
      ) {
        fail(
          `gateway ${purpose} workflow-run pagination returned an invalid run`,
        );
      }
      seenRunIds.add(run.id);
      if (runCanRetainUnresolvedPreparedOpen(run, retentionCutoff)) {
        runs.push(run);
      }
    }
    if (seenRunIds.size > totalCount) {
      fail(`gateway ${purpose} workflow-run pagination exceeded total_count`);
    }
    if (seenRunIds.size === totalCount) break;
    if (response.workflow_runs.length === 0) {
      fail(
        `gateway ${purpose} workflow-run pagination ended before total_count`,
      );
    }
    if (page === MAX_PAGES) {
      fail(
        `gateway ${purpose} deploy runs exceed the fail-closed ${MAX_PAGES * PAGE_SIZE}-run bound`,
      );
    }
  }
  const artifacts = [];
  const seenArtifactIds = new Set();
  for (const run of runs) {
    const runArtifacts = await completeRunArtifactScan(
      api,
      run.id,
      purpose,
      budget,
    );
    for (const artifact of runArtifacts) {
      if (seenArtifactIds.has(artifact.id)) {
        fail(`gateway ${purpose} artifact appears in multiple source runs`);
      }
      seenArtifactIds.add(artifact.id);
      artifacts.push(artifact);
    }
  }
  return artifacts.sort((left, right) => left.id - right.id);
}

async function stableArtifactScan(api, purpose) {
  let previousFingerprint = null;
  const retentionCutoff = Date.now() - ARTIFACT_RETENTION_HORIZON_MS;
  const budget = { used: 0 };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const artifacts = await completeGatewayDeployArtifactScan(
      api,
      purpose,
      retentionCutoff,
      budget,
    );
    const fingerprint = createHash("sha256")
      .update(canonicalJson(artifacts))
      .digest("hex");
    if (fingerprint === previousFingerprint) return artifacts;
    previousFingerprint = fingerprint;
  }
  fail(`gateway ${purpose} artifact pagination did not stabilize`);
}

async function validateReferencedSourceAttempt(api, marker) {
  const run = await api.request(
    "GET",
    `/actions/runs/${marker.sourceRunId}/attempts/${marker.sourceRunAttempt}`,
  );
  if (
    String(run?.id) !== marker.sourceRunId ||
    String(run?.run_attempt) !== marker.sourceRunAttempt ||
    run?.head_sha !== marker.sourceSha ||
    run?.head_branch !==
      (run?.path === ".github/workflows/deploy-gateway-webhook.yml"
        ? marker.environment === "production"
          ? "main"
          : "develop"
        : "develop") ||
    run?.head_repository?.full_name !== marker.repository ||
    run?.path !== ".github/workflows/deploy-gateway-webhook.yml" ||
    run?.event !== "workflow_dispatch"
  ) {
    fail("gateway transaction marker is not bound to an exact source attempt");
  }
  return {
    event: run.event,
    path: run.path,
    ref: `refs/heads/${run.head_branch}`,
    runAttempt: String(run.run_attempt),
    runId: String(run.id),
    sha: run.head_sha,
  };
}

export async function validateSourceAttempt(api, marker, runtime) {
  const expectedRef = `refs/heads/${
    marker.environment === "production" ? "main" : "develop"
  }`;
  if (
    runtime.GITHUB_REPOSITORY !== marker.repository ||
    runtime.GITHUB_RUN_ID !== marker.sourceRunId ||
    runtime.GITHUB_RUN_ATTEMPT !== marker.sourceRunAttempt ||
    runtime.GITHUB_SHA !== marker.sourceSha ||
    runtime.GITHUB_REF !== expectedRef ||
    runtime.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    runtime.GITHUB_WORKFLOW_REF !==
      `${marker.repository}/.github/workflows/deploy-gateway-webhook.yml@${expectedRef}`
  ) {
    fail("gateway transaction OPEN is not owned by the current source process");
  }
  return validateReferencedSourceAttempt(api, marker);
}

async function validateCurrentDevelopHead(api, expectedSha) {
  const branch = await api.request("GET", "/branches/develop");
  if (
    branch?.name !== "develop" ||
    branch?.commit?.sha !== expectedSha ||
    !isSha(branch.commit.sha)
  ) {
    fail(
      "automatic gateway recovery is not running from the current develop head",
    );
  }
}

export async function validateCurrentRecoveryAttempt(api, marker) {
  const run = await api.request(
    "GET",
    `/actions/runs/${marker.recoveryRunId}/attempts/${marker.recoveryRunAttempt}`,
  );
  if (
    String(run?.id) !== marker.recoveryRunId ||
    String(run?.run_attempt) !== marker.recoveryRunAttempt ||
    run?.head_sha !== marker.recoveryWorkflowSha ||
    run?.head_branch !==
      (run?.path === ".github/workflows/deploy-gateway-webhook.yml"
        ? marker.environment === "production"
          ? "main"
          : "develop"
        : "develop") ||
    run?.head_repository?.full_name !== marker.repository ||
    !TRUSTED_RECOVERY_PATHS.has(run?.path) ||
    !(
      (run.path === ".github/workflows/deploy-gateway-webhook.yml" &&
        run.event === "workflow_dispatch") ||
      (run.path ===
        ".github/workflows/recover-gateway-webhook-transactions.yml" &&
        marker.environment === "staging" &&
        ["workflow_run", "schedule"].includes(run.event))
    ) ||
    run?.status !== "in_progress"
  ) {
    fail(
      "current gateway marker is not bound to an exact protected recovery attempt",
    );
  }
  if (marker.environment === "staging") {
    await validateCurrentDevelopHead(api, marker.recoveryWorkflowSha);
  }
  return {
    event: run.event,
    path: run.path,
    ref: `refs/heads/${run.head_branch}`,
    runAttempt: String(run.run_attempt),
    runId: String(run.id),
    sha: run.head_sha,
  };
}

function restorationIdDigest(value) {
  if (!isUuid(value)) return null;
  return createHash("sha256")
    .update(RESTORATION_ID_DIGEST_DOMAIN)
    .update(value)
    .digest("hex");
}

function candidateIdDigest(value) {
  if (!isUuid(value)) return null;
  return createHash("sha256")
    .update(CANDIDATE_ID_DIGEST_DOMAIN)
    .update(value)
    .digest("hex");
}

export function providerDeploymentIdDigest(value) {
  if (!isUuid(value)) return null;
  return createHash("sha256")
    .update(PROVIDER_DEPLOYMENT_ID_DIGEST_DOMAIN)
    .update(value)
    .digest("hex");
}

function candidateMessageDigest(value) {
  if (typeof value !== "string") return null;
  return createHash("sha256")
    .update(CANDIDATE_MESSAGE_DIGEST_DOMAIN)
    .update(value)
    .digest("hex");
}

async function validateRekeyAttempt(api, repository, environment, runtime) {
  const runId = runtime.GITHUB_RUN_ID;
  const runAttempt = runtime.GITHUB_RUN_ATTEMPT;
  const workflowSha = runtime.GITHUB_SHA;
  if (
    !isPositiveIntegerString(runId) ||
    !isPositiveIntegerString(runAttempt) ||
    !isSha(workflowSha)
  ) {
    fail("current journal rekey workflow identity is invalid");
  }
  const run = await api.request(
    "GET",
    `/actions/runs/${runId}/attempts/${runAttempt}`,
  );
  if (
    String(run?.id) !== runId ||
    String(run?.run_attempt) !== runAttempt ||
    run?.head_sha !== workflowSha ||
    run?.head_branch !== "develop" ||
    run?.head_repository?.full_name !== repository ||
    run?.path !==
      ".github/workflows/recover-gateway-webhook-transactions.yml" ||
    !["workflow_run", "schedule"].includes(run?.event) ||
    run?.status !== "in_progress" ||
    environment !== "staging"
  ) {
    fail("journal rekey is not bound to the protected recovery authority");
  }
  await validateCurrentDevelopHead(api, workflowSha);
  return {
    event: run.event,
    path: run.path,
    ref: `refs/heads/${run.head_branch}`,
    runAttempt: String(run.run_attempt),
    runId: String(run.id),
    sha: run.head_sha,
  };
}

async function journalRecordGraph(
  api,
  repository,
  environment,
  authKey,
  allowForeignOnly = false,
  allowSupersededHead = false,
) {
  let sawTargetRecord = false;
  let sawInvalidClaimedCurrentKeyRecord = false;
  const currentAuthKeyId = journalAuthKeyId(authKey);
  const records = [];
  const foreignKeyRecords = [];
  const comments = await stableIssueCommentScan(api, "journal head");
  for (const comment of comments) {
    const claimedBotRecord =
      comment?.body?.startsWith(RECORD_PREFIX) &&
      comment?.user?.login === "github-actions[bot]" &&
      comment?.user?.type === "Bot";
    const decoded = decodeRecordComment(comment);
    if (claimedBotRecord && !decoded) {
      fail("gateway journal record-prefix comment was edited or is malformed");
    }
    if (
      claimedBotRecord &&
      (decoded.record?.repository !== repository ||
        decoded.record?.environment !== environment)
    ) {
      fail("gateway journal record-prefix comment claims a foreign namespace");
    }
    if (
      decoded?.record?.repository === repository &&
      decoded.record.environment === environment
    ) {
      sawTargetRecord = true;
    }
    const record = parseJournalRecordComment(
      comment,
      repository,
      environment,
      authKey,
    );
    if (!record) {
      if (
        decoded?.record?.repository === repository &&
        decoded.record.environment === environment &&
        decoded.record.authKeyId === currentAuthKeyId
      ) {
        sawInvalidClaimedCurrentKeyRecord = true;
      } else if (decoded) {
        foreignKeyRecords.push({
          createdAt: decoded.createdAt,
          commentId: decoded.recordId,
        });
      }
      continue;
    }
    records.push(record);
  }
  if (sawInvalidClaimedCurrentKeyRecord) {
    fail(
      `${environment} gateway journal contains a record that claims the protected key but fails authentication`,
    );
  }
  if (records.length === 0 && sawTargetRecord && !allowForeignOnly) {
    fail(
      `${environment} gateway journal has records but no head authenticated by the protected key`,
    );
  }
  if (records.length === 0) return null;

  // Identical, independently accepted POSTs are physical aliases of one
  // logical node. The HMAC-authenticated logical id and parent digest, never a
  // server comment id, define ancestry.
  const groups = new Map();
  for (const record of records) {
    const existing = groups.get(record.logicalRecordId);
    const payload = canonicalJson(logicalRecordPayload(record));
    if (existing && existing.payload !== payload) {
      fail(
        `${environment} gateway journal logical id has conflicting payloads`,
      );
    }
    if (existing) {
      existing.aliases.push(record);
    } else {
      groups.set(record.logicalRecordId, { aliases: [record], payload });
    }
  }
  const nodes = new Map();
  for (const [logicalId, group] of groups) {
    group.aliases.sort(
      (left, right) => Number(left.commentId) - Number(right.commentId),
    );
    const representative = group.aliases[0];
    nodes.set(logicalId, {
      ...representative,
      recordId: logicalId,
      physicalCommentIds: group.aliases.map((alias) => alias.commentId),
    });
  }
  const children = new Map();
  const roots = [];
  for (const node of nodes.values()) {
    const parentId = node.previousLogicalRecordId;
    if (parentId === null) {
      if (
        !(
          node.kind === "checkpoint" ||
          node.kind === "superseded" ||
          (node.kind === "marker" && node.marker.kind === "open")
        ) ||
        node.previousLogicalRecordSha256 !== null
      ) {
        fail(
          `${environment} gateway journal authenticated history has no canonical root`,
        );
      }
      roots.push(node);
      continue;
    }
    const parent = nodes.get(parentId);
    if (!parent) {
      // A current-key checkpoint deliberately roots a new key epoch while its
      // dual authenticator points at the prior, now-foreign epoch.
      if (node.kind === "checkpoint") {
        roots.push(node);
        continue;
      }
      fail(`${environment} gateway journal logical parent is missing`);
    }
    if (node.previousLogicalRecordSha256 !== parent.recordSha256) {
      fail(`${environment} gateway journal logical parent digest changed`);
    }
    const childSet = children.get(parentId) ?? new Set();
    childSet.add(node.logicalRecordId);
    children.set(parentId, childSet);
    if (childSet.size > 1) {
      fail(`${environment} gateway journal contains distinct logical siblings`);
    }
  }
  if (roots.length !== 1) {
    fail(`${environment} gateway journal does not have one logical root`);
  }
  const chain = [];
  const visited = new Set();
  let cursor = roots[0];
  while (cursor) {
    if (visited.has(cursor.logicalRecordId)) {
      fail(`${environment} gateway journal logical chain contains a cycle`);
    }
    visited.add(cursor.logicalRecordId);
    chain.push(cursor);
    const childIds = children.get(cursor.logicalRecordId);
    cursor = childIds?.size === 1 ? nodes.get([...childIds][0]) : null;
  }
  if (visited.size !== nodes.size) {
    fail(`${environment} gateway journal contains a disconnected logical fork`);
  }
  if (foreignKeyRecords.length > 0) {
    const oldestAuthenticated = chain[0];
    const newestAuthenticated = chain.at(-1);
    const precedes = (foreign, authenticated) => {
      const foreignCreatedAt = Date.parse(foreign.createdAt);
      const authenticatedCreatedAt = Date.parse(authenticated.createdAt);
      return (
        foreignCreatedAt < authenticatedCreatedAt ||
        (foreignCreatedAt === authenticatedCreatedAt &&
          Number(foreign.commentId) < Number(authenticated.commentId))
      );
    };
    const outsideAuthenticatedEpoch = foreignKeyRecords.every((foreign) => {
      if (
        oldestAuthenticated?.kind === "checkpoint" &&
        precedes(foreign, oldestAuthenticated)
      ) {
        return true;
      }
      return (
        newestAuthenticated?.kind === "superseded" &&
        precedes(newestAuthenticated, foreign)
      );
    });
    if (!outsideAuthenticatedEpoch) {
      fail(
        `${environment} gateway journal contains an untrusted foreign-key record outside an authenticated rotation checkpoint`,
      );
    }
  }
  const head = chain.at(-1);
  if (head.kind === "superseded" && !allowSupersededHead) {
    fail(
      `${environment} gateway journal key was superseded by an authenticated rotation checkpoint`,
    );
  }
  return { chain, head, root: chain[0], nodes };
}

async function verifyRekeyTransition(
  api,
  repository,
  environment,
  checkpoint,
  previousAuthKey,
) {
  const previousGraph = await journalRecordGraph(
    api,
    repository,
    environment,
    previousAuthKey,
    false,
    true,
  );
  const head = previousGraph?.head ?? null;
  if (
    head?.kind !== "superseded" ||
    head.logicalRecordId !== checkpoint.logicalRecordId ||
    head.recordSha256 !== journalRecordDigest(checkpoint) ||
    head.previousLogicalRecordId !==
      (checkpoint.previousLogicalRecordId ?? null) ||
    head.previousLogicalRecordSha256 !==
      (checkpoint.previousLogicalRecordSha256 ?? null)
  ) {
    fail(
      "gateway journal rekey checkpoint lacks the exact previous-key head authorization",
    );
  }
  const previousNode = previousGraph.chain.at(-2) ?? null;
  if (
    (previousNode?.logicalRecordId ?? null) !==
      (checkpoint.previousLogicalRecordId ?? null) ||
    (previousNode?.recordSha256 ?? null) !==
      (checkpoint.previousLogicalRecordSha256 ?? null)
  ) {
    fail(
      "gateway journal rekey checkpoint does not extend the previous key head",
    );
  }
  return head;
}

async function journalRecordHead(
  api,
  repository,
  environment,
  authKey,
  allowForeignOnly = false,
) {
  return (
    (
      await journalRecordGraph(
        api,
        repository,
        environment,
        authKey,
        allowForeignOnly,
      )
    )?.head ?? null
  );
}

async function completeIssueCommentScan(api, purpose) {
  const allComments = [];
  const seenIds = new Set();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const pageComments = await api.request(
      "GET",
      `/issues/${JOURNAL_ISSUE}/comments?sort=created&direction=desc&per_page=${PAGE_SIZE}&page=${page}`,
    );
    if (!Array.isArray(pageComments) || pageComments.length > PAGE_SIZE) {
      fail(`gateway ${purpose} pagination returned a malformed page`);
    }
    for (const comment of pageComments) {
      if (
        !Number.isSafeInteger(comment?.id) ||
        comment.id <= 0 ||
        seenIds.has(comment.id)
      ) {
        fail(
          `gateway ${purpose} pagination returned duplicate or malformed ids`,
        );
      }
      seenIds.add(comment.id);
      allComments.push(comment);
    }
    if (pageComments.length < PAGE_SIZE) {
      return allComments.sort((left, right) => left.id - right.id);
    }
  }
  fail(
    `gateway ${purpose} is hidden beyond the fail-closed ${MAX_PAGES * PAGE_SIZE}-comment bound`,
  );
}

async function stableIssueCommentScan(api, purpose) {
  let previousFingerprint = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const comments = await completeIssueCommentScan(api, purpose);
    const fingerprint = createHash("sha256")
      .update(
        canonicalJson(
          comments.map((comment) => ({
            body: comment?.body,
            createdAt: comment?.created_at,
            id: comment.id,
            updatedAt: comment?.updated_at,
            userLogin: comment?.user?.login,
            userType: comment?.user?.type,
          })),
        ),
      )
      .digest("hex");
    if (fingerprint === previousFingerprint) return comments;
    previousFingerprint = fingerprint;
  }
  fail(`gateway ${purpose} pagination did not stabilize across complete scans`);
}

export async function readJournalState(
  api,
  repository,
  environment,
  authKey,
  { allowForeignOnly = false } = {},
) {
  if (!isRepository(repository) || !ENVIRONMENTS.has(environment)) {
    fail("invalid gateway transaction journal target");
  }
  if (environment !== "staging") {
    fail(
      "production gateway transaction journaling is BLOCKED on #29488 until an exact main recovery authority exists",
    );
  }
  authKeyBytes(authKey);
  const graph = await journalRecordGraph(
    api,
    repository,
    environment,
    authKey,
    allowForeignOnly,
  );
  if (!graph) {
    return {
      ...reduceJournal([], repository, environment),
      openCreatedAt: null,
      rollbackIntentCreatedAts: [],
      logicalRecordIds: [],
      latestRecord: null,
      rootRecord: null,
    };
  }
  const { chain, head: latest, root } = graph;
  if (latest.kind === "checkpoint") {
    return {
      ...reduceJournal([], repository, environment),
      openCreatedAt: null,
      rollbackIntentCreatedAts: [],
      logicalRecordIds: chain.map((record) => record.logicalRecordId),
      latestRecord: latest,
      rootRecord: root,
    };
  }
  const markers = chain
    .filter((record) => record.kind === "marker")
    .map((record) => ({ ...record.marker, commentId: record.logicalRecordId }));
  const state = reduceMarkers(markers, repository, environment);
  const openRecord = state.open
    ? chain.find((record) => record.logicalRecordId === state.open.commentId)
    : null;
  const rollbackIntentCreatedAts = state.rollbackIntents.map((intent) => {
    const record = chain.find(
      (candidate) => candidate.logicalRecordId === intent.commentId,
    );
    if (!record?.createdAt) {
      fail("durable rollback intent lacks its authenticated creation time");
    }
    return record.createdAt;
  });
  return {
    ...state,
    openCreatedAt: openRecord?.createdAt ?? null,
    rollbackIntentCreatedAts,
    logicalRecordIds: chain.map((record) => record.logicalRecordId),
    latestRecord: latest,
    rootRecord: root,
  };
}

async function recentExactComments(api, body, notBefore) {
  const comments = await stableIssueCommentScan(api, "ambiguity scan");
  const exact = comments.filter((comment) => {
    const createdAt = Date.parse(comment?.created_at);
    if (!Number.isFinite(createdAt)) {
      fail("gateway journal ambiguity scan returned a malformed timestamp");
    }
    return (
      createdAt >= notBefore &&
      comment?.user?.login === "github-actions[bot]" &&
      comment?.user?.type === "Bot" &&
      comment.body === body
    );
  });
  if (exact.length > 1) {
    fail("ambiguous gateway journal write produced duplicate exact markers");
  }
  return exact;
}

async function postCanonicalComment(api, body, parser) {
  // The five-minute skew allowance is only an ambiguity-search boundary. The
  // exact authenticated body remains the authority.
  const notBefore = Date.now() - 5 * 60 * 1_000;
  let created = null;
  try {
    created = await api.request("POST", `/issues/${JOURNAL_ISSUE}/comments`, {
      body,
    });
  } catch {
    created = null;
  }
  if (Number.isSafeInteger(created?.id) && created.id > 0) {
    try {
      const readback = await api.request(
        "GET",
        `/issues/comments/${created.id}`,
      );
      const parsed = parser(readback);
      if (
        parsed &&
        readback.body === body &&
        (parsed.commentId ?? parsed.recordId) === String(created.id)
      ) {
        return parsed;
      }
    } catch {
      created = null;
    }
  }
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const exact = await recentExactComments(api, body, notBefore);
    if (exact.length === 1) return parser(exact[0]);
    if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  fail(
    "gateway journal write acknowledgement is ambiguous; external mutation remains blocked",
  );
}

export async function postAndReadBack(api, body) {
  return postCanonicalComment(api, body, parseMarkerComment);
}

export async function appendJournalRecord(
  api,
  repository,
  environment,
  record,
  authKey,
  { previousAuthKey = null, beforePost = null } = {},
) {
  const body = journalRecordCommentBody(record);
  const now = new Date().toISOString();
  const local = parseJournalRecordComment(
    {
      id: 1,
      body,
      created_at: now,
      updated_at: now,
      user: { login: "github-actions[bot]", type: "Bot" },
    },
    repository,
    environment,
    authKey,
  );
  if (!local || local.logicalRecordId !== record.logicalRecordId) {
    fail("gateway journal logical record is not canonically authenticated");
  }
  if (previousAuthKey !== null) {
    const previousLocal = parseJournalRecordComment(
      {
        id: 1,
        body,
        created_at: now,
        updated_at: now,
        user: { login: "github-actions[bot]", type: "Bot" },
      },
      repository,
      environment,
      previousAuthKey,
    );
    if (
      previousLocal?.kind !== "superseded" ||
      previousLocal.logicalRecordId !== record.logicalRecordId
    ) {
      fail(
        "gateway journal rekey checkpoint is not authenticated by the previous key",
      );
    }
  }
  const nextBefore = await journalRecordGraph(
    api,
    repository,
    environment,
    authKey,
    previousAuthKey !== null,
  );
  const existing = nextBefore?.nodes.get(record.logicalRecordId);
  if (existing) {
    if (previousAuthKey !== null) {
      await verifyRekeyTransition(
        api,
        repository,
        environment,
        record,
        previousAuthKey,
      );
    }
    return { ...existing, newlyPublished: false };
  }
  if (previousAuthKey !== null && nextBefore !== null) {
    fail("next gateway journal key already owns a different logical chain");
  }
  const before =
    previousAuthKey === null
      ? nextBefore
      : await journalRecordGraph(api, repository, environment, previousAuthKey);
  if (
    (record.previousLogicalRecordId ?? null) !==
      (before?.head.logicalRecordId ?? null) ||
    (record.previousLogicalRecordSha256 ?? null) !==
      (before?.head.recordSha256 ?? null)
  ) {
    fail("gateway journal append does not extend the exact canonical head");
  }
  if (beforePost !== null) await beforePost();
  if (previousAuthKey !== null) {
    const adjacentPrevious = await journalRecordGraph(
      api,
      repository,
      environment,
      previousAuthKey,
    );
    if (
      (adjacentPrevious?.head.logicalRecordId ?? null) !==
        (record.previousLogicalRecordId ?? null) ||
      (adjacentPrevious?.head.recordSha256 ?? null) !==
        (record.previousLogicalRecordSha256 ?? null)
    ) {
      fail(
        "gateway journal previous-key head advanced before the rekey checkpoint POST",
      );
    }
  }
  let postedCommentId = null;
  try {
    const posted = await api.request(
      "POST",
      `/issues/${JOURNAL_ISSUE}/comments`,
      { body },
    );
    if (Number.isSafeInteger(posted?.id) && posted.id > 0) {
      postedCommentId = String(posted.id);
    }
  } catch {
    // POST acknowledgements are not authoritative. A retry posts the same
    // deterministic logical body and all exact replicas collapse as aliases.
  }
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const comments = await stableIssueCommentScan(
      api,
      "logical-record readback",
    );
    const exact = comments.filter(
      (comment) =>
        comment?.body === body &&
        comment?.user?.login === "github-actions[bot]" &&
        comment?.user?.type === "Bot",
    );
    if (exact.length > 0) {
      const graph = await journalRecordGraph(
        api,
        repository,
        environment,
        authKey,
      );
      if (graph?.head.logicalRecordId !== record.logicalRecordId) {
        fail("gateway journal append is not the unique canonical logical head");
      }
      if (previousAuthKey !== null) {
        await verifyRekeyTransition(
          api,
          repository,
          environment,
          record,
          previousAuthKey,
        );
      }
      const firstPublication =
        postedCommentId !== null &&
        exact.length === 1 &&
        String(exact[0].id) === postedCommentId &&
        graph.head.physicalCommentIds.length === 1 &&
        graph.head.physicalCommentIds[0] === postedCommentId;
      return { ...graph.head, newlyPublished: firstPublication };
    }
    if (attempt < 6) await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  fail(
    "gateway journal logical write acknowledgement is ambiguous; external mutation remains blocked",
  );
}

async function appendJournalMarker(api, state, marker, writer, authKey) {
  validateMarker(marker);
  if (!validWriter(writer, marker)) {
    fail("gateway journal writer is not canonical for the marker");
  }
  const record = journalRecordPayload(
    marker,
    state.latestRecord,
    writer,
    authKey,
  );
  const created = await appendJournalRecord(
    api,
    marker.repository,
    marker.environment,
    record,
    authKey,
    {
      beforePost: () => validateCurrentRecoveryAttempt(api, marker),
    },
  );
  return {
    ...marker,
    commentId: created.recordId,
    newlyPublished: created.newlyPublished,
  };
}

export async function currentRecoveryJob(
  api,
  environment,
  sourceRunId,
  sourceRunAttempt,
  runId,
  runAttempt,
  expectedStepName,
) {
  const suffix = "Reconcile Railway candidate (staging)";
  const endpoint = `/actions/runs/${runId}/attempts/${runAttempt}/jobs?filter=all`;
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const jobs = await paginatedJobs(api, endpoint);
    const candidates = jobs.filter(
      (job) =>
        typeof job?.name === "string" &&
        job.name.endsWith(suffix) &&
        job.status === "in_progress" &&
        Array.isArray(job.steps) &&
        job.steps.filter(
          (step) =>
            step?.name === expectedStepName &&
            step?.status === "in_progress" &&
            step?.conclusion === null,
        ).length === 1 &&
        Number.isSafeInteger(job.id) &&
        job.id > 0,
    );
    if (candidates.length > 1) {
      fail("current exact gateway reconciliation job is ambiguous");
    }
    if (candidates.length === 1) {
      return { id: String(candidates[0].id), name: candidates[0].name };
    }
    if (attempt < 6) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  fail(
    "current exact gateway reconciliation job is absent after readback retries",
  );
}

function optionMap(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || options.has(key)) {
      fail("journal options must be unique --name value pairs");
    }
    options.set(key, value);
  }
  return options;
}

function required(options, name) {
  const value = options.get(`--${name}`);
  if (value === undefined) fail(`missing --${name}`);
  return value;
}

async function writeOutput(path, value) {
  if (!path) return;
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

function sourceFromOptions(options, repository) {
  return {
    repository,
    environment: required(options, "environment"),
    sourceSha: required(options, "source-sha"),
    sourceRunId: required(options, "source-run-id"),
    sourceRunAttempt: required(options, "source-run-attempt"),
  };
}

function preparedOpenArtifactName(source, logicalRecordId) {
  if (!validSource(source) || !isDigest(logicalRecordId)) {
    fail("prepared OPEN artifact identity is malformed");
  }
  return `${PREPARED_OPEN_ARTIFACT_PREFIX}${source.sourceRunId}-${source.sourceRunAttempt}-${logicalRecordId}`;
}

export function preparedOpenDescriptor(record) {
  const source = record?.marker;
  const descriptor = {
    version: 1,
    kind: PREPARED_OPEN_KIND,
    repository: source?.repository,
    environment: source?.environment,
    sourceSha: source?.sourceSha,
    sourceRunId: source?.sourceRunId,
    sourceRunAttempt: source?.sourceRunAttempt,
    logicalRecordId: record?.logicalRecordId,
    recordSha256: journalRecordDigest(record),
    artifactName: preparedOpenArtifactName(source, record?.logicalRecordId),
    record,
  };
  validatePreparedOpenDescriptor(descriptor);
  return descriptor;
}

function validatePreparedOpenDescriptor(descriptor) {
  if (
    !exactKeys(descriptor, [
      "artifactName",
      "environment",
      "kind",
      "logicalRecordId",
      "record",
      "recordSha256",
      "repository",
      "sourceRunAttempt",
      "sourceRunId",
      "sourceSha",
      "version",
    ]) ||
    descriptor.version !== 1 ||
    descriptor.kind !== PREPARED_OPEN_KIND ||
    descriptor.environment !== "staging" ||
    !validSource(descriptor) ||
    !isDigest(descriptor.logicalRecordId) ||
    !isDigest(descriptor.recordSha256) ||
    descriptor.record?.kind !== "marker" ||
    descriptor.record?.marker?.kind !== "open" ||
    !sameSource(descriptor, descriptor.record.marker) ||
    descriptor.logicalRecordId !== descriptor.record.logicalRecordId ||
    descriptor.recordSha256 !== journalRecordDigest(descriptor.record) ||
    descriptor.artifactName !==
      preparedOpenArtifactName(descriptor, descriptor.logicalRecordId)
  ) {
    fail("prepared OPEN descriptor is malformed");
  }
  validateMarker(descriptor.record.marker);
  if (!validWriter(descriptor.record.writer, descriptor.record.marker)) {
    fail("prepared OPEN descriptor writer is not canonical");
  }
  return descriptor;
}

async function readSecureJson(path, purpose) {
  const stats = await lstat(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 2_000_000) {
    fail(`${purpose} is missing, unsafe, or too large`);
  }
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail(`${purpose} is not JSON`);
  }
  return value;
}

async function validatePreparedOpenArtifact(api, descriptor, authority) {
  const artifactId = authority.artifactId;
  const artifactName = authority.artifactName;
  const artifactDigest = authority.artifactDigest?.toLowerCase();
  if (
    !isPositiveIntegerString(artifactId) ||
    artifactName !== descriptor.artifactName ||
    !isDigest(artifactDigest)
  ) {
    fail("prepared OPEN artifact arguments are malformed");
  }
  const artifact = await api.request("GET", `/actions/artifacts/${artifactId}`);
  const serverDigest = String(artifact?.digest ?? "").replace(/^sha256:/, "");
  if (
    String(artifact?.id) !== artifactId ||
    artifact?.name !== artifactName ||
    artifact?.expired !== false ||
    String(artifact?.workflow_run?.id) !== descriptor.sourceRunId ||
    serverDigest !== artifactDigest
  ) {
    fail(
      "prepared OPEN artifact readback does not bind its exact source and digest",
    );
  }
}

export async function findPreparedOpenArtifact(api, state) {
  const artifacts = await stableArtifactScan(api, "prepared OPEN");
  const pattern = new RegExp(
    `^${PREPARED_OPEN_ARTIFACT_PREFIX}([1-9][0-9]*)-([1-9][0-9]*)-([0-9a-f]{64})$`,
  );
  const unresolved = [];
  for (const artifact of artifacts) {
    if (
      typeof artifact?.name !== "string" ||
      !artifact.name.startsWith(PREPARED_OPEN_ARTIFACT_PREFIX)
    ) {
      continue;
    }
    const match = artifact.name.match(pattern);
    if (
      !match ||
      String(artifact?.workflow_run?.id) !== match[1] ||
      typeof artifact?.digest !== "string" ||
      !isDigest(artifact.digest.replace(/^sha256:/, ""))
    ) {
      fail("prepared OPEN artifact inventory contains a malformed authority");
    }
    const logicalRecordId = match[3];
    if (state.logicalRecordIds.includes(logicalRecordId)) continue;
    if (artifact.expired !== false) {
      fail(
        "an unresolved prepared OPEN artifact expired before journal commit",
      );
    }
    unresolved.push({
      artifactId: String(artifact.id),
      artifactName: artifact.name,
      artifactDigest: artifact.digest.replace(/^sha256:/, ""),
      sourceRunId: match[1],
      sourceRunAttempt: match[2],
      logicalRecordId,
    });
  }
  if (unresolved.length > 1) {
    fail("multiple unresolved prepared OPEN artifacts would create siblings");
  }
  if (unresolved.length === 1 && state.status !== "clear") {
    fail("a prepared OPEN conflicts with the unresolved journal transaction");
  }
  return unresolved[0] ?? null;
}

export async function commitPreparedOpen(
  api,
  descriptorValue,
  artifactAuthority,
  authKey,
  runtime,
) {
  const descriptor = validatePreparedOpenDescriptor(descriptorValue);
  const repository = runtime.GITHUB_REPOSITORY;
  if (descriptor.repository !== repository) {
    fail("prepared OPEN descriptor repository does not match this workflow");
  }
  const localBody = journalRecordCommentBody(descriptor.record);
  const now = new Date().toISOString();
  const parsed = parseJournalRecordComment(
    {
      id: 1,
      body: localBody,
      created_at: now,
      updated_at: now,
      user: { login: "github-actions[bot]", type: "Bot" },
    },
    repository,
    descriptor.environment,
    authKey,
  );
  if (
    !parsed ||
    parsed.logicalRecordId !== descriptor.logicalRecordId ||
    parsed.recordSha256 !== descriptor.recordSha256
  ) {
    fail("prepared OPEN descriptor fails protected authentication");
  }
  await validatePreparedOpenArtifact(api, descriptor, artifactAuthority);
  const sourceOwned =
    runtime.GITHUB_RUN_ID === descriptor.sourceRunId &&
    runtime.GITHUB_RUN_ATTEMPT === descriptor.sourceRunAttempt &&
    runtime.GITHUB_SHA === descriptor.sourceSha &&
    runtime.GITHUB_EVENT_NAME === "workflow_dispatch";
  if (sourceOwned) {
    await validateSourceAttempt(api, descriptor, runtime);
  } else {
    await validateReferencedSourceAttempt(api, descriptor);
    await validateRekeyAttempt(
      api,
      repository,
      descriptor.environment,
      runtime,
    );
  }
  const state = await readJournalState(
    api,
    repository,
    descriptor.environment,
    authKey,
  );
  if (state.logicalRecordIds.includes(descriptor.logicalRecordId)) {
    if (
      !state.open ||
      state.open.commentId !== descriptor.logicalRecordId ||
      !sameSource(state.open, descriptor)
    ) {
      fail("prepared OPEN was already consumed by a different journal state");
    }
    return state.open;
  }
  const expectedPreviousId = state.latestRecord?.logicalRecordId ?? null;
  const expectedPreviousDigest = state.latestRecord?.recordSha256 ?? null;
  if (
    state.status !== "clear" ||
    descriptor.record.previousLogicalRecordId !== expectedPreviousId ||
    descriptor.record.previousLogicalRecordSha256 !== expectedPreviousDigest ||
    descriptor.record.marker.previousCloseCommentId !==
      (state.lastClose?.commentId ?? null) ||
    descriptor.record.marker.previousCloseMarkerSha256 !==
      (state.lastClose ? markerDigest(state.lastClose) : null)
  ) {
    fail("prepared OPEN no longer extends the exact clear journal head");
  }
  const created = await appendJournalRecord(
    api,
    repository,
    descriptor.environment,
    descriptor.record,
    authKey,
    {
      beforePost: sourceOwned
        ? async () => {
            await validateSourceAttempt(api, descriptor, runtime);
            await validateCurrentDevelopHead(api, descriptor.sourceSha);
          }
        : () =>
            validateRekeyAttempt(
              api,
              repository,
              descriptor.environment,
              runtime,
            ),
    },
  );
  const committed = await readJournalState(
    api,
    repository,
    descriptor.environment,
    authKey,
  );
  if (
    created.logicalRecordId !== descriptor.logicalRecordId ||
    committed.status !== "open" ||
    committed.open?.commentId !== descriptor.logicalRecordId ||
    !sameSource(committed.open, descriptor)
  ) {
    fail("prepared OPEN did not become the exact canonical journal head");
  }
  return committed.open;
}

function planEncryptionKey(keyMaterial, source, authKey) {
  if (typeof keyMaterial !== "string" || keyMaterial.length < 17) {
    fail("gateway journal provider-bound key material is missing or malformed");
  }
  return createHmac("sha256", authKeyBytes(authKey))
    .update(PLAN_KEY_DOMAIN)
    .update(source.repository)
    .update("\0")
    .update(source.environment)
    .update("\0")
    .update(keyMaterial)
    .digest();
}

function planWrappingKey(source, authKey) {
  return createHmac("sha256", authKeyBytes(authKey))
    .update(PLAN_WRAP_KEY_DOMAIN)
    .update(canonicalJson(source))
    .digest();
}

function planAad(source, journalPlanId) {
  return Buffer.from(
    [
      "gateway-webhook-plan-v1",
      source.repository,
      source.environment,
      source.sourceSha,
      source.sourceRunId,
      source.sourceRunAttempt,
      journalPlanId,
    ].join("\0"),
    "utf8",
  );
}

function providerKeyEnvelopeAad(source, journalPlanId) {
  return Buffer.from(
    [
      "gateway-webhook-provider-key-envelope-v1",
      canonicalJson(source),
      journalPlanId,
    ].join("\0"),
    "utf8",
  );
}

function encryptProviderKeyEnvelope(
  keyMaterial,
  source,
  journalPlanId,
  authKey,
) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    planWrappingKey(source, authKey),
    iv,
  );
  cipher.setAAD(providerKeyEnvelopeAad(source, journalPlanId));
  return Buffer.concat([
    iv,
    cipher.update(Buffer.from(keyMaterial, "utf8")),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}

function decryptProviderKeyEnvelope(open, source, authKey) {
  const envelope = Buffer.from(open.journalProviderKeyEnvelope, "base64");
  if (envelope.length < 46) {
    fail("provider-bound rollback key envelope is truncated");
  }
  const iv = envelope.subarray(0, 12);
  const tag = envelope.subarray(envelope.length - 16);
  const ciphertext = envelope.subarray(12, envelope.length - 16);
  let keyMaterial;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      planWrappingKey(source, authKey),
      iv,
    );
    decipher.setAAD(providerKeyEnvelopeAad(source, open.journalPlanId));
    decipher.setAuthTag(tag);
    keyMaterial = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    fail("provider-bound rollback key envelope failed authentication");
  }
  const [deploymentId, snapshotId, extra] = keyMaterial.split("\0");
  if (
    extra !== undefined ||
    !isUuid(deploymentId) ||
    !isSnapshotId(snapshotId)
  ) {
    fail("provider-bound rollback key envelope is malformed");
  }
  return keyMaterial;
}

function candidateEnvelopeAad(source, open, messageDigest) {
  return Buffer.from(
    [
      "gateway-webhook-candidate-envelope-v1",
      canonicalJson(source),
      open.commentId,
      open.journalPlanId,
      messageDigest,
    ].join("\0"),
    "utf8",
  );
}

export function encryptCandidateEnvelope(
  candidateId,
  expectedMessage,
  source,
  open,
  authKey,
) {
  const messageDigest = candidateMessageDigest(expectedMessage);
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    planWrappingKey(source, authKey),
    iv,
  );
  cipher.setAAD(candidateEnvelopeAad(source, open, messageDigest));
  return {
    candidateDeploymentIdSha256: candidateIdDigest(candidateId),
    expectedDeploymentMessageSha256: messageDigest,
    candidateDeploymentEnvelope: Buffer.concat([
      iv,
      cipher.update(Buffer.from(candidateId, "utf8")),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64"),
  };
}

export function decryptCandidateEnvelope(
  intent,
  expectedMessage,
  source,
  open,
  authKey,
) {
  if (
    candidateMessageDigest(expectedMessage) !==
    intent.expectedDeploymentMessageSha256
  ) {
    fail("candidate message does not bind the durable rollback intent");
  }
  const envelope = Buffer.from(intent.candidateDeploymentEnvelope, "base64");
  if (envelope.length < 64) fail("candidate deployment envelope is truncated");
  let candidateId;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      planWrappingKey(source, authKey),
      envelope.subarray(0, 12),
    );
    decipher.setAAD(
      candidateEnvelopeAad(
        source,
        open,
        intent.expectedDeploymentMessageSha256,
      ),
    );
    decipher.setAuthTag(envelope.subarray(envelope.length - 16));
    candidateId = Buffer.concat([
      decipher.update(envelope.subarray(12, envelope.length - 16)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    fail("candidate deployment envelope failed authentication");
  }
  if (
    !isUuid(candidateId) ||
    candidateIdDigest(candidateId) !== intent.candidateDeploymentIdSha256
  ) {
    fail("candidate deployment envelope does not match its durable digest");
  }
  return candidateId;
}

async function readExactPlan(directory) {
  const files = [];
  let rollbackPlan = null;
  for (const name of PLAN_FILES) {
    const path = join(directory, name);
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 2_000_000) {
      fail(`rollback-plan file ${name} is missing, unsafe, or too large`);
    }
    const bytes = await readFile(path);
    try {
      const parsed = JSON.parse(bytes.toString("utf8"));
      if (name === "rollback-plan.json") rollbackPlan = parsed;
    } catch {
      fail(`rollback-plan file ${name} is not JSON`);
    }
    files.push({
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      content: bytes.toString("base64"),
    });
  }
  return {
    files,
    rollbackPlan,
  };
}

export async function publishEncryptedPlan(api, source, directory, authKey) {
  const { files, rollbackPlan } = await readExactPlan(directory);
  if (
    !isUuid(rollbackPlan?.priorActiveDeploymentId) ||
    typeof rollbackPlan?.priorSnapshotId !== "string" ||
    !/^[0-9A-Za-z_-]{8,256}$/.test(rollbackPlan.priorSnapshotId) ||
    rollbackPlan?.repository !== source.repository ||
    rollbackPlan?.environment !== source.environment ||
    rollbackPlan?.sourceSha !== source.sourceSha ||
    String(rollbackPlan?.workflowRunId) !== source.sourceRunId ||
    String(rollbackPlan?.workflowRunAttempt) !== source.sourceRunAttempt
  ) {
    fail("rollback plan does not bind its source or provider key material");
  }
  const plaintext = Buffer.from(
    JSON.stringify({
      version: 1,
      files,
    }),
    "utf8",
  );
  const keyMaterial = `${rollbackPlan.priorActiveDeploymentId}\0${rollbackPlan.priorSnapshotId}`;
  const plaintextSha256 = createHash("sha256").update(plaintext).digest("hex");
  const journalPlanId = randomBytes(16).toString("hex");
  const iv = randomBytes(12);
  const encryptionKey = planEncryptionKey(keyMaterial, source, authKey);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
  cipher.setAAD(planAad(source, journalPlanId));
  const ciphertext = Buffer.concat([
    iv,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  const values = [];
  for (
    let offset = 0;
    offset < ciphertext.length;
    offset += PLAN_CHUNK_CHARACTERS
  ) {
    values.push(ciphertext.slice(offset, offset + PLAN_CHUNK_CHARACTERS));
  }
  if (values.length < 1 || values.length > MAX_PLAN_CHUNKS) {
    fail("encrypted rollback plan exceeds the bounded journal size");
  }
  const ids = [];
  const digests = [];
  for (let index = 0; index < values.length; index += 1) {
    const chunk = {
      version: 1,
      kind: "plan-chunk",
      ...source,
      journalPlanId,
      index,
      total: values.length,
      ciphertext: values[index],
    };
    const body = planChunkBody(chunk);
    const created = await postCanonicalComment(
      api,
      body,
      parsePlanChunkComment,
    );
    ids.push(created.commentId);
    digests.push(createHash("sha256").update(body).digest("hex"));
  }
  return {
    journalEncryptionKeyId: createHash("sha256")
      .update(encryptionKey)
      .digest("hex"),
    journalPlanId,
    journalPlanPlaintextSha256: plaintextSha256,
    journalPlanChunkCommentIds: ids,
    journalPlanChunkSha256: digests,
    journalProviderKeyEnvelope: encryptProviderKeyEnvelope(
      keyMaterial,
      source,
      journalPlanId,
      authKey,
    ),
  };
}

export async function restoreEncryptedPlan(
  api,
  source,
  open,
  directory,
  authKey,
) {
  const encoded = [];
  for (
    let index = 0;
    index < open.journalPlanChunkCommentIds.length;
    index += 1
  ) {
    const id = open.journalPlanChunkCommentIds[index];
    const comment = await api.request("GET", `/issues/comments/${id}`);
    const chunk = parsePlanChunkComment(comment);
    const bodyDigest = createHash("sha256")
      .update(comment?.body ?? "")
      .digest("hex");
    if (
      !chunk ||
      chunk.commentId !== id ||
      !sameSource(chunk, source) ||
      chunk.journalPlanId !== open.journalPlanId ||
      chunk.index !== index ||
      chunk.total !== open.journalPlanChunkCommentIds.length ||
      bodyDigest !== open.journalPlanChunkSha256[index]
    ) {
      fail("encrypted rollback-plan chunk does not bind the durable OPEN");
    }
    encoded.push(chunk.ciphertext);
  }
  const envelope = Buffer.from(encoded.join(""), "base64");
  if (envelope.length < 29)
    fail("encrypted rollback-plan envelope is truncated");
  const iv = envelope.subarray(0, 12);
  const tag = envelope.subarray(envelope.length - 16);
  const ciphertext = envelope.subarray(12, envelope.length - 16);
  const keyMaterial = decryptProviderKeyEnvelope(open, source, authKey);
  const encryptionKey = planEncryptionKey(keyMaterial, source, authKey);
  if (
    createHash("sha256").update(encryptionKey).digest("hex") !==
    open.journalEncryptionKeyId
  ) {
    fail("provider-bound rollback key does not match the durable OPEN");
  }
  let plaintext;
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey, iv);
    decipher.setAAD(planAad(source, open.journalPlanId));
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    fail("encrypted rollback plan failed authenticated decryption");
  }
  if (
    createHash("sha256").update(plaintext).digest("hex") !==
    open.journalPlanPlaintextSha256
  ) {
    fail("decrypted rollback-plan digest differs from durable OPEN");
  }
  let payload;
  try {
    payload = JSON.parse(plaintext.toString("utf8"));
  } catch {
    fail("decrypted rollback plan is not JSON");
  }
  if (
    payload?.version !== 1 ||
    !Array.isArray(payload.files) ||
    payload.files.length !== PLAN_FILES.length ||
    payload.files.map((file) => file?.name).join("\0") !== PLAN_FILES.join("\0")
  ) {
    fail("decrypted rollback-plan file manifest is malformed");
  }
  await mkdir(directory, { recursive: false, mode: 0o700 });
  for (const file of payload.files) {
    const bytes = Buffer.from(file.content, "base64");
    if (
      !isDigest(file.sha256) ||
      createHash("sha256").update(bytes).digest("hex") !== file.sha256
    ) {
      fail(`decrypted rollback-plan file ${file.name} failed its digest`);
    }
    try {
      JSON.parse(bytes.toString("utf8"));
    } catch {
      fail(`decrypted rollback-plan file ${file.name} is not JSON`);
    }
    await writeFile(join(directory, file.name), bytes, {
      flag: "wx",
      mode: 0o600,
    });
  }
}

export async function main(
  argv = process.argv.slice(2),
  environment = process.env,
  dependencies = {},
) {
  const [command, ...rest] = argv;
  const options = optionMap(rest);
  const repository = environment.GITHUB_REPOSITORY;
  const authKey = environment.GATEWAY_JOURNAL_AUTH_KEY;
  const api =
    dependencies.api ??
    new GitHubApi({
      token: environment.GITHUB_TOKEN,
      repository,
      apiUrl: environment.GITHUB_API_URL,
    });
  if (command === "rekey") {
    const target = required(options, "environment");
    const nextAuthKey = environment.GATEWAY_JOURNAL_NEXT_AUTH_KEY;
    authKeyBytes(nextAuthKey);
    const previousAuthKeyId = journalAuthKeyId(authKey);
    if (previousAuthKeyId === journalAuthKeyId(nextAuthKey)) {
      fail("journal rekey requires a distinct next protected key");
    }
    let alreadyCheckpointed = null;
    const nextState = await readJournalState(
      api,
      repository,
      target,
      nextAuthKey,
      { allowForeignOnly: true },
    );
    if (
      nextState.latestRecord &&
      nextState.rootRecord?.kind === "checkpoint" &&
      nextState.rootRecord.previousAuthKeyId === previousAuthKeyId
    ) {
      alreadyCheckpointed = nextState.rootRecord;
    } else if (nextState.latestRecord) {
      fail("next journal key already owns a different ledger state");
    }
    if (alreadyCheckpointed) {
      await verifyRekeyTransition(
        api,
        repository,
        target,
        alreadyCheckpointed,
        authKey,
      );
      const output = {
        version: 1,
        environment: target,
        status: nextState.status,
        checkpointRequired: true,
        deferred: false,
        checkpointRecordId: alreadyCheckpointed.recordId,
        authKeyId: alreadyCheckpointed.authKeyId,
      };
      await writeOutput(options.get("--output"), output);
      return output;
    }
    const state = await readJournalState(api, repository, target, authKey);
    if (state.status !== "clear") {
      const output = {
        version: 1,
        environment: target,
        status: "open",
        checkpointRequired: true,
        deferred: true,
      };
      await writeOutput(options.get("--output"), output);
      return output;
    }
    const preparedOpen = await findPreparedOpenArtifact(api, state);
    if (preparedOpen) {
      const output = {
        version: 1,
        environment: target,
        status: "clear",
        checkpointRequired: true,
        deferred: true,
        deferredReason: "prepared-open",
      };
      await writeOutput(options.get("--output"), output);
      return output;
    }
    const writer = await validateRekeyAttempt(
      api,
      repository,
      target,
      environment,
    );
    const checkpoint = journalCheckpointPayload(
      repository,
      target,
      state.latestRecord,
      writer,
      authKey,
      nextAuthKey,
    );
    const created = await appendJournalRecord(
      api,
      repository,
      target,
      checkpoint,
      nextAuthKey,
      {
        previousAuthKey: authKey,
        beforePost: () =>
          validateRekeyAttempt(api, repository, target, environment),
      },
    );
    const output = {
      version: 1,
      environment: target,
      status: "clear",
      checkpointRequired: true,
      deferred: false,
      checkpointRecordId: created.recordId,
      authKeyId: created.authKeyId,
    };
    await writeOutput(options.get("--output"), output);
    return output;
  }
  if (command === "state" || command === "check") {
    const target = required(options, "environment");
    const state = await readJournalState(api, repository, target, authKey);
    await writeOutput(options.get("--output"), state);
    if (command === "check" && state.status !== "clear") {
      fail(
        `unresolved ${target} gateway transaction ${state.open.commentId} blocks mutation`,
      );
    }
    return state;
  }
  if (command === "find-prepared-open") {
    const target = required(options, "environment");
    const state = await readJournalState(api, repository, target, authKey);
    const artifact = await findPreparedOpenArtifact(api, state);
    const output = artifact
      ? { version: 1, environment: target, present: true, ...artifact }
      : { version: 1, environment: target, present: false };
    await writeOutput(required(options, "output"), output);
    return output;
  }
  if (command === "prepare-open") {
    const source = sourceFromOptions(options, repository);
    const state = await readJournalState(
      api,
      repository,
      source.environment,
      authKey,
    );
    if (state.status !== "clear") {
      fail("cannot prepare OPEN while another transaction is unresolved");
    }
    if (await findPreparedOpenArtifact(api, state)) {
      fail("cannot prepare OPEN while an earlier prepared OPEN is unresolved");
    }
    const marker = {
      version: 1,
      kind: "open",
      ...source,
      planArtifactName: required(options, "plan-artifact-name"),
      planArtifactId: required(options, "plan-artifact-id"),
      planArtifactDigest: required(
        options,
        "plan-artifact-digest",
      ).toLowerCase(),
      previousCloseCommentId: state.lastClose?.commentId ?? null,
      previousCloseMarkerSha256: state.lastClose
        ? markerDigest(state.lastClose)
        : null,
    };
    const writer = await validateSourceAttempt(api, marker, environment);
    const artifact = await api.request(
      "GET",
      `/actions/artifacts/${marker.planArtifactId}`,
    );
    const serverDigest = String(artifact?.digest ?? "").replace(/^sha256:/, "");
    if (
      String(artifact?.id) !== marker.planArtifactId ||
      artifact?.name !== marker.planArtifactName ||
      artifact?.expired !== false ||
      String(artifact?.workflow_run?.id) !== marker.sourceRunId ||
      serverDigest !== marker.planArtifactDigest
    ) {
      fail(
        "rollback-plan artifact readback does not bind the exact source run and digest",
      );
    }
    Object.assign(
      marker,
      await publishEncryptedPlan(
        api,
        source,
        required(options, "plan-directory"),
        authKey,
      ),
    );
    validateMarker(marker);
    const record = journalRecordPayload(
      marker,
      state.latestRecord,
      writer,
      authKey,
    );
    const descriptor = preparedOpenDescriptor(record);
    await writeOutput(required(options, "output"), descriptor);
    return descriptor;
  }
  if (command === "commit-open") {
    const descriptor = await readSecureJson(
      required(options, "prepared-open-path"),
      "prepared OPEN descriptor",
    );
    const committed = await commitPreparedOpen(
      api,
      descriptor,
      {
        artifactId: required(options, "prepared-open-artifact-id"),
        artifactName: required(options, "prepared-open-artifact-name"),
        artifactDigest: required(options, "prepared-open-artifact-digest"),
      },
      authKey,
      environment,
    );
    await writeOutput(options.get("--output"), committed);
    return committed;
  }
  if (command === "restore-plan") {
    const source = sourceFromOptions(options, repository);
    const state = await readJournalState(
      api,
      repository,
      source.environment,
      authKey,
    );
    if (!state.open || !sameSource(state.open, source)) {
      fail("restore-plan does not bind the exact unresolved OPEN");
    }
    await restoreEncryptedPlan(
      api,
      source,
      state.open,
      required(options, "output-directory"),
      authKey,
    );
    return state.open;
  }
  if (command === "restore-candidate") {
    const source = sourceFromOptions(options, repository);
    const state = await readJournalState(
      api,
      repository,
      source.environment,
      authKey,
    );
    if (
      !state.open ||
      !sameSource(state.open, source) ||
      !state.rollbackIntent
    ) {
      fail("restore-candidate does not bind one exact unresolved intent");
    }
    const candidateDeploymentId = decryptCandidateEnvelope(
      state.rollbackIntent,
      required(options, "expected-deployment-message"),
      source,
      state.open,
      authKey,
    );
    const output = { version: 1, candidateDeploymentId };
    await writeOutput(required(options, "output"), output);
    return output;
  }
  if (
    command === "rollback-intent" ||
    command === "rollback-observation" ||
    command === "close"
  ) {
    const source = sourceFromOptions(options, repository);
    const state = await readJournalState(
      api,
      repository,
      source.environment,
      authKey,
    );
    if (!state.open || !sameSource(state.open, source)) {
      fail(`${command} does not bind the exact unresolved OPEN`);
    }
    const runId = environment.GITHUB_RUN_ID;
    const runAttempt = environment.GITHUB_RUN_ATTEMPT;
    const workflowSha = environment.GITHUB_SHA;
    if (
      !isPositiveIntegerString(runId) ||
      !isPositiveIntegerString(runAttempt) ||
      !isSha(workflowSha)
    ) {
      fail("current recovery workflow identity is invalid");
    }
    const job = await currentRecoveryJob(
      api,
      source.environment,
      source.sourceRunId,
      source.sourceRunAttempt,
      runId,
      runAttempt,
      command === "close"
        ? "Close durable gateway transaction"
        : "Reconcile from immutable plan and durable receipt",
    );
    const common = {
      version: 1,
      kind: command,
      ...source,
      openCommentId: state.open.commentId,
      recoveryRunId: runId,
      recoveryRunAttempt: runAttempt,
      recoveryJobId: job.id,
      recoveryJobName: job.name,
      recoveryWorkflowSha: workflowSha,
    };
    const writer = await validateCurrentRecoveryAttempt(api, common);
    let marker;
    if (command === "rollback-intent") {
      if (
        state.rollbackIntents.length >= MAX_ROLLBACK_ATTEMPTS ||
        state.rollbackObservations.length !== state.rollbackIntents.length ||
        ROLLBACK_READY_STATUSES.has(state.rollbackObservation?.status)
      ) {
        fail("durable rollback convergence attempt bound is exhausted");
      }
      const candidateDeploymentId = required(
        options,
        "candidate-deployment-id",
      );
      const expectedDeploymentMessage = required(
        options,
        "expected-deployment-message",
      );
      let providerDeploymentIdWatermarkSha256;
      try {
        providerDeploymentIdWatermarkSha256 = JSON.parse(
          required(options, "provider-deployment-id-watermark-sha256"),
        );
      } catch {
        fail("rollback intent provider watermark is not JSON");
      }
      const expectedPrefix = `gateway-webhook ${source.sourceSha} (${source.environment}) run:${source.sourceRunId}:${source.sourceRunAttempt} nonce:`;
      if (
        !isUuid(candidateDeploymentId) ||
        !expectedDeploymentMessage.startsWith(expectedPrefix) ||
        !/^[0-9a-f]{32}$/.test(
          expectedDeploymentMessage.slice(expectedPrefix.length),
        ) ||
        !Array.isArray(providerDeploymentIdWatermarkSha256) ||
        providerDeploymentIdWatermarkSha256.length < 1 ||
        providerDeploymentIdWatermarkSha256.length >
          MAX_ROLLBACK_ATTEMPTS + 1 ||
        !providerDeploymentIdWatermarkSha256.every(isDigest) ||
        new Set(providerDeploymentIdWatermarkSha256).size !==
          providerDeploymentIdWatermarkSha256.length ||
        canonicalJson(providerDeploymentIdWatermarkSha256) !==
          canonicalJson([...providerDeploymentIdWatermarkSha256].sort()) ||
        !providerDeploymentIdWatermarkSha256.includes(
          providerDeploymentIdDigest(candidateDeploymentId),
        )
      ) {
        fail("rollback intent candidate identity is malformed");
      }
      marker = {
        ...common,
        ordinal: state.rollbackIntents.length + 1,
        previousIntentCommentId: state.rollbackIntent?.commentId ?? null,
        previousIntentMarkerSha256: state.rollbackIntent
          ? markerDigest(state.rollbackIntent)
          : null,
        failedRestorationIdSha256:
          state.rollbackObservation?.restorationIdSha256 ?? null,
        providerActiveTopologySha256: required(
          options,
          "provider-active-topology-sha256",
        ).toLowerCase(),
        providerDeploymentIdWatermarkSha256,
        ...encryptCandidateEnvelope(
          candidateDeploymentId,
          expectedDeploymentMessage,
          source,
          state.open,
          authKey,
        ),
      };
    } else if (command === "rollback-observation") {
      const refinementOption = options.get("--refine-ordinal") ?? null;
      let intent;
      let previousObservation = null;
      if (refinementOption === null) {
        if (
          !state.rollbackIntent ||
          state.rollbackObservations.length !== state.rollbackIntents.length - 1
        ) {
          fail("rollback observation lacks one exact unobserved intent");
        }
        intent = state.rollbackIntent;
      } else {
        if (!/^[12]$/.test(refinementOption)) {
          fail("rollback observation refinement ordinal is malformed");
        }
        const index = Number(refinementOption) - 1;
        intent = state.rollbackIntents[index] ?? null;
        previousObservation = state.rollbackObservations[index] ?? null;
        if (
          state.rollbackObservations.length !== state.rollbackIntents.length ||
          !intent ||
          previousObservation?.status !== "AMBIGUOUS" ||
          required(options, "status") === "AMBIGUOUS"
        ) {
          fail(
            "rollback observation refinement lacks one exact ambiguous observation",
          );
        }
      }
      marker = {
        ...common,
        ordinal: intent.ordinal,
        intentCommentId: intent.commentId,
        intentMarkerSha256: markerDigest(intent),
        refinesObservationCommentId: previousObservation?.commentId ?? null,
        refinesObservationMarkerSha256: previousObservation
          ? markerDigest(previousObservation)
          : null,
        restorationIdSha256:
          options.get("--restoration-id-sha256")?.toLowerCase() ?? null,
        status: required(options, "status"),
      };
    } else {
      marker = {
        ...common,
        resolutionArtifactName: required(options, "resolution-artifact-name"),
        resolutionArtifactId: required(options, "resolution-artifact-id"),
        resolutionArtifactDigest: required(
          options,
          "resolution-artifact-digest",
        ).toLowerCase(),
        resolutionReceiptSha256: "0".repeat(64),
        result: required(options, "result"),
        rollbackIntentCount: state.rollbackIntents.length,
        lastRollbackIntentCommentId: state.rollbackIntent?.commentId ?? null,
        lastRollbackIntentMarkerSha256: state.rollbackIntent
          ? markerDigest(state.rollbackIntent)
          : null,
        rollbackObservationCount: state.rollbackObservations.length,
        lastRollbackObservationCommentId:
          state.lastRollbackObservationMarker?.commentId ?? null,
        lastRollbackObservationMarkerSha256: state.lastRollbackObservationMarker
          ? markerDigest(state.lastRollbackObservationMarker)
          : null,
      };
    }
    if (command === "close") {
      if (state.rollbackIntents.length !== state.rollbackObservations.length) {
        fail("cannot CLOSE before the latest rollback result is observed");
      }
      const receiptPath = required(options, "resolution-receipt-path");
      const receiptBytes = await readFile(receiptPath);
      const receiptDigest = createHash("sha256")
        .update(receiptBytes)
        .digest("hex");
      let receipt;
      try {
        receipt = JSON.parse(receiptBytes.toString("utf8"));
      } catch {
        fail("resolution receipt is not JSON");
      }
      const artifact = await api.request(
        "GET",
        `/actions/artifacts/${marker.resolutionArtifactId}`,
      );
      const serverDigest = String(artifact?.digest ?? "").replace(
        /^sha256:/,
        "",
      );
      if (
        String(artifact?.id) !== marker.resolutionArtifactId ||
        artifact?.name !== marker.resolutionArtifactName ||
        artifact?.expired !== false ||
        String(artifact?.workflow_run?.id) !== runId ||
        serverDigest !== marker.resolutionArtifactDigest
      ) {
        fail(
          "resolution artifact readback does not bind the exact recovery run and digest",
        );
      }
      const receiptAttemptsValid =
        Array.isArray(receipt?.rollbackAttempts) &&
        receipt.rollbackAttempts.length === state.rollbackObservations.length &&
        receipt.rollbackAttempts.every((attempt, index) => {
          const observation = state.rollbackObservations[index];
          return (
            exactKeys(attempt, [
              "ordinal",
              "restorationDeploymentId",
              "status",
            ]) &&
            attempt.ordinal === observation.ordinal &&
            attempt.status === observation.status &&
            (attempt.restorationDeploymentId === null
              ? observation.restorationIdSha256 === null
              : isUuid(attempt.restorationDeploymentId) &&
                restorationIdDigest(attempt.restorationDeploymentId) ===
                  observation.restorationIdSha256)
          );
        });
      const successfulReceiptAttempts = receiptAttemptsValid
        ? receipt.rollbackAttempts.filter((attempt) =>
            ROLLBACK_READY_STATUSES.has(attempt.status),
          )
        : [];
      if (
        receipt?.version !== 1 ||
        receipt?.result !== marker.result ||
        receipt?.repository !== source.repository ||
        receipt?.environment !== source.environment ||
        receipt?.sourceSha !== source.sourceSha ||
        receipt?.workflowRunId !== source.sourceRunId ||
        receipt?.workflowRunAttempt !== source.sourceRunAttempt ||
        receipt?.openCommentId !== state.open.commentId ||
        receipt?.recoveryWorkflowRunId !== runId ||
        receipt?.recoveryWorkflowRunAttempt !== runAttempt ||
        receipt?.rollbackPlanArtifactId !== state.open.planArtifactId ||
        receipt?.rollbackPlanArtifactDigest !== state.open.planArtifactDigest ||
        !receiptAttemptsValid ||
        !isSnapshotId(receipt?.priorSnapshotId) ||
        !isUuid(receipt?.observedActiveDeploymentId) ||
        !isSnapshotId(receipt?.observedActiveSnapshotId) ||
        (marker.result === "candidate-proven"
          ? state.rollbackIntents.length !== 0 ||
            !isUuid(receipt?.candidateDeploymentId) ||
            receipt.observedActiveDeploymentId !== receipt.candidateDeploymentId
          : marker.result === "baseline-preserved-no-candidate"
            ? state.rollbackIntents.length !== 0 ||
              receipt?.candidateDeploymentId !== null ||
              receipt.observedActiveSnapshotId !== receipt.priorSnapshotId
            : marker.result === "prior-snapshot-preserved"
              ? state.rollbackObservations.length !==
                  state.rollbackIntents.length ||
                successfulReceiptAttempts.length !== 0 ||
                !isUuid(receipt?.candidateDeploymentId) ||
                (state.rollbackIntents.length > 0 &&
                  candidateIdDigest(receipt.candidateDeploymentId) !==
                    state.rollbackIntents[0]?.candidateDeploymentIdSha256) ||
                receipt.observedActiveDeploymentId ===
                  receipt.candidateDeploymentId ||
                receipt.rollbackAttempts.some(
                  (attempt) =>
                    attempt.restorationDeploymentId ===
                    receipt.observedActiveDeploymentId,
                ) ||
                receipt.observedActiveSnapshotId !== receipt.priorSnapshotId
              : marker.result === "prior-snapshot-restored"
                ? state.rollbackIntents.length < 1 ||
                  state.rollbackIntents.length > MAX_ROLLBACK_ATTEMPTS ||
                  state.rollbackObservations.length !==
                    state.rollbackIntents.length ||
                  successfulReceiptAttempts.length !== 1 ||
                  successfulReceiptAttempts[0].restorationDeploymentId !==
                    receipt.observedActiveDeploymentId ||
                  candidateIdDigest(receipt.candidateDeploymentId) !==
                    state.rollbackIntents[0]?.candidateDeploymentIdSha256 ||
                  !isUuid(receipt?.candidateDeploymentId) ||
                  receipt.observedActiveDeploymentId ===
                    receipt.candidateDeploymentId ||
                  receipt.observedActiveSnapshotId !== receipt.priorSnapshotId
                : true)
      ) {
        fail(
          "resolution receipt does not bind the exact OPEN and recovery attempt",
        );
      }
      marker = { ...marker, resolutionReceiptSha256: receiptDigest };
    }
    const created = await appendJournalMarker(
      api,
      state,
      marker,
      writer,
      authKey,
    );
    await writeOutput(options.get("--output"), created);
    return created;
  }
  fail(
    "usage: gateway-webhook-transaction-journal.mjs <state|check|find-prepared-open|prepare-open|commit-open|restore-plan|restore-candidate|rollback-intent|rollback-observation|close|rekey> [options]",
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  });
}
