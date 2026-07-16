export const DEFAULT_PRODUCTION_EVIDENCE_MAX_AGE_DAYS = 14;

const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const TIMESTAMP_PATHS = Object.freeze([
  "domain.probeEvidence.checkedAt",
  "backups.lastBackupAt",
  "backups.lastRestoreCheckAt",
  "backups.backupEvidence.checkedAt",
  "backups.backupEvidence.offsiteUploadReceipt.checkedAt",
  "backups.backupEvidence.offsiteRestoreReceipt.checkedAt",
  "database.databaseEvidence.checkedAt",
  "imageProvenance.provenanceEvidence.checkedAt",
  "sso.smokeEvidence.checkedAt",
  "sso.bootstrapEvidence.checkedAt",
  "runner.smokeEvidence.checkedAt",
  "runner.auditEvidence.checkedAt",
  "repository.liveProtectionEvidence.checkedAt",
  "githubMigration.pilotBootstrapEvidence.checkedAt",
  "secrets.secretEvidence.checkedAt",
  "mail.mailEvidence.checkedAt",
  "storage.storageEvidence.checkedAt",
  "observability.observabilityEvidence.checkedAt",
  "steward.preflightEvidence.checkedAt",
  "steward.doctorEvidence.checkedAt",
  "mergeQueueRollout.dryRunEvidence.checkedAt",
  "mergeQueueRollout.liveDrillEvidence.checkedAt",
  "securityReview.securityEvidence.checkedAt",
  "securityReview.approvedAt",
  "deployment.deployEvidence.checkedAt",
  "deployment.postDeployEvidence.checkedAt",
]);

export function validateProductionEvidenceFreshness(
  evidence = {},
  {
    now = new Date(),
    maxAgeDays = DEFAULT_PRODUCTION_EVIDENCE_MAX_AGE_DAYS,
    clockSkewMs = DEFAULT_CLOCK_SKEW_MS,
  } = {},
) {
  const errors = [];
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const maxAgeMs = maxAgeDays * DAY_MS;

  if (!Number.isFinite(nowMs)) {
    errors.push(
      error(
        "invalid_now",
        "production evidence freshness check requires a valid current time",
      ),
    );
  }

  for (const path of TIMESTAMP_PATHS) {
    validateTimestamp({ evidence, path, nowMs, maxAgeMs, clockSkewMs, errors });
  }

  return {
    name: "production_evidence_freshness",
    ok: errors.length === 0,
    status: errors.length === 0 ? "ok" : "failed",
    evidence: TIMESTAMP_PATHS,
    maxAgeDays,
    errors,
  };
}

function validateTimestamp({
  evidence,
  path,
  nowMs,
  maxAgeMs,
  clockSkewMs,
  errors,
}) {
  const value = valueAtPath(evidence, path);
  const timestampMs = Date.parse(value);

  if (!Number.isFinite(timestampMs)) {
    errors.push(
      error("invalid_timestamp", `${path} must be a valid ISO timestamp`),
    );
    return;
  }

  if (Number.isFinite(nowMs) && timestampMs > nowMs + clockSkewMs) {
    errors.push(error("future_timestamp", `${path} must not be in the future`));
  }

  if (Number.isFinite(nowMs) && nowMs - timestampMs > maxAgeMs) {
    errors.push(
      error(
        "stale_timestamp",
        `${path} must be no older than ${maxAgeMs / DAY_MS} days`,
      ),
    );
  }
}

function valueAtPath(value, path) {
  return path.split(".").reduce((current, segment) => {
    if (!current || typeof current !== "object") return undefined;
    return current[segment];
  }, value);
}

function error(code, message) {
  return { code, message };
}
