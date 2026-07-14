import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const BACKUP_COMPONENTS = Object.freeze([
  "repositories",
  "database",
  "attachments",
  "packages",
  "lfs",
  "configuration",
]);

const EXPECTED_BACKUP_CHECKS = Object.freeze([
  "backup_bundle_verified",
  "checksum_manifest_verified",
  "postgres_dump_verified",
  "offsite_upload_receipt_verified",
  "offsite_restore_receipt_verified",
  "restore_check_passed",
  "scheduled",
  "off_host",
  "encrypted",
  "components_complete",
]);

const EXPECTED_DATABASE_CHECKS = Object.freeze([
  "forgejo_postgres_configured",
  "steward_postgres_configured",
  "migration_output_verified",
  "restore_drill_output_verified",
  "checksum_drift_clean",
]);

const EXPECTED_RESTORE_TABLES = Object.freeze([
  "steward_schema_migrations",
  "steward_queue_items",
  "steward_runs",
  "steward_events",
  "steward_agent_claims",
  "steward_worker_leases",
]);

const IMAGE_PROVENANCE_IMAGE_FIELDS = Object.freeze([
  "forgejoImage",
  "stewardImage",
  "runnerImage",
  "dindImage",
]);

const IMAGE_PROVENANCE_EVIDENCE_FIELDS = Object.freeze([
  "stewardImageBuiltByCi",
  "stewardImageSignatureVerified",
  "sbomGenerated",
  "vulnerabilityScanClean",
]);

const EXPECTED_IMAGE_PROVENANCE_CHECKS = Object.freeze([
  "images_digest_pinned",
  ...IMAGE_PROVENANCE_EVIDENCE_FIELDS,
]);

const EXPECTED_REPOSITORY_PROTECTION_CHECKS = Object.freeze([
  "repo_policy_present",
  "queue_policy_enabled",
  "protected_branches_configured",
  "required_checks_configured",
  "trusted_actors_configured",
  "fork_policy_reviewed",
  "live_branch_protection_verified",
  "live_required_checks_verified",
]);

const EXPECTED_PILOT_BOOTSTRAP_STEPS = Object.freeze([
  "forgejo-api-schema",
  "mirror-repository",
  "verify-default-branch",
  "steward-webhook",
  "branch-protection",
  "repo-policy",
  "agent-identities",
  "pilot-surfaces",
]);

const PASSING_PILOT_BOOTSTRAP_STATUSES = Object.freeze([
  "verified",
  "verified-existing",
  "created",
  "updated",
  "upserted",
  "synced",
]);

const EXPECTED_SECRET_CHECKS = Object.freeze([
  "external_secret_store",
  "rotation_policy_documented",
  "app_ini_secrets_issued",
  "runner_token_issued",
  "oauth_secrets_issued",
  "webhook_secrets_issued",
  "private_reference_scan_passed",
]);

const EXPECTED_SECRET_GROUPS = Object.freeze([
  "appIniSecretsIssued",
  "runnerTokenIssued",
  "oauthSecretsIssued",
  "webhookSecretsIssued",
]);

const EXPECTED_MAIL_CHECKS = Object.freeze([
  "smtp_configured",
  "invite_smoke_passed",
  "password_reset_smoke_passed",
  "notification_smoke_passed",
]);

const EXPECTED_STORAGE_CHECKS = Object.freeze([
  "sizing_reviewed",
  "artifact_retention_configured",
  "package_retention_configured",
  "lfs_capacity_reviewed",
  "log_retention_configured",
]);

const EXPECTED_OBSERVABILITY_CHECKS = Object.freeze([
  "prometheus_scrape_ok",
  "alert_rules_loaded",
  "alert_routing_configured",
  "logs_collected",
  "log_retention_days_sufficient",
  "no_page_alerts_firing",
]);

const EXPECTED_SECURITY_REVIEW_CHECKS = Object.freeze([
  "auth_reviewed",
  "tokens_reviewed",
  "runner_execution_reviewed",
  "repo_permissions_reviewed",
  "approved_by_recorded",
  "approved_at_recorded",
]);

const EXPECTED_SECURITY_REVIEW_SURFACES = Object.freeze([
  "authReviewed",
  "tokensReviewed",
  "runnerExecutionReviewed",
  "repoPermissionsReviewed",
]);

const EXPECTED_DOMAIN_CHECKS = Object.freeze([
  "https_url",
  "host_matches",
  "tls_fetch",
  "canonical_root_url",
  "reverse_proxy_reviewed",
]);

const EXPECTED_IDENTITY_BOOTSTRAP_CHECKS = Object.freeze([
  "private env validates identity inputs",
  "compose config renders",
  "forgejo container is running and healthy",
  "forgejo CLI responds",
  "Eliza Cloud discovery document is valid",
  "local recovery admin exists",
  "Eliza Cloud OIDC auth source config matches env",
  "steward token authenticates as steward user",
]);

const EXPECTED_POST_DEPLOY_CHECK_PATTERNS = Object.freeze([
  [/Forgejo HTTP responds/u, "Forgejo HTTP responds"],
  [/Forgejo Eliza theme asset/u, "Forgejo Eliza theme"],
  [/Merge Steward \/ready is ok/u, "Merge Steward ready"],
  [
    /production readiness, production cutover, evidence template/u,
    "product API smoke",
  ],
  [/Merge Steward deployment doctor passes/u, "deployment doctor"],
  [/Merge queue rollout drill stays safely gated/u, "safe merge queue drill"],
]);

export function validateProductionGateArtifactSources(evidence = {}) {
  const errors = [];
  const domain = objectValue(evidence.domain);
  const backups = objectValue(evidence.backups);
  const database = objectValue(evidence.database);
  const rollout = objectValue(evidence.mergeQueueRollout);
  const steward = objectValue(evidence.steward);
  const sso = objectValue(evidence.sso);
  const runner = objectValue(evidence.runner);
  const repository = objectValue(evidence.repository);
  const githubMigration = objectValue(evidence.githubMigration);
  const imageProvenance = objectValue(evidence.imageProvenance);
  const secrets = objectValue(evidence.secrets);
  const mail = objectValue(evidence.mail);
  const storage = objectValue(evidence.storage);
  const observability = objectValue(evidence.observability);
  const securityReview = objectValue(evidence.securityReview);
  const deployment = objectValue(evidence.deployment);

  validateDomainArtifact(domain, errors);
  validateBackupArtifact(backups, errors);
  validateDatabaseArtifact(database, errors);
  validateImageProvenanceArtifact(imageProvenance, errors);
  validateSsoArtifacts(sso, errors);
  validateRunnerSmokeArtifact(runner, errors);
  validateRunnerAuditArtifact(runner, errors);
  validateRepositoryProtectionArtifact(repository, errors);
  validateGithubMigrationArtifact(githubMigration, errors);
  validateSecretManagementArtifact(secrets, errors);
  validateMailArtifact(mail, errors);
  validateStorageArtifact(storage, errors);
  validateObservabilityArtifact(observability, errors);
  validateStewardArtifacts(steward, errors);
  validateDryRunArtifact(rollout, errors);
  validateLiveDrillArtifact(rollout, errors);
  validateSecurityReviewArtifact(securityReview, errors);
  validateDeploymentArtifacts(deployment, errors);

  return {
    name: "production_evidence_artifacts",
    ok: errors.length === 0,
    status: errors.length === 0 ? "ok" : "failed",
    evidence: [
      "domain.probeEvidence.source",
      "domain.probeEvidence.sha256",
      "domain.probeEvidence.checkedAt",
      "domain.probeEvidence.status",
      "domain.probeEvidence.checkCount",
      "sso.smokeEvidence.source",
      "sso.smokeEvidence.sha256",
      "sso.smokeEvidence.checkedAt",
      "sso.bootstrapEvidence.source",
      "sso.bootstrapEvidence.sha256",
      "sso.bootstrapEvidence.checkedAt",
      "sso.bootstrapEvidence.status",
      "sso.bootstrapEvidence.checkCount",
      "backups.backupEvidence.source",
      "backups.backupEvidence.sha256",
      "backups.backupEvidence.checkedAt",
      "backups.backupEvidence.backupCreatedAt",
      "backups.backupEvidence.restoreCheckedAt",
      "backups.backupEvidence.componentCount",
      "backups.backupEvidence.checkCount",
      "backups.backupEvidence.offsiteUploadReceipt.source",
      "backups.backupEvidence.offsiteUploadReceipt.sha256",
      "backups.backupEvidence.offsiteUploadReceipt.checkedAt",
      "backups.backupEvidence.offsiteUploadReceipt.remoteArchive",
      "backups.backupEvidence.offsiteUploadReceipt.ciphertextSha256",
      "backups.backupEvidence.offsiteUploadReceipt.recipientsFileSha256",
      "backups.backupEvidence.offsiteRestoreReceipt.source",
      "backups.backupEvidence.offsiteRestoreReceipt.sha256",
      "backups.backupEvidence.offsiteRestoreReceipt.checkedAt",
      "backups.backupEvidence.offsiteRestoreReceipt.uploadReceiptSha256",
      "database.databaseEvidence.source",
      "database.databaseEvidence.sha256",
      "database.databaseEvidence.checkedAt",
      "database.databaseEvidence.status",
      "database.databaseEvidence.productionReady",
      "database.databaseEvidence.migrationOutputSource",
      "database.databaseEvidence.migrationOutputSha256",
      "database.databaseEvidence.restoreDrillOutputSource",
      "database.databaseEvidence.restoreDrillOutputSha256",
      "database.databaseEvidence.checkCount",
      "database.databaseEvidence.verifiedTableCount",
      "imageProvenance.provenanceEvidence.source",
      "imageProvenance.provenanceEvidence.sha256",
      "imageProvenance.provenanceEvidence.checkedAt",
      "imageProvenance.provenanceEvidence.imageCount",
      "imageProvenance.provenanceEvidence.checkCount",
      "runner.smokeEvidence.source",
      "runner.smokeEvidence.sha256",
      "runner.smokeEvidence.checkedAt",
      "runner.smokeEvidence.runId",
      "runner.auditEvidence.source",
      "runner.auditEvidence.sha256",
      "runner.auditEvidence.checkedAt",
      "runner.auditEvidence.checkCount",
      "repository.liveProtectionEvidence.source",
      "repository.liveProtectionEvidence.sha256",
      "repository.liveProtectionEvidence.checkedAt",
      "repository.liveProtectionEvidence.checkCount",
      "githubMigration.pilotBootstrapEvidence.source",
      "githubMigration.pilotBootstrapEvidence.sha256",
      "githubMigration.pilotBootstrapEvidence.checkedAt",
      "githubMigration.pilotBootstrapEvidence.status",
      "githubMigration.pilotBootstrapEvidence.dryRun",
      "githubMigration.pilotBootstrapEvidence.repo",
      "githubMigration.pilotBootstrapEvidence.upstreamHost",
      "githubMigration.pilotBootstrapEvidence.stepCount",
      "githubMigration.pilotBootstrapEvidence.requiredCheckCount",
      "githubMigration.pilotBootstrapEvidence.trustedAgentCount",
      "githubMigration.pilotBootstrapPassed",
      "githubMigration.mirrorVerified",
      "githubMigration.defaultBranchVerified",
      "githubMigration.webhookVerified",
      "githubMigration.branchProtectionVerified",
      "githubMigration.repoPolicyVerified",
      "githubMigration.agentIdentitiesSynced",
      "githubMigration.pilotSurfacesVerified",
      "githubMigration.pullMirrorOnly",
      "secrets.secretEvidence.source",
      "secrets.secretEvidence.sha256",
      "secrets.secretEvidence.checkedAt",
      "secrets.secretEvidence.status",
      "secrets.secretEvidence.productionReady",
      "secrets.secretEvidence.groupCount",
      "secrets.secretEvidence.checkCount",
      "mail.mailEvidence.source",
      "mail.mailEvidence.sha256",
      "mail.mailEvidence.checkedAt",
      "mail.mailEvidence.status",
      "mail.mailEvidence.productionReady",
      "mail.mailEvidence.checkCount",
      "storage.storageEvidence.source",
      "storage.storageEvidence.sha256",
      "storage.storageEvidence.checkedAt",
      "storage.storageEvidence.status",
      "storage.storageEvidence.productionReady",
      "storage.storageEvidence.checkCount",
      "observability.observabilityEvidence.source",
      "observability.observabilityEvidence.sha256",
      "observability.observabilityEvidence.checkedAt",
      "observability.observabilityEvidence.status",
      "observability.observabilityEvidence.productionReady",
      "observability.observabilityEvidence.checkCount",
      "steward.preflightEvidence.source",
      "steward.preflightEvidence.sha256",
      "steward.preflightEvidence.checkedAt",
      "steward.doctorEvidence.source",
      "steward.doctorEvidence.sha256",
      "steward.doctorEvidence.checkedAt",
      "mergeQueueRollout.dryRunEvidence.source",
      "mergeQueueRollout.dryRunEvidence.sha256",
      "mergeQueueRollout.dryRunEvidence.checkedAt",
      "mergeQueueRollout.dryRunEvidence.checkCount",
      "mergeQueueRollout.strictWorkReservationsEnforced",
      "mergeQueueRollout.strictWorkItemsEnforced",
      "mergeQueueRollout.strictAgentBranchNamespacesEnforced",
      "mergeQueueRollout.verifiedAgentRunReceiptsEnforced",
      "mergeQueueRollout.agentIdentityRegistryEnforced",
      "mergeQueueRollout.stackDependencyOrderEnforced",
      "mergeQueueRollout.liveDrillEvidence.source",
      "mergeQueueRollout.liveDrillEvidence.sha256",
      "mergeQueueRollout.liveDrillEvidence.checkedAt",
      "mergeQueueRollout.liveDrillEvidence.runId",
      "securityReview.securityEvidence.source",
      "securityReview.securityEvidence.sha256",
      "securityReview.securityEvidence.checkedAt",
      "securityReview.securityEvidence.status",
      "securityReview.securityEvidence.productionReady",
      "securityReview.securityEvidence.approvedBy",
      "securityReview.securityEvidence.approvedAt",
      "securityReview.securityEvidence.checkCount",
      "securityReview.securityEvidence.reviewedSurfaceCount",
      "deployment.deployEvidence.source",
      "deployment.deployEvidence.sha256",
      "deployment.deployEvidence.checkedAt",
      "deployment.deployEvidence.status",
      "deployment.deployEvidence.mode",
      "deployment.deployEvidence.dryRun",
      "deployment.deployEvidence.stepCount",
      "deployment.deployEvidence.postDeployEvidenceSource",
      "deployment.deployEvidence.postDeployEvidenceSha256",
      "deployment.postDeployEvidence.source",
      "deployment.postDeployEvidence.sha256",
      "deployment.postDeployEvidence.checkedAt",
      "deployment.postDeployEvidence.status",
      "deployment.postDeployEvidence.checkCount",
      "deployment.postDeployEvidence.failedCount",
    ],
    errors,
  };
}

function validateDomainArtifact(domain, errors) {
  const summary = objectValue(domain.probeEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "domain.probeEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "domain.probeEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const container = objectValue(body);
  const rawProbe = Object.hasOwn(container, "domainEvidence")
    ? container.domainEvidence
    : (container.domainProbe ??
      (Object.hasOwn(container, "domain") ? container : null));
  const probe = objectValue(rawProbe);
  if (probe !== rawProbe) {
    errors.push(
      error(
        "artifact_missing_block",
        "domain.probeEvidence.source must contain domain probe evidence",
      ),
    );
    return;
  }

  const checkedAt = normalizeIso(probe.checkedAt);
  const checks = arrayValue(probe.checks);
  const probeDomain = objectValue(probe.domain);

  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "domain probe checkedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "domain.probeEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (probe.status !== "ready") {
    errors.push(
      error("artifact_evidence_not_true", "domain probe must be ready"),
    );
  }
  if (summary.status !== probe.status) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "domain.probeEvidence.status must match the source artifact",
      ),
    );
  }
  if (
    typeof summary.checkCount !== "number" ||
    summary.checkCount !== checks.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "domain.probeEvidence.checkCount must match the source artifact",
      ),
    );
  }
  if (checks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "domain probe checks must be a non-empty array",
      ),
    );
  }
  if (checks.some((check) => check?.ok !== true)) {
    errors.push(
      error("artifact_failed_check", "domain probe checks must all be ok"),
    );
  }
  for (const checkName of EXPECTED_DOMAIN_CHECKS) {
    if (
      !checks.some((check) => check?.name === checkName && check.ok === true)
    ) {
      errors.push(
        error(
          "artifact_missing_check",
          `domain probe must include passing ${checkName}`,
        ),
      );
    }
  }
  for (const field of [
    "forgejoRootUrl",
    "forgejoDomain",
    "tlsVerified",
    "rootUrlCanonical",
    "reverseProxyReviewed",
  ]) {
    if (domain[field] !== probeDomain[field]) {
      errors.push(
        error(
          "artifact_summary_mismatch",
          `domain.${field} must match the source artifact`,
        ),
      );
    }
  }
}

function validateBackupArtifact(backups, errors) {
  const summary = objectValue(backups.backupEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "backups.backupEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "backups.backupEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const container = objectValue(body);
  const rawAudit = Object.hasOwn(container, "backupAudit")
    ? container.backupAudit
    : (container.backupEvidence ??
      container.backup ??
      container.audit ??
      container);
  const audit = objectValue(rawAudit);
  if (audit !== rawAudit) {
    errors.push(
      error(
        "artifact_missing_block",
        "backups.backupEvidence.source must contain backup audit evidence",
      ),
    );
    return;
  }

  const checkedAt = normalizeIso(audit.checkedAt ?? audit.computedAt);
  const backupCreatedAt = normalizeIso(audit.backupCreatedAt);
  const restoreCheckedAt = normalizeIso(audit.restoreCheckedAt);
  const includes = stringArray(audit.includes);
  const checks = arrayValue(audit.checks);
  const attestations = objectValue(audit.attestations);

  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "backup audit checkedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "backups.backupEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (!backupCreatedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "backup audit backupCreatedAt must be a valid timestamp",
      ),
    );
  } else if (
    normalizeIso(summary.backupCreatedAt) !== backupCreatedAt ||
    normalizeIso(backups.lastBackupAt) !== backupCreatedAt
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "backups.lastBackupAt and backupEvidence.backupCreatedAt must match the source artifact",
      ),
    );
  }
  if (!restoreCheckedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "backup audit restoreCheckedAt must be a valid timestamp",
      ),
    );
  } else if (
    normalizeIso(summary.restoreCheckedAt) !== restoreCheckedAt ||
    normalizeIso(backups.lastRestoreCheckAt) !== restoreCheckedAt
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "backups.lastRestoreCheckAt and backupEvidence.restoreCheckedAt must match the source artifact",
      ),
    );
  }
  if (audit.status !== "verified" || audit.productionReady !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "backup audit must be production-ready and verified",
      ),
    );
  }
  if (summary.status !== audit.status) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "backups.backupEvidence.status must match the source artifact",
      ),
    );
  }
  if (summary.productionReady !== audit.productionReady) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "backups.backupEvidence.productionReady must match the source artifact",
      ),
    );
  }
  if (
    !sameStringArray(backups.includes, includes) ||
    !sameStringArray(includes, BACKUP_COMPONENTS)
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "backups.includes must match complete source artifact components",
      ),
    );
  }
  if (
    typeof summary.componentCount !== "number" ||
    summary.componentCount !== includes.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "backups.backupEvidence.componentCount must match the source artifact",
      ),
    );
  }
  if (
    typeof summary.checkCount !== "number" ||
    summary.checkCount !== checks.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "backups.backupEvidence.checkCount must match the source artifact",
      ),
    );
  }
  if (checks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "backup audit checks must be a non-empty array",
      ),
    );
  }
  if (checks.some((check) => check?.status !== "pass")) {
    errors.push(
      error("artifact_failed_check", "backup audit checks must all pass"),
    );
  }
  for (const checkName of EXPECTED_BACKUP_CHECKS) {
    if (
      !checks.some(
        (check) => check?.name === checkName && check.status === "pass",
      )
    ) {
      errors.push(
        error(
          "artifact_missing_check",
          `backup audit must include passing ${checkName}`,
        ),
      );
    }
  }
  for (const field of ["scheduled", "offHost", "encrypted"]) {
    if (backups[field] !== true || attestations[field] !== true) {
      errors.push(
        error(
          "artifact_evidence_not_true",
          `backup audit attestation ${field} must be true`,
        ),
      );
    }
  }
  if (attestations.restoreCheckPassed !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "backup audit attestation restoreCheckPassed must be true",
      ),
    );
  }

  const uploadSummary = objectValue(summary.offsiteUploadReceipt);
  const restoreSummary = objectValue(summary.offsiteRestoreReceipt);
  const uploadReceipt = validateBackupUploadReceipt(
    uploadSummary,
    objectValue(audit.offsiteUploadReceipt),
    errors,
  );
  const restoreReceipt = validateBackupRestoreReceipt(
    restoreSummary,
    objectValue(audit.offsiteRestoreReceipt),
    errors,
  );

  if (uploadReceipt && restoreReceipt) {
    const uploadCheckedAt = Date.parse(uploadReceipt.checkedAt);
    const restoreCheckedAt = Date.parse(restoreReceipt.checkedAt);
    if (
      Number.isFinite(uploadCheckedAt) &&
      Number.isFinite(restoreCheckedAt) &&
      restoreCheckedAt < uploadCheckedAt
    ) {
      errors.push(
        error(
          "artifact_timestamp_order_invalid",
          "off-site restore receipt must not predate the upload receipt",
        ),
      );
    }
    if (restoreReceipt.uploadReceiptSha256 !== uploadSummary.sha256) {
      errors.push(
        error(
          "artifact_summary_mismatch",
          "off-site restore receipt must reference the retained upload receipt SHA-256",
        ),
      );
    }
    if (
      restoreReceipt.remoteArchive !== uploadReceipt.remoteArchive ||
      restoreReceipt.remoteReceipt !== uploadReceipt.remoteReceipt
    ) {
      errors.push(
        error(
          "artifact_summary_mismatch",
          "off-site upload and restore receipt remote paths must match",
        ),
      );
    }
    if (
      restoreReceipt.ciphertext?.sha256 !== uploadReceipt.ciphertext?.sha256 ||
      restoreReceipt.ciphertext?.bytes !== uploadReceipt.ciphertext?.bytes
    ) {
      errors.push(
        error(
          "artifact_summary_mismatch",
          "off-site upload and restore receipts must identify the same ciphertext",
        ),
      );
    }
  }
}

function validateBackupUploadReceipt(summary, auditSummary, errors) {
  const artifact = readJsonArtifact(
    summary.source,
    "backups.backupEvidence.offsiteUploadReceipt.source",
    errors,
  );
  if (!artifact) return null;

  requireArtifactSha(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const receipt = objectValue(artifact.body);
  const ciphertext = objectValue(receipt.ciphertext);
  const encryption = objectValue(receipt.encryption);
  const remoteArchive = stringValue(receipt.remoteArchive);
  const remoteReceipt = stringValue(receipt.remoteReceipt);
  const backupName = stringValue(receipt.backupName);

  if (
    receipt.schema !== "https://eliza.hub/schemas/offsite-backup-receipt.v1" ||
    receipt.status !== "verified" ||
    receipt.uploadVerified !== true ||
    receipt.verificationMethod !== "download_sha256" ||
    encryption.format !== "age" ||
    !/^[a-f0-9]{64}$/u.test(encryption.recipientsFileSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(receipt.sourceManifestSha256 ?? "") ||
    !/^[a-f0-9]{64}$/u.test(receipt.sourceChecksumsSha256 ?? "")
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "off-site upload receipt must prove age encryption and download SHA-256 verification",
      ),
    );
  }
  if (
    remoteArchive === null ||
    remoteReceipt === null ||
    backupName === null ||
    /[\r\n]/u.test(remoteArchive) ||
    /[\r\n]/u.test(remoteReceipt) ||
    !/^[a-zA-Z0-9._-]+:.+\/.+$/u.test(remoteArchive) ||
    remoteReceipt !==
      `${remoteArchive.slice(0, remoteArchive.lastIndexOf("/"))}/receipt.json` ||
    !remoteArchive.endsWith(`/${backupName}.tar.gz.age`)
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "off-site upload receipt remote paths must identify the backup archive and colocated receipt",
      ),
    );
  }

  compareReceiptTimestamp(
    summary,
    receipt,
    "checkedAt",
    "offsiteUploadReceipt",
    errors,
  );
  compareReceiptTimestamp(
    summary,
    receipt,
    "backupCreatedAt",
    "offsiteUploadReceipt",
    errors,
  );
  compareReceiptField(
    summary,
    receipt,
    "status",
    "offsiteUploadReceipt",
    errors,
  );
  compareReceiptField(
    summary,
    receipt,
    "backupName",
    "offsiteUploadReceipt",
    errors,
  );
  compareReceiptField(
    summary,
    receipt,
    "remoteArchive",
    "offsiteUploadReceipt",
    errors,
  );
  compareReceiptField(
    summary,
    receipt,
    "remoteReceipt",
    "offsiteUploadReceipt",
    errors,
  );
  compareReceiptField(
    summary,
    ciphertext,
    "sha256",
    "offsiteUploadReceipt",
    errors,
    "ciphertextSha256",
  );
  compareReceiptField(
    summary,
    ciphertext,
    "bytes",
    "offsiteUploadReceipt",
    errors,
    "ciphertextBytes",
  );
  compareReceiptField(
    summary,
    encryption,
    "format",
    "offsiteUploadReceipt",
    errors,
    "encryptionFormat",
  );
  compareReceiptField(
    summary,
    encryption,
    "recipientsFileSha256",
    "offsiteUploadReceipt",
    errors,
  );
  compareReceiptField(
    summary,
    receipt,
    "verificationMethod",
    "offsiteUploadReceipt",
    errors,
  );
  const backupCreatedAt = Date.parse(receipt.backupCreatedAt);
  const uploadCheckedAt = Date.parse(receipt.checkedAt);
  if (
    Number.isFinite(backupCreatedAt) &&
    Number.isFinite(uploadCheckedAt) &&
    uploadCheckedAt < backupCreatedAt
  ) {
    errors.push(
      error(
        "artifact_timestamp_order_invalid",
        "off-site upload receipt must not predate the backup",
      ),
    );
  }
  if (summary.verified !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "offsiteUploadReceipt.verified must be true",
      ),
    );
  }
  compareBackupAuditReceipt(
    summary,
    auditSummary,
    "offsiteUploadReceipt",
    errors,
  );
  return receipt;
}

function validateBackupRestoreReceipt(summary, auditSummary, errors) {
  const artifact = readJsonArtifact(
    summary.source,
    "backups.backupEvidence.offsiteRestoreReceipt.source",
    errors,
  );
  if (!artifact) return null;

  requireArtifactSha(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const receipt = objectValue(artifact.body);
  const ciphertext = objectValue(receipt.ciphertext);

  if (
    receipt.schema !== "https://eliza.hub/schemas/offsite-restore-receipt.v1" ||
    receipt.status !== "verified" ||
    receipt.downloadVerified !== true ||
    receipt.decryptionVerified !== true ||
    receipt.archivePathsVerified !== true ||
    receipt.structuralRestoreCheckPassed !== true
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "off-site restore receipt must prove download, decryption, archive-path, and structural checks",
      ),
    );
  }

  compareReceiptTimestamp(
    summary,
    receipt,
    "checkedAt",
    "offsiteRestoreReceipt",
    errors,
  );
  compareReceiptField(
    summary,
    receipt,
    "status",
    "offsiteRestoreReceipt",
    errors,
  );
  compareReceiptField(
    summary,
    receipt,
    "remoteArchive",
    "offsiteRestoreReceipt",
    errors,
  );
  compareReceiptField(
    summary,
    receipt,
    "remoteReceipt",
    "offsiteRestoreReceipt",
    errors,
  );
  compareReceiptField(
    summary,
    receipt,
    "uploadReceiptSha256",
    "offsiteRestoreReceipt",
    errors,
  );
  compareReceiptField(
    summary,
    ciphertext,
    "sha256",
    "offsiteRestoreReceipt",
    errors,
    "ciphertextSha256",
  );
  compareReceiptField(
    summary,
    ciphertext,
    "bytes",
    "offsiteRestoreReceipt",
    errors,
    "ciphertextBytes",
  );
  for (const field of [
    "downloadVerified",
    "decryptionVerified",
    "archivePathsVerified",
    "structuralRestoreCheckPassed",
  ]) {
    compareReceiptField(
      summary,
      receipt,
      field,
      "offsiteRestoreReceipt",
      errors,
    );
  }
  if (summary.verified !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "offsiteRestoreReceipt.verified must be true",
      ),
    );
  }
  compareBackupAuditReceipt(
    summary,
    auditSummary,
    "offsiteRestoreReceipt",
    errors,
  );
  return receipt;
}

function compareReceiptTimestamp(summary, receipt, field, label, errors) {
  const summaryValue = normalizeIso(summary[field]);
  const receiptValue = normalizeIso(receipt[field]);
  if (!receiptValue || summaryValue !== receiptValue) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        `backups.backupEvidence.${label}.${field} must match its source receipt`,
      ),
    );
  }
}

function compareReceiptField(
  summary,
  receipt,
  receiptField,
  label,
  errors,
  summaryField = receiptField,
) {
  if (summary[summaryField] !== receipt[receiptField]) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        `backups.backupEvidence.${label}.${summaryField} must match its source receipt`,
      ),
    );
  }
}

function compareBackupAuditReceipt(summary, auditSummary, label, errors) {
  for (const field of Object.keys(summary)) {
    if (summary[field] !== auditSummary[field]) {
      errors.push(
        error(
          "artifact_summary_mismatch",
          `backup audit ${label}.${field} must match production evidence`,
        ),
      );
    }
  }
}

function validateDatabaseArtifact(database, errors) {
  const summary = objectValue(database.databaseEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "database.databaseEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "database.databaseEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const container = objectValue(body);
  const rawAudit = Object.hasOwn(container, "databaseAudit")
    ? container.databaseAudit
    : (container.databaseEvidence ??
      container.database ??
      container.audit ??
      container);
  const audit = objectValue(rawAudit);
  if (audit !== rawAudit) {
    errors.push(
      error(
        "artifact_missing_block",
        "database.databaseEvidence.source must contain database audit evidence",
      ),
    );
    return;
  }

  const checkedAt = normalizeIso(audit.checkedAt ?? audit.computedAt);
  const evidence = objectValue(audit.evidence);
  const migrationOutput = objectValue(audit.migrationOutput);
  const restoreDrillOutput = objectValue(audit.restoreDrillOutput);
  const verifiedTables = stringArray(audit.verifiedTables);
  const checks = arrayValue(audit.checks);

  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "database audit checkedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "database.databaseEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (audit.status !== "verified" || audit.productionReady !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "database audit must be production-ready and verified",
      ),
    );
  }
  if (summary.status !== audit.status) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "database.databaseEvidence.status must match the source artifact",
      ),
    );
  }
  if (summary.productionReady !== audit.productionReady) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "database.databaseEvidence.productionReady must match the source artifact",
      ),
    );
  }

  for (const field of [
    "forgejoPostgres",
    "stewardPostgres",
    "migrationsApplied",
    "emptyHostRestoreDrillPassed",
    "checksumDriftClean",
  ]) {
    if (database[field] !== true || evidence[field] !== true) {
      errors.push(
        error(
          "artifact_evidence_not_true",
          `database audit evidence ${field} must be true`,
        ),
      );
    }
  }

  validateDatabaseSourceArtifact({
    label: "migration output",
    sourcePath: "database.databaseEvidence.migrationOutputSource",
    shaPath: "database.databaseEvidence.migrationOutputSha256",
    summarySource: summary.migrationOutputSource,
    summarySha: summary.migrationOutputSha256,
    auditSource: migrationOutput.source,
    auditSha: migrationOutput.sha256,
    predicate: migrationOutputPassed,
    errors,
  });
  validateDatabaseSourceArtifact({
    label: "restore drill output",
    sourcePath: "database.databaseEvidence.restoreDrillOutputSource",
    shaPath: "database.databaseEvidence.restoreDrillOutputSha256",
    summarySource: summary.restoreDrillOutputSource,
    summarySha: summary.restoreDrillOutputSha256,
    auditSource: restoreDrillOutput.source,
    auditSha: restoreDrillOutput.sha256,
    predicate: restoreDrillPassed,
    errors,
  });

  if (!sameStringArray(verifiedTables, EXPECTED_RESTORE_TABLES)) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "database audit verifiedTables must include every expected table",
      ),
    );
  }
  if (
    typeof summary.verifiedTableCount !== "number" ||
    summary.verifiedTableCount !== verifiedTables.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "database.databaseEvidence.verifiedTableCount must match the source artifact",
      ),
    );
  }
  if (
    typeof summary.checkCount !== "number" ||
    summary.checkCount !== checks.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "database.databaseEvidence.checkCount must match the source artifact",
      ),
    );
  }
  if (checks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "database audit checks must be a non-empty array",
      ),
    );
  }
  if (checks.some((check) => check?.status !== "pass")) {
    errors.push(
      error("artifact_failed_check", "database audit checks must all pass"),
    );
  }
  for (const checkName of EXPECTED_DATABASE_CHECKS) {
    if (
      !checks.some(
        (check) => check?.name === checkName && check.status === "pass",
      )
    ) {
      errors.push(
        error(
          "artifact_missing_check",
          `database audit must include passing ${checkName}`,
        ),
      );
    }
  }
}

function validateDatabaseSourceArtifact({
  label,
  sourcePath,
  shaPath,
  summarySource,
  summarySha,
  auditSource,
  auditSha,
  predicate,
  errors,
}) {
  if (summarySource !== auditSource) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        `${sourcePath} must match the database audit artifact`,
      ),
    );
  }
  if (summarySha !== auditSha) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        `${shaPath} must match the database audit artifact`,
      ),
    );
  }

  const artifact = readTextArtifact(auditSource, sourcePath, errors);
  if (!artifact) return;
  requireArtifactSha(errors, shaPath, summarySha, artifact.sha256);
  requireArtifactSha(errors, shaPath, auditSha, artifact.sha256);
  if (!predicate(artifact.body)) {
    errors.push(
      error(
        "artifact_failed_check",
        `${label} does not satisfy database audit criteria`,
      ),
    );
  }
}

function validateImageProvenanceArtifact(imageProvenance, errors) {
  const summary = objectValue(imageProvenance.provenanceEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "imageProvenance.provenanceEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "imageProvenance.provenanceEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const container = objectValue(body);
  const rawAudit = Object.hasOwn(container, "imageProvenanceAudit")
    ? container.imageProvenanceAudit
    : (container.imageProvenance ?? container.audit ?? container);
  const audit = objectValue(rawAudit);
  if (audit !== rawAudit) {
    errors.push(
      error(
        "artifact_missing_block",
        "imageProvenance.provenanceEvidence.source must contain image provenance audit evidence",
      ),
    );
    return;
  }

  const checkedAt = normalizeIso(audit.checkedAt ?? audit.computedAt);
  const images = objectValue(audit.images);
  const evidence = objectValue(audit.evidence);
  const checks = arrayValue(audit.checks);

  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "image provenance audit checkedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "imageProvenance.provenanceEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (audit.status !== "verified" || audit.productionReady !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "image provenance audit must be production-ready and verified",
      ),
    );
  }
  if (
    typeof summary.imageCount !== "number" ||
    summary.imageCount !== IMAGE_PROVENANCE_IMAGE_FIELDS.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "imageProvenance.provenanceEvidence.imageCount must match required image count",
      ),
    );
  }
  if (
    typeof summary.checkCount !== "number" ||
    summary.checkCount !== checks.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "imageProvenance.provenanceEvidence.checkCount must match the source artifact",
      ),
    );
  }
  if (checks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "image provenance audit checks must be a non-empty array",
      ),
    );
  }
  if (checks.some((check) => check?.status !== "pass")) {
    errors.push(
      error(
        "artifact_failed_check",
        "image provenance audit checks must all pass",
      ),
    );
  }
  for (const checkName of EXPECTED_IMAGE_PROVENANCE_CHECKS) {
    if (
      !checks.some(
        (check) => check?.name === checkName && check.status === "pass",
      )
    ) {
      errors.push(
        error(
          "artifact_missing_check",
          `image provenance audit must include passing ${checkName}`,
        ),
      );
    }
  }
  for (const field of IMAGE_PROVENANCE_IMAGE_FIELDS) {
    if (images[field] !== imageProvenance[field]) {
      errors.push(
        error(
          "artifact_summary_mismatch",
          `imageProvenance.${field} must match the source artifact`,
        ),
      );
    }
  }
  for (const field of IMAGE_PROVENANCE_EVIDENCE_FIELDS) {
    if (evidence[field] !== true) {
      errors.push(
        error(
          "artifact_evidence_not_true",
          `image provenance audit evidence ${field} must be true`,
        ),
      );
    }
    if (imageProvenance[field] !== evidence[field]) {
      errors.push(
        error(
          "artifact_summary_mismatch",
          `imageProvenance.${field} must match the source artifact`,
        ),
      );
    }
  }
}

function validateRunnerSmokeArtifact(runner, errors) {
  const summary = objectValue(runner.smokeEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "runner.smokeEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "runner.smokeEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const container = objectValue(body);
  const rawSmoke = Object.hasOwn(container, "runnerSmoke")
    ? container.runnerSmoke
    : (container.smoke ?? container);
  const smoke = objectValue(rawSmoke);
  if (smoke !== rawSmoke) {
    errors.push(
      error(
        "artifact_missing_block",
        "runner.smokeEvidence.source must contain runner smoke evidence",
      ),
    );
    return;
  }

  const checkedAt = normalizeIso(
    smoke.observedAt ??
      smoke.checkedAt ??
      smoke.completedAt ??
      smoke.requestedAt,
  );
  const runId = normalizeId(
    smoke.runId ?? smoke.workflowRun?.runId ?? smoke.workflowRun?.id,
  );
  const summaryRunId = normalizeId(summary.runId);
  const workflowRunUrl = stringValue(
    smoke.workflowRunUrl ?? smoke.url ?? smoke.workflowRun?.url,
  );
  const conclusion = String(
    smoke.conclusion ?? smoke.result ?? "",
  ).toLowerCase();

  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "runner smoke observedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "runner.smokeEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (
    smoke.trustedWorkflowPassed !== true &&
    smoke.passed !== true &&
    smoke.ok !== true
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "runner smoke must prove the trusted workflow passed",
      ),
    );
  }
  if (conclusion && !["success", "passed"].includes(conclusion)) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "runner smoke conclusion must be success",
      ),
    );
  }
  if (!runId) {
    errors.push(
      error(
        "artifact_missing_run",
        "runner smoke must include a workflow run id",
      ),
    );
  } else if (summaryRunId !== runId) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "runner.smokeEvidence.runId must match the source artifact",
      ),
    );
  }
  if (summary.repository !== smoke.repository) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "runner.smokeEvidence.repository must match the source artifact",
      ),
    );
  }
  if (summary.workflow !== smoke.workflow) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "runner.smokeEvidence.workflow must match the source artifact",
      ),
    );
  }
  if (summary.workflowRunUrl !== workflowRunUrl) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "runner.smokeEvidence.workflowRunUrl must match the source artifact",
      ),
    );
  }
}

function validateRunnerAuditArtifact(runner, errors) {
  const summary = objectValue(runner.auditEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "runner.auditEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "runner.auditEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const container = objectValue(body);
  const rawAudit = Object.hasOwn(container, "runnerIsolation")
    ? container.runnerIsolation
    : container;
  const audit = objectValue(rawAudit);
  if (audit !== rawAudit) {
    errors.push(
      error(
        "artifact_missing_block",
        "runner.auditEvidence.source must contain runner isolation audit evidence",
      ),
    );
    return;
  }

  const checkedAt = normalizeIso(audit.computedAt ?? audit.checkedAt);
  const checks = arrayValue(audit.checks);
  const auditRunner = objectValue(objectValue(audit.evidence).runner);

  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "runner isolation audit computedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "runner.auditEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (audit.status !== "isolated" || audit.productionReady !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "runner isolation audit must be production-ready and isolated",
      ),
    );
  }
  if (summary.status !== audit.status) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "runner.auditEvidence.status must match the source artifact",
      ),
    );
  }
  if (checks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "runner isolation audit checks must be a non-empty array",
      ),
    );
  }
  if (
    typeof summary.checkCount !== "number" ||
    summary.checkCount !== checks.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "runner.auditEvidence.checkCount must match the source artifact",
      ),
    );
  }
  if (checks.some((check) => check?.status !== "pass")) {
    errors.push(
      error(
        "artifact_failed_check",
        "runner isolation audit checks must all pass",
      ),
    );
  }

  for (const field of [
    "isolated",
    "noHostDockerSocket",
    "noHostLabels",
    "registrationTested",
    "trustedSmokeWorkflowPassed",
    "egressReviewed",
    "secretExposureReviewed",
  ]) {
    if (auditRunner[field] !== true) {
      errors.push(
        error(
          "artifact_evidence_not_true",
          `runner isolation audit evidence ${field} must be true`,
        ),
      );
    }
    if (runner[field] !== auditRunner[field]) {
      errors.push(
        error(
          "artifact_summary_mismatch",
          `runner.${field} must match the runner isolation audit`,
        ),
      );
    }
  }
}

function validateRepositoryProtectionArtifact(repository, errors) {
  const summary = objectValue(repository.liveProtectionEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "repository.liveProtectionEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "repository.liveProtectionEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const container = objectValue(body);
  const rawAudit = Object.hasOwn(container, "repositoryProtection")
    ? container.repositoryProtection
    : (container.repositoryProtectionAudit ?? container.audit ?? container);
  const audit = objectValue(rawAudit);
  if (audit !== rawAudit) {
    errors.push(
      error(
        "artifact_missing_block",
        "repository.liveProtectionEvidence.source must contain repository protection evidence",
      ),
    );
    return;
  }

  const checkedAt = normalizeIso(audit.computedAt ?? audit.checkedAt);
  const checks = arrayValue(audit.checks);
  const policy = objectValue(audit.policy);
  const live = objectValue(audit.live);
  const protectedBranches = stringArray(
    policy.protectedBranches ?? policy.protected_branches,
  );
  const requiredChecks = stringArray(
    policy.requiredChecks ?? policy.required_checks,
  );

  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "repository protection audit computedAt or checkedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "repository.liveProtectionEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (audit.status !== "protected" || audit.productionReady !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "repository protection audit must be production-ready and protected",
      ),
    );
  }
  if (summary.status !== audit.status) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "repository.liveProtectionEvidence.status must match the source artifact",
      ),
    );
  }
  if (summary.productionReady !== audit.productionReady) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "repository.liveProtectionEvidence.productionReady must match the source artifact",
      ),
    );
  }
  if (live.available !== true || live.required !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "repository protection audit must include required live verification",
      ),
    );
  }
  if (summary.liveAvailable !== live.available) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "repository.liveProtectionEvidence.liveAvailable must match the source artifact",
      ),
    );
  }
  if (summary.liveRequired !== live.required) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "repository.liveProtectionEvidence.liveRequired must match the source artifact",
      ),
    );
  }
  if (checks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "repository protection audit checks must be a non-empty array",
      ),
    );
  }
  if (
    typeof summary.checkCount !== "number" ||
    summary.checkCount !== checks.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "repository.liveProtectionEvidence.checkCount must match the source artifact",
      ),
    );
  }
  if (checks.some((check) => check?.status !== "pass")) {
    errors.push(
      error(
        "artifact_failed_check",
        "repository protection audit checks must all pass",
      ),
    );
  }
  for (const checkName of EXPECTED_REPOSITORY_PROTECTION_CHECKS) {
    if (
      !checks.some(
        (check) => check?.name === checkName && check.status === "pass",
      )
    ) {
      errors.push(
        error(
          "artifact_missing_check",
          `repository protection audit must include passing ${checkName}`,
        ),
      );
    }
  }
  if (protectedBranches.length === 0) {
    errors.push(
      error(
        "artifact_missing_policy",
        "repository protection audit must include protected branch policy",
      ),
    );
  }
  if (requiredChecks.length === 0) {
    errors.push(
      error(
        "artifact_missing_policy",
        "repository protection audit must include required check policy",
      ),
    );
  }
  if (!sameStringArray(repository.protectedBranches, protectedBranches)) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "repository.protectedBranches must match the source artifact",
      ),
    );
  }
  if (!sameStringArray(repository.requiredChecks, requiredChecks)) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "repository.requiredChecks must match the source artifact",
      ),
    );
  }
}

function validateGithubMigrationArtifact(githubMigration, errors) {
  const summary = objectValue(githubMigration.pilotBootstrapEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "githubMigration.pilotBootstrapEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "githubMigration.pilotBootstrapEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const receipt = objectValue(body);
  const receiptSummary = objectValue(receipt.summary);
  const migration = objectValue(receipt.migration);
  const repo = objectValue(receipt.repo);
  const upstream = objectValue(receipt.upstream);
  const steps = arrayValue(receipt.steps);
  const requiredChecks = stringArray(receipt.requiredChecks);
  const trustedAgentIds = stringArray(receipt.trustedAgentIds);
  const checkedAt = normalizeIso(receipt.finishedAt ?? receipt.checkedAt);

  if (
    receipt.schema !== "https://eliza.hub/schemas/pilot-bootstrap-evidence.v1"
  ) {
    errors.push(
      error(
        "artifact_unexpected_schema",
        "pilot bootstrap evidence must use pilot-bootstrap-evidence.v1",
      ),
    );
  }
  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "pilot bootstrap evidence finishedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "githubMigration.pilotBootstrapEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (receipt.status !== "passed" || summary.status !== "passed") {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "pilot bootstrap evidence must be passed",
      ),
    );
  }
  if (receipt.dryRun !== false || summary.dryRun !== false) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "pilot bootstrap evidence must come from --apply, not a dry run",
      ),
    );
  }
  if (summary.repo !== repo.fullName) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "githubMigration.pilotBootstrapEvidence.repo must match the source artifact",
      ),
    );
  }
  if (summary.upstreamHost !== upstream.host) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "githubMigration.pilotBootstrapEvidence.upstreamHost must match the source artifact",
      ),
    );
  }
  if (upstream.host !== "github.com" || upstream.service !== "github") {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "pilot bootstrap evidence must target a GitHub upstream",
      ),
    );
  }
  if (
    migration.direction !== "pull" ||
    migration.mirror !== true ||
    migration.private !== true
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "pilot bootstrap evidence must prove a private pull mirror",
      ),
    );
  }
  if (
    typeof summary.stepCount !== "number" ||
    summary.stepCount !== steps.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "githubMigration.pilotBootstrapEvidence.stepCount must match the source artifact",
      ),
    );
  }
  if (
    typeof summary.requiredCheckCount !== "number" ||
    summary.requiredCheckCount !== requiredChecks.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "githubMigration.pilotBootstrapEvidence.requiredCheckCount must match required checks",
      ),
    );
  }
  if (
    typeof summary.trustedAgentCount !== "number" ||
    summary.trustedAgentCount !== trustedAgentIds.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "githubMigration.pilotBootstrapEvidence.trustedAgentCount must match trusted agents",
      ),
    );
  }
  if (requiredChecks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "pilot bootstrap evidence must include required checks",
      ),
    );
  }
  if (trustedAgentIds.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "pilot bootstrap evidence must include trusted agent identities",
      ),
    );
  }
  if (steps.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "pilot bootstrap evidence steps must be non-empty",
      ),
    );
  }
  for (const stepName of EXPECTED_PILOT_BOOTSTRAP_STEPS) {
    if (!successfulPilotBootstrapStep(steps, stepName)) {
      errors.push(
        error(
          "artifact_missing_check",
          `pilot bootstrap evidence must include successful ${stepName}`,
        ),
      );
    }
  }

  const expectedBooleans = {
    pilotBootstrapPassed:
      receipt.status === "passed" &&
      receipt.dryRun === false &&
      receiptSummary.productionReady === true,
    mirrorVerified: receiptSummary.mirrorVerified === true,
    defaultBranchVerified: receiptSummary.defaultBranchVerified === true,
    webhookVerified: receiptSummary.webhookVerified === true,
    branchProtectionVerified: receiptSummary.branchProtectionVerified === true,
    repoPolicyVerified: receiptSummary.repoPolicyVerified === true,
    agentIdentitiesSynced: receiptSummary.agentIdentitiesSynced === true,
    pilotSurfacesVerified: receiptSummary.pilotSurfacesVerified === true,
    pullMirrorOnly: receiptSummary.pullMirrorOnly === true,
  };

  for (const [field, expected] of Object.entries(expectedBooleans)) {
    if (expected !== true) {
      errors.push(
        error(
          "artifact_evidence_not_true",
          `pilot bootstrap summary ${field} must be true`,
        ),
      );
    }
    if (githubMigration[field] !== expected) {
      errors.push(
        error(
          "artifact_summary_mismatch",
          `githubMigration.${field} must match the source artifact`,
        ),
      );
    }
  }
}

function successfulPilotBootstrapStep(steps, name) {
  return steps.some(
    (step) =>
      step?.name === name &&
      PASSING_PILOT_BOOTSTRAP_STATUSES.includes(step.status) &&
      (name !== "mirror-repository" ||
        step.status === "created" ||
        step.mirror === true),
  );
}

function validateSecretManagementArtifact(secrets, errors) {
  const summary = objectValue(secrets.secretEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "secrets.secretEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "secrets.secretEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const container = objectValue(body);
  const rawAudit = Object.hasOwn(container, "secretManagementAudit")
    ? container.secretManagementAudit
    : (container.secretEvidence ??
      container.secrets ??
      container.audit ??
      container);
  const audit = objectValue(rawAudit);
  if (audit !== rawAudit) {
    errors.push(
      error(
        "artifact_missing_block",
        "secrets.secretEvidence.source must contain secret management audit evidence",
      ),
    );
    return;
  }

  const checkedAt = normalizeIso(audit.checkedAt ?? audit.computedAt);
  const evidence = objectValue(audit.evidence);
  const checks = arrayValue(audit.checks);
  const issuedGroups = stringArray(audit.issuedGroups);

  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "secret management audit checkedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "secrets.secretEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (audit.status !== "verified" || audit.productionReady !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "secret management audit must be production-ready and verified",
      ),
    );
  }
  if (summary.status !== audit.status) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "secrets.secretEvidence.status must match the source artifact",
      ),
    );
  }
  if (summary.productionReady !== audit.productionReady) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "secrets.secretEvidence.productionReady must match the source artifact",
      ),
    );
  }

  for (const field of [
    "externalSecretStore",
    "rotationPolicyDocumented",
    "appIniSecretsIssued",
    "runnerTokenIssued",
    "oauthSecretsIssued",
    "webhookSecretsIssued",
    "noPlaintextSecretsCommitted",
  ]) {
    if (secrets[field] !== true || evidence[field] !== true) {
      errors.push(
        error(
          "artifact_evidence_not_true",
          `secret management audit evidence ${field} must be true`,
        ),
      );
    }
  }
  if (
    typeof summary.groupCount !== "number" ||
    summary.groupCount !== issuedGroups.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "secrets.secretEvidence.groupCount must match the source artifact",
      ),
    );
  }
  if (!sameStringArray(issuedGroups, EXPECTED_SECRET_GROUPS)) {
    errors.push(
      error(
        "artifact_missing_checks",
        "secret management audit must include every expected issued secret group",
      ),
    );
  }
  if (
    typeof summary.checkCount !== "number" ||
    summary.checkCount !== checks.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "secrets.secretEvidence.checkCount must match the source artifact",
      ),
    );
  }
  if (checks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "secret management audit checks must be a non-empty array",
      ),
    );
  }
  if (checks.some((check) => check?.status !== "pass")) {
    errors.push(
      error(
        "artifact_failed_check",
        "secret management audit checks must all pass",
      ),
    );
  }
  for (const checkName of EXPECTED_SECRET_CHECKS) {
    if (
      !checks.some(
        (check) => check?.name === checkName && check.status === "pass",
      )
    ) {
      errors.push(
        error(
          "artifact_missing_check",
          `secret management audit must include passing ${checkName}`,
        ),
      );
    }
  }
}

function validateMailArtifact(mail, errors) {
  const summary = objectValue(mail.mailEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "mail.mailEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "mail.mailEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const container = objectValue(body);
  const rawAudit = Object.hasOwn(container, "mailAudit")
    ? container.mailAudit
    : (container.mailEvidence ??
      container.mail ??
      container.audit ??
      container);
  const audit = objectValue(rawAudit);
  if (audit !== rawAudit) {
    errors.push(
      error(
        "artifact_missing_block",
        "mail.mailEvidence.source must contain mail smoke audit evidence",
      ),
    );
    return;
  }

  const checkedAt = normalizeIso(audit.checkedAt ?? audit.computedAt);
  const evidence = objectValue(audit.evidence);
  const checks = arrayValue(audit.checks);

  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "mail smoke audit checkedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "mail.mailEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (audit.status !== "verified" || audit.productionReady !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mail smoke audit must be production-ready and verified",
      ),
    );
  }
  if (summary.status !== audit.status) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "mail.mailEvidence.status must match the source artifact",
      ),
    );
  }
  if (summary.productionReady !== audit.productionReady) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "mail.mailEvidence.productionReady must match the source artifact",
      ),
    );
  }

  for (const field of [
    "smtpConfigured",
    "inviteSmokePassed",
    "passwordResetSmokePassed",
    "notificationSmokePassed",
  ]) {
    if (mail[field] !== true || evidence[field] !== true) {
      errors.push(
        error(
          "artifact_evidence_not_true",
          `mail smoke audit evidence ${field} must be true`,
        ),
      );
    }
  }
  if (
    typeof summary.checkCount !== "number" ||
    summary.checkCount !== checks.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "mail.mailEvidence.checkCount must match the source artifact",
      ),
    );
  }
  if (checks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "mail smoke audit checks must be a non-empty array",
      ),
    );
  }
  if (checks.some((check) => check?.status !== "pass")) {
    errors.push(
      error("artifact_failed_check", "mail smoke audit checks must all pass"),
    );
  }
  for (const checkName of EXPECTED_MAIL_CHECKS) {
    if (
      !checks.some(
        (check) => check?.name === checkName && check.status === "pass",
      )
    ) {
      errors.push(
        error(
          "artifact_missing_check",
          `mail smoke audit must include passing ${checkName}`,
        ),
      );
    }
  }
}

function validateStorageArtifact(storage, errors) {
  const summary = objectValue(storage.storageEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "storage.storageEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "storage.storageEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const container = objectValue(body);
  const rawAudit = Object.hasOwn(container, "storageAudit")
    ? container.storageAudit
    : (container.storageEvidence ??
      container.storage ??
      container.audit ??
      container);
  const audit = objectValue(rawAudit);
  if (audit !== rawAudit) {
    errors.push(
      error(
        "artifact_missing_block",
        "storage.storageEvidence.source must contain storage retention audit evidence",
      ),
    );
    return;
  }

  const checkedAt = normalizeIso(audit.checkedAt ?? audit.computedAt);
  const evidence = objectValue(audit.evidence);
  const checks = arrayValue(audit.checks);

  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "storage retention audit checkedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "storage.storageEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (audit.status !== "verified" || audit.productionReady !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "storage retention audit must be production-ready and verified",
      ),
    );
  }
  if (summary.status !== audit.status) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "storage.storageEvidence.status must match the source artifact",
      ),
    );
  }
  if (summary.productionReady !== audit.productionReady) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "storage.storageEvidence.productionReady must match the source artifact",
      ),
    );
  }

  for (const field of [
    "sizingReviewed",
    "artifactRetentionConfigured",
    "packageRetentionConfigured",
    "lfsCapacityReviewed",
    "logRetentionConfigured",
  ]) {
    if (storage[field] !== true || evidence[field] !== true) {
      errors.push(
        error(
          "artifact_evidence_not_true",
          `storage retention audit evidence ${field} must be true`,
        ),
      );
    }
  }
  if (
    typeof summary.checkCount !== "number" ||
    summary.checkCount !== checks.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "storage.storageEvidence.checkCount must match the source artifact",
      ),
    );
  }
  if (checks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "storage retention audit checks must be a non-empty array",
      ),
    );
  }
  if (checks.some((check) => check?.status !== "pass")) {
    errors.push(
      error(
        "artifact_failed_check",
        "storage retention audit checks must all pass",
      ),
    );
  }
  for (const checkName of EXPECTED_STORAGE_CHECKS) {
    if (
      !checks.some(
        (check) => check?.name === checkName && check.status === "pass",
      )
    ) {
      errors.push(
        error(
          "artifact_missing_check",
          `storage retention audit must include passing ${checkName}`,
        ),
      );
    }
  }
}

function validateObservabilityArtifact(observability, errors) {
  const summary = objectValue(observability.observabilityEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "observability.observabilityEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "observability.observabilityEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const container = objectValue(body);
  const rawAudit = Object.hasOwn(container, "observabilityAudit")
    ? container.observabilityAudit
    : (container.observabilityEvidence ??
      container.observability ??
      container.audit ??
      container);
  const audit = objectValue(rawAudit);
  if (audit !== rawAudit) {
    errors.push(
      error(
        "artifact_missing_block",
        "observability.observabilityEvidence.source must contain observability audit evidence",
      ),
    );
    return;
  }

  const checkedAt = normalizeIso(audit.checkedAt ?? audit.computedAt);
  const evidence = objectValue(audit.evidence);
  const checks = arrayValue(audit.checks);

  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "observability audit checkedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "observability.observabilityEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (audit.status !== "verified" || audit.productionReady !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "observability audit must be production-ready and verified",
      ),
    );
  }
  if (summary.status !== audit.status) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "observability.observabilityEvidence.status must match the source artifact",
      ),
    );
  }
  if (summary.productionReady !== audit.productionReady) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "observability.observabilityEvidence.productionReady must match the source artifact",
      ),
    );
  }

  for (const field of [
    "prometheusScrapeOk",
    "alertRulesLoaded",
    "alertRoutingConfigured",
    "logsCollected",
    "noPageAlertsFiring",
  ]) {
    if (observability[field] !== true || evidence[field] !== true) {
      errors.push(
        error(
          "artifact_evidence_not_true",
          `observability audit evidence ${field} must be true`,
        ),
      );
    }
  }
  if (observability.logRetentionDays !== evidence.logRetentionDays) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "observability.logRetentionDays must match the source artifact",
      ),
    );
  }
  if (
    typeof evidence.logRetentionDays !== "number" ||
    evidence.logRetentionDays < 7
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "observability audit logRetentionDays must be at least 7",
      ),
    );
  }
  if (
    typeof summary.checkCount !== "number" ||
    summary.checkCount !== checks.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "observability.observabilityEvidence.checkCount must match the source artifact",
      ),
    );
  }
  if (checks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "observability audit checks must be a non-empty array",
      ),
    );
  }
  if (checks.some((check) => check?.status !== "pass")) {
    errors.push(
      error(
        "artifact_failed_check",
        "observability audit checks must all pass",
      ),
    );
  }
  for (const checkName of EXPECTED_OBSERVABILITY_CHECKS) {
    if (
      !checks.some(
        (check) => check?.name === checkName && check.status === "pass",
      )
    ) {
      errors.push(
        error(
          "artifact_missing_check",
          `observability audit must include passing ${checkName}`,
        ),
      );
    }
  }
}

function validateSsoArtifacts(sso, errors) {
  validateSsoSmokeArtifact(sso, errors);
  validateSsoBootstrapArtifact(sso, errors);
}

function validateSsoSmokeArtifact(sso, errors) {
  const summary = objectValue(sso.smokeEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "sso.smokeEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "sso.smokeEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const container = objectValue(body);
  const rawSmoke = Object.hasOwn(container, "ssoSmoke")
    ? container.ssoSmoke
    : (container.sso ?? container);
  const smoke = objectValue(rawSmoke);
  if (smoke !== rawSmoke) {
    errors.push(
      error(
        "artifact_missing_block",
        "sso.smokeEvidence.source must contain SSO smoke evidence",
      ),
    );
    return;
  }

  const checkedAt = normalizeIso(
    smoke.checkedAt ??
      smoke.completedAt ??
      smoke.smokeTestedAt ??
      container.checkedAt,
  );
  const smokeIssuer = stringValue(
    smoke.issuerUrl ?? smoke.issuer ?? smoke.elizaCloudIssuerUrl,
  );

  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "sso smoke checkedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "sso.smokeEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (smokeIssuer && sso.issuerUrl && smokeIssuer !== sso.issuerUrl) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "sso smoke issuerUrl must match sso.issuerUrl",
      ),
    );
  }
  if (
    !smokeFlag(smoke, [
      "smokeTested",
      "oidcLoginSucceeded",
      "loginSucceeded",
      "browserSignInPassed",
    ])
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "sso smoke must prove OIDC login succeeded",
      ),
    );
  }
  if (
    !smokeFlag(smoke, [
      "humanIdentitySmokePassed",
      "humanLoginSucceeded",
      "humanClaimsVerified",
      "humanAccountLinked",
    ])
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "sso smoke must prove human identity claims",
      ),
    );
  }
  if (
    !smokeFlag(smoke, [
      "agentIdentitySmokePassed",
      "agentTokenClaimsVerified",
      "agentClaimsVerified",
      "agentEndpointBindingPassed",
      "agentClaimMutationBound",
    ])
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "sso smoke must prove agent identity claims",
      ),
    );
  }
  if (
    !smokeFlag(smoke, [
      "serviceIdentitySmokePassed",
      "serviceTokenClaimsVerified",
      "serviceClaimsVerified",
      "serviceAccountSmokePassed",
    ])
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "sso smoke must prove service identity claims",
      ),
    );
  }
  if (!smokeFlag(smoke, ["publicRegistrationLocked", "registrationLocked"])) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "sso smoke must prove public registration is locked",
      ),
    );
  }
  if (
    !smokeFlag(smoke, [
      "autoCreateRestrictedToIssuer",
      "issuerRestricted",
      "nonIssuerRejected",
    ])
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "sso smoke must prove non-issuer registration is rejected",
      ),
    );
  }
  if (
    !smokeFlag(smoke, ["recoveryAdminVerified", "recoveryAdminLoginSucceeded"])
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "sso smoke must prove recovery admin access",
      ),
    );
  }
}

function validateSsoBootstrapArtifact(sso, errors) {
  const summary = objectValue(sso.bootstrapEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "sso.bootstrapEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "sso.bootstrapEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const receipt = objectValue(body);
  const checkedAt = normalizeIso(receipt.finishedAt ?? receipt.checkedAt);
  const checks = arrayValue(receipt.checks);

  if (
    receipt.schema !==
    "https://eliza.hub/schemas/identity-bootstrap-evidence.v1"
  ) {
    errors.push(
      error(
        "artifact_unexpected_schema",
        "identity bootstrap evidence must use identity-bootstrap-evidence.v1",
      ),
    );
  }
  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "identity bootstrap evidence finishedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "sso.bootstrapEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (receipt.status !== "passed" || summary.status !== "passed") {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "identity bootstrap evidence must be passed",
      ),
    );
  }
  if (receipt.summary?.failed !== 0) {
    errors.push(
      error(
        "artifact_failed_check",
        "identity bootstrap evidence must have zero failed checks",
      ),
    );
  }
  if (receipt.options?.applyBootstrap !== false) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "identity bootstrap evidence must be captured in read-only APPLY_BOOTSTRAP=false mode",
      ),
    );
  }
  if (
    receipt.oidc?.issuerUrl &&
    sso.issuerUrl &&
    receipt.oidc.issuerUrl !== sso.issuerUrl
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "identity bootstrap issuerUrl must match sso.issuerUrl",
      ),
    );
  }
  if (
    typeof summary.checkCount !== "number" ||
    summary.checkCount !== checks.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "sso.bootstrapEvidence.checkCount must match identity bootstrap checks",
      ),
    );
  }
  if (checks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "identity bootstrap evidence checks must be non-empty",
      ),
    );
  }
  if (checks.some((check) => check?.status !== "pass")) {
    errors.push(
      error(
        "artifact_failed_check",
        "identity bootstrap evidence checks must all pass",
      ),
    );
  }
  for (const checkName of EXPECTED_IDENTITY_BOOTSTRAP_CHECKS) {
    if (
      !checks.some(
        (check) => check?.name === checkName && check.status === "pass",
      )
    ) {
      errors.push(
        error(
          "artifact_missing_check",
          `identity bootstrap evidence must include passing ${checkName}`,
        ),
      );
    }
  }
}

function validateStewardArtifacts(steward, errors) {
  validatePreflightArtifact(steward, errors);
  validateDoctorArtifact(steward, errors);
}

function validatePreflightArtifact(steward, errors) {
  const summary = objectValue(steward.preflightEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "steward.preflightEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "steward.preflightEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const container = objectValue(body);
  const rawPreflight = Object.hasOwn(container, "preflight")
    ? container.preflight
    : container;
  const preflight = objectValue(rawPreflight);
  if (preflight !== rawPreflight) {
    errors.push(
      error(
        "artifact_missing_block",
        "steward.preflightEvidence.source must contain preflight evidence",
      ),
    );
    return;
  }

  const checkedAt = normalizeIso(preflight.checkedAt);
  const preflightErrors = arrayValue(preflight.errors);

  if (preflight.ok !== true) {
    errors.push(
      error("artifact_evidence_not_true", "steward preflight.ok must be true"),
    );
  }
  if (preflight.mode !== "production") {
    errors.push(
      error(
        "artifact_unexpected_value",
        "steward preflight.mode must be production",
      ),
    );
  }
  if (preflightErrors.length !== 0) {
    errors.push(
      error(
        "artifact_unexpected_value",
        "steward preflight.errors must be empty",
      ),
    );
  }
  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "steward preflight.checkedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "steward.preflightEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (summary.mode !== preflight.mode) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "steward.preflightEvidence.mode must match the source artifact",
      ),
    );
  }
  if (summary.errorCount !== preflightErrors.length) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "steward.preflightEvidence.errorCount must match the source artifact",
      ),
    );
  }
}

function validateDoctorArtifact(steward, errors) {
  const summary = objectValue(steward.doctorEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "steward.doctorEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "steward.doctorEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const container = objectValue(body);
  const rawDoctor = Object.hasOwn(container, "doctor")
    ? container.doctor
    : container;
  const doctor = objectValue(rawDoctor);
  if (doctor !== rawDoctor) {
    errors.push(
      error(
        "artifact_missing_block",
        "steward.doctorEvidence.source must contain doctor evidence",
      ),
    );
    return;
  }

  const checkedAt = normalizeIso(doctor.checkedAt);
  const checks = arrayValue(doctor.checks);

  if (doctor.ok !== true) {
    errors.push(
      error("artifact_evidence_not_true", "steward doctor.ok must be true"),
    );
  }
  if (checks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "steward doctor.checks must be a non-empty array",
      ),
    );
  }
  if (checks.some((check) => check?.ok !== true)) {
    errors.push(
      error("artifact_failed_check", "steward doctor.checks must all be ok"),
    );
  }
  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "steward doctor.checkedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "steward.doctorEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (summary.target !== doctor.target) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "steward.doctorEvidence.target must match the source artifact",
      ),
    );
  }
  if (summary.checkCount !== checks.length) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "steward.doctorEvidence.checkCount must match the source artifact",
      ),
    );
  }
}

function validateDryRunArtifact(rollout, errors) {
  const summary = objectValue(rollout.dryRunEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "mergeQueueRollout.dryRunEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "mergeQueueRollout.dryRunEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const drill = objectValue(body.mergeQueueRolloutDrill);
  if (drill !== body.mergeQueueRolloutDrill) {
    errors.push(
      error(
        "artifact_missing_block",
        "mergeQueueRollout.dryRunEvidence.source must contain mergeQueueRolloutDrill",
      ),
    );
    return;
  }

  const checks = arrayValue(drill.checks);
  const checkedAt = normalizeIso(drill.checkedAt);

  if (drill.dryRunPassed !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRolloutDrill.dryRunPassed must be true",
      ),
    );
  }
  if (drill.safeMode !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRolloutDrill.safeMode must be true",
      ),
    );
  }
  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "mergeQueueRolloutDrill.checkedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "mergeQueueRollout.dryRunEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (checks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "mergeQueueRolloutDrill.checks must be a non-empty array",
      ),
    );
  }
  if (
    typeof summary.checkCount !== "number" ||
    summary.checkCount !== checks.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "mergeQueueRollout.dryRunEvidence.checkCount must match the source artifact",
      ),
    );
  }
  if (checks.some((check) => check?.ok !== true)) {
    errors.push(
      error(
        "artifact_failed_check",
        "mergeQueueRolloutDrill.checks must all be ok",
      ),
    );
  }
}

function validateLiveDrillArtifact(rollout, errors) {
  const summary = objectValue(rollout.liveDrillEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "mergeQueueRollout.liveDrillEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "mergeQueueRollout.liveDrillEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const live = objectValue(body.mergeQueueRolloutLiveDrill);
  if (live !== body.mergeQueueRolloutLiveDrill) {
    errors.push(
      error(
        "artifact_missing_block",
        "mergeQueueRollout.liveDrillEvidence.source must contain mergeQueueRolloutLiveDrill",
      ),
    );
    return;
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
  const artifactRunId =
    live.runId ??
    runs.find((run) => typeof run?.id === "string" && run.id !== "")?.id ??
    null;
  const stagedLiveDrillPassed =
    live.stagedLiveDrillPassed === true &&
    runs.some((run) => run?.status === "succeeded") &&
    items.some((item) => item?.queueState === "merged") &&
    executions.length > 0 &&
    executions.every((entry) => entry?.status === "executed") &&
    events.some((event) => event?.type === "IntegrationActionStarted") &&
    events.some((event) => event?.type === "IntegrationActionFinished");

  if (stagedLiveDrillPassed !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRolloutLiveDrill must prove a succeeded run, merged item, executed actions, and action events",
      ),
    );
  }
  if (live.workerLeaseVerified !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRolloutLiveDrill.workerLeaseVerified must be true",
      ),
    );
  }
  if (rollout.strictWorkReservationsEnforced !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRollout.strictWorkReservationsEnforced must be true",
      ),
    );
  }
  if (rollout.strictWorkItemsEnforced !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRollout.strictWorkItemsEnforced must be true",
      ),
    );
  }
  if (rollout.strictAgentBranchNamespacesEnforced !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRollout.strictAgentBranchNamespacesEnforced must be true",
      ),
    );
  }
  if (rollout.verifiedAgentRunReceiptsEnforced !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRollout.verifiedAgentRunReceiptsEnforced must be true",
      ),
    );
  }
  if (rollout.agentIdentityRegistryEnforced !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRollout.agentIdentityRegistryEnforced must be true",
      ),
    );
  }
  if (rollout.stackDependencyOrderEnforced !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRollout.stackDependencyOrderEnforced must be true",
      ),
    );
  }
  if (
    live.strictWorkReservationsEnforced !== true ||
    readinessConfig.requireWorkReservationForAgentPrs !== true
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRolloutLiveDrill must prove strict work reservations were enabled in /ready",
      ),
    );
  }
  if (
    live.strictWorkItemsEnforced !== true ||
    readinessConfig.requireWorkItemForAgentPrs !== true
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRolloutLiveDrill must prove strict Work items were enabled in /ready",
      ),
    );
  }
  if (
    live.strictAgentBranchNamespacesEnforced !== true ||
    readinessConfig.requireAgentBranchNamespaceForAgentPrs !== true
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRolloutLiveDrill must prove strict agent branch namespaces were enabled in /ready",
      ),
    );
  }
  if (
    live.verifiedAgentRunReceiptsEnforced !== true ||
    readinessConfig.requireVerifiedAgentRunReceiptForAgentPrs !== true
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRolloutLiveDrill must prove verified agent run receipts were enabled in /ready",
      ),
    );
  }
  if (
    live.agentIdentityRegistryEnforced !== true ||
    readinessConfig.requireAgentIdentityRegistryForAgentPrs !== true ||
    Number(readinessConfig.knownAgentIdCount ?? 0) < 1
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRolloutLiveDrill must prove the allowed-agent identity registry was enabled in /ready",
      ),
    );
  }
  if (
    live.stackDependencyOrderEnforced !== true ||
    !validStackDependencyOrderProof(live.stackDependencyOrderProof)
  ) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRolloutLiveDrill must prove stack dependency ordering with a release-readiness blocked-child snapshot",
      ),
    );
  }
  if (live.rollbackDrillPassed !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRolloutLiveDrill.rollbackDrillPassed must be true",
      ),
    );
  }
  if (live.humanApprovalRecorded !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "mergeQueueRolloutLiveDrill.humanApprovalRecorded must be true",
      ),
    );
  }
  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "mergeQueueRolloutLiveDrill.checkedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "mergeQueueRollout.liveDrillEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (!artifactRunId) {
    errors.push(
      error(
        "artifact_missing_run",
        "mergeQueueRolloutLiveDrill must include a run id",
      ),
    );
  } else if (summary.runId !== artifactRunId) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "mergeQueueRollout.liveDrillEvidence.runId must match the source artifact",
      ),
    );
  }
}

function validStackDependencyOrderProof(proofValue) {
  const proof = objectValue(proofValue);
  return (
    proof.valid === true &&
    proof.stackCheckStatus === "fail" &&
    Number(proof.stackBlocked ?? 0) > 0 &&
    arrayValue(proof.blockedItemIds).length > 0 &&
    arrayValue(proof.nextMergeItemIds).length > 0 &&
    arrayValue(proof.requiredActions).includes("merge_stack_parents_first")
  );
}

function validateSecurityReviewArtifact(securityReview, errors) {
  const summary = objectValue(securityReview.securityEvidence);
  const artifact = readJsonArtifact(
    summary.source,
    "securityReview.securityEvidence.source",
    errors,
  );
  if (!artifact) return;
  const { body } = artifact;

  requireArtifactSha(
    errors,
    "securityReview.securityEvidence.sha256",
    summary.sha256,
    artifact.sha256,
  );
  const container = objectValue(body);
  const rawAudit = Object.hasOwn(container, "securityReviewAudit")
    ? container.securityReviewAudit
    : (container.securityEvidence ??
      container.securityReview ??
      container.audit ??
      container);
  const audit = objectValue(rawAudit);
  if (audit !== rawAudit) {
    errors.push(
      error(
        "artifact_missing_block",
        "securityReview.securityEvidence.source must contain security review audit evidence",
      ),
    );
    return;
  }

  const checkedAt = normalizeIso(audit.checkedAt ?? audit.approvedAt);
  const approvedAt = normalizeIso(audit.approvedAt);
  const evidence = objectValue(audit.evidence);
  const checks = arrayValue(audit.checks);
  const reviewedSurfaces = stringArray(audit.reviewedSurfaces);

  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "security review audit checkedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(summary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "securityReview.securityEvidence.checkedAt must match the source artifact",
      ),
    );
  }
  if (!approvedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "security review audit approvedAt must be a valid timestamp",
      ),
    );
  } else if (
    normalizeIso(summary.approvedAt) !== approvedAt ||
    normalizeIso(securityReview.approvedAt) !== approvedAt
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "securityReview.approvedAt and securityEvidence.approvedAt must match the source artifact",
      ),
    );
  }
  if (audit.status !== "approved" || audit.productionReady !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "security review audit must be approved and production-ready",
      ),
    );
  }
  if (summary.status !== audit.status) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "securityReview.securityEvidence.status must match the source artifact",
      ),
    );
  }
  if (summary.productionReady !== audit.productionReady) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "securityReview.securityEvidence.productionReady must match the source artifact",
      ),
    );
  }
  if (
    summary.approvedBy !== audit.approvedBy ||
    securityReview.approvedBy !== audit.approvedBy
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "securityReview approvedBy values must match the source artifact",
      ),
    );
  }

  for (const field of [
    "authReviewed",
    "tokensReviewed",
    "runnerExecutionReviewed",
    "repoPermissionsReviewed",
  ]) {
    if (securityReview[field] !== true || evidence[field] !== true) {
      errors.push(
        error(
          "artifact_evidence_not_true",
          `security review audit evidence ${field} must be true`,
        ),
      );
    }
  }
  if (
    typeof summary.reviewedSurfaceCount !== "number" ||
    summary.reviewedSurfaceCount !== reviewedSurfaces.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "securityReview.securityEvidence.reviewedSurfaceCount must match the source artifact",
      ),
    );
  }
  if (!sameStringArray(reviewedSurfaces, EXPECTED_SECURITY_REVIEW_SURFACES)) {
    errors.push(
      error(
        "artifact_missing_checks",
        "security review audit must include every expected reviewed surface",
      ),
    );
  }
  if (
    typeof summary.checkCount !== "number" ||
    summary.checkCount !== checks.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "securityReview.securityEvidence.checkCount must match the source artifact",
      ),
    );
  }
  if (checks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "security review audit checks must be a non-empty array",
      ),
    );
  }
  if (checks.some((check) => check?.status !== "pass")) {
    errors.push(
      error(
        "artifact_failed_check",
        "security review audit checks must all pass",
      ),
    );
  }
  for (const checkName of EXPECTED_SECURITY_REVIEW_CHECKS) {
    if (
      !checks.some(
        (check) => check?.name === checkName && check.status === "pass",
      )
    ) {
      errors.push(
        error(
          "artifact_missing_check",
          `security review audit must include passing ${checkName}`,
        ),
      );
    }
  }
}

function validateDeploymentArtifacts(deployment, errors) {
  const deploySummary = objectValue(deployment.deployEvidence);
  const postDeploySummary = objectValue(deployment.postDeployEvidence);
  const deployArtifact = readJsonArtifact(
    deploySummary.source,
    "deployment.deployEvidence.source",
    errors,
  );
  const postDeployArtifact = readJsonArtifact(
    postDeploySummary.source,
    "deployment.postDeployEvidence.source",
    errors,
  );

  if (deployArtifact) {
    requireArtifactSha(
      errors,
      "deployment.deployEvidence.sha256",
      deploySummary.sha256,
      deployArtifact.sha256,
    );
    validateDeployEvidenceSummary({
      deployment,
      deploySummary,
      postDeploySummary,
      artifact: deployArtifact,
      errors,
    });
  }

  if (postDeployArtifact) {
    requireArtifactSha(
      errors,
      "deployment.postDeployEvidence.sha256",
      postDeploySummary.sha256,
      postDeployArtifact.sha256,
    );
    validatePostDeployEvidenceSummary({
      deployment,
      postDeploySummary,
      artifact: postDeployArtifact,
      errors,
    });
  }

  if (deployArtifact && postDeployArtifact) {
    const deployBody = objectValue(deployArtifact.body);
    const deployPostDeploySource = resolveArtifactReference(
      deployBody.files?.postDeployEvidence,
      deploySummary.source,
    );
    if (deployPostDeploySource !== postDeploySummary.source) {
      errors.push(
        error(
          "artifact_summary_mismatch",
          "deployment.deployEvidence post-deploy source must match deployment.postDeployEvidence.source",
        ),
      );
    }
    if (deploySummary.postDeployEvidenceSource !== postDeploySummary.source) {
      errors.push(
        error(
          "artifact_summary_mismatch",
          "deployment.deployEvidence.postDeployEvidenceSource must match deployment.postDeployEvidence.source",
        ),
      );
    }
    if (deploySummary.postDeployEvidenceSha256 !== postDeploySummary.sha256) {
      errors.push(
        error(
          "artifact_summary_mismatch",
          "deployment.deployEvidence.postDeployEvidenceSha256 must match deployment.postDeployEvidence.sha256",
        ),
      );
    }
    requireArtifactSha(
      errors,
      "deployment.deployEvidence.postDeployEvidenceSha256",
      deploySummary.postDeployEvidenceSha256,
      postDeployArtifact.sha256,
    );
  }
}

function validateDeployEvidenceSummary({
  deployment,
  deploySummary,
  postDeploySummary,
  artifact,
  errors,
}) {
  const deploy = objectValue(artifact.body);
  const checkedAt = normalizeIso(deploy.finishedAt);
  const steps = arrayValue(deploy.steps);

  if (deploy.schema !== "https://eliza.hub/schemas/deploy-evidence.v1") {
    errors.push(
      error(
        "artifact_unexpected_schema",
        "deployment deploy evidence must use deploy-evidence.v1",
      ),
    );
  }
  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "deployment deploy evidence finishedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(deploySummary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "deployment.deployEvidence.checkedAt must match deploy evidence finishedAt",
      ),
    );
  }
  if (deploy.status !== "passed" || deploySummary.status !== "passed") {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "deployment deploy evidence must be passed",
      ),
    );
  }
  if (
    !["first-boot", "rolling"].includes(deploy.mode) ||
    deployment.mode !== deploy.mode ||
    deploySummary.mode !== deploy.mode
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "deployment mode values must match the deploy evidence",
      ),
    );
  }
  if (deploy.dryRun !== false || deploySummary.dryRun !== false) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "deployment deploy evidence must come from an applied deploy, not a dry run",
      ),
    );
  }
  if (deploy.options?.postDeployCheck !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "deployment deploy evidence must include post-deploy checks",
      ),
    );
  }
  if (deployment.applied !== true) {
    errors.push(
      error("artifact_evidence_not_true", "deployment.applied must be true"),
    );
  }
  if (steps.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "deployment deploy evidence steps must be non-empty",
      ),
    );
  }
  if (
    typeof deploySummary.stepCount !== "number" ||
    deploySummary.stepCount !== steps.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "deployment.deployEvidence.stepCount must match deploy evidence steps",
      ),
    );
  }
  if (!steps.some((step) => step?.name === "run post deploy checks")) {
    errors.push(
      error(
        "artifact_missing_check",
        "deployment deploy evidence must include the post-deploy check step",
      ),
    );
  }
  const deployPostDeploySource = resolveArtifactReference(
    deploy.files?.postDeployEvidence,
    deploySummary.source,
  );
  if (!deployPostDeploySource) {
    errors.push(
      error(
        "artifact_missing_block",
        "deployment deploy evidence must record files.postDeployEvidence",
      ),
    );
  } else if (
    deploySummary.postDeployEvidenceSource !== deployPostDeploySource ||
    postDeploySummary.source !== deployPostDeploySource
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "deployment post-deploy evidence source paths must match deploy evidence",
      ),
    );
  }
}

function validatePostDeployEvidenceSummary({
  deployment,
  postDeploySummary,
  artifact,
  errors,
}) {
  const postDeploy = objectValue(artifact.body);
  const checkedAt = normalizeIso(postDeploy.finishedAt);
  const summary = objectValue(postDeploy.summary);
  const targets = objectValue(postDeploy.targets);
  const checks = arrayValue(postDeploy.checks);

  if (
    postDeploy.schema !== "https://eliza.hub/schemas/post-deploy-evidence.v1"
  ) {
    errors.push(
      error(
        "artifact_unexpected_schema",
        "deployment post-deploy evidence must use post-deploy-evidence.v1",
      ),
    );
  }
  if (!checkedAt) {
    errors.push(
      error(
        "artifact_invalid_timestamp",
        "deployment post-deploy evidence finishedAt must be a valid timestamp",
      ),
    );
  } else if (normalizeIso(postDeploySummary.checkedAt) !== checkedAt) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "deployment.postDeployEvidence.checkedAt must match post-deploy evidence finishedAt",
      ),
    );
  }
  if (postDeploy.status !== "passed" || postDeploySummary.status !== "passed") {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "deployment post-deploy evidence must be passed",
      ),
    );
  }
  if (deployment.postDeployVerified !== true) {
    errors.push(
      error(
        "artifact_evidence_not_true",
        "deployment.postDeployVerified must be true",
      ),
    );
  }
  if (summary.failed !== 0 || postDeploySummary.failedCount !== 0) {
    errors.push(
      error(
        "artifact_failed_check",
        "deployment post-deploy evidence must have zero failed checks",
      ),
    );
  }
  if (
    typeof summary.total !== "number" ||
    summary.total !== checks.length ||
    postDeploySummary.checkCount !== checks.length
  ) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "deployment.postDeployEvidence.checkCount must match post-deploy checks",
      ),
    );
  }
  if (checks.length === 0) {
    errors.push(
      error(
        "artifact_missing_checks",
        "deployment post-deploy evidence checks must be non-empty",
      ),
    );
  }
  if (checks.some((check) => check?.status !== "pass")) {
    errors.push(
      error(
        "artifact_failed_check",
        "deployment post-deploy evidence checks must all pass",
      ),
    );
  }
  for (const [pattern, label] of EXPECTED_POST_DEPLOY_CHECK_PATTERNS) {
    if (
      !checks.some(
        (check) =>
          typeof check?.name === "string" &&
          pattern.test(check.name) &&
          check.status === "pass",
      )
    ) {
      errors.push(
        error(
          "artifact_missing_check",
          `deployment post-deploy evidence must include passing ${label}`,
        ),
      );
    }
  }
  if (postDeploySummary.forgejoLocalUrl !== targets.forgejoLocalUrl) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "deployment.postDeployEvidence.forgejoLocalUrl must match the source artifact",
      ),
    );
  }
  if (postDeploySummary.stewardLocalUrl !== targets.stewardLocalUrl) {
    errors.push(
      error(
        "artifact_summary_mismatch",
        "deployment.postDeployEvidence.stewardLocalUrl must match the source artifact",
      ),
    );
  }
}

function readJsonArtifact(source, evidencePath, errors) {
  if (typeof source !== "string" || source.trim() === "") {
    errors.push(
      error(
        "artifact_source_missing",
        `${evidencePath} must be a local JSON file`,
      ),
    );
    return null;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(source)) {
    errors.push(
      error(
        "artifact_source_not_local",
        `${evidencePath} must be a local JSON file, not a URL`,
      ),
    );
    return null;
  }

  if (!existsSync(source)) {
    errors.push(
      error(
        "artifact_source_unreadable",
        `${evidencePath} must point to an existing JSON file`,
      ),
    );
    return null;
  }

  try {
    const raw = readFileSync(source);
    return {
      body: JSON.parse(raw.toString("utf8")),
      sha256: createHash("sha256").update(raw).digest("hex"),
    };
  } catch {
    // error-policy:J3 unreadable or invalid artifact becomes a typed validation
    // error in the report
    errors.push(
      error(
        "artifact_source_invalid_json",
        `${evidencePath} must contain valid JSON`,
      ),
    );
    return null;
  }
}

function readTextArtifact(source, evidencePath, errors) {
  if (typeof source !== "string" || source.trim() === "") {
    errors.push(
      error(
        "artifact_source_missing",
        `${evidencePath} must be a local text file`,
      ),
    );
    return null;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(source)) {
    errors.push(
      error(
        "artifact_source_not_local",
        `${evidencePath} must be a local text file, not a URL`,
      ),
    );
    return null;
  }

  if (!existsSync(source)) {
    errors.push(
      error(
        "artifact_source_unreadable",
        `${evidencePath} must point to an existing text file`,
      ),
    );
    return null;
  }

  try {
    const raw = readFileSync(source);
    return {
      body: raw.toString("utf8"),
      sha256: createHash("sha256").update(raw).digest("hex"),
    };
  } catch {
    // error-policy:J3 unreadable artifact becomes a typed validation error in
    // the report
    errors.push(
      error("artifact_source_unreadable", `${evidencePath} must be readable`),
    );
    return null;
  }
}

function resolveArtifactReference(reference, baseSource) {
  if (typeof reference !== "string" || reference.trim() === "") {
    return null;
  }
  if (reference.startsWith("/")) {
    return reference;
  }
  if (typeof baseSource !== "string" || baseSource.trim() === "") {
    return reference;
  }
  return path.resolve(path.dirname(baseSource), reference);
}

function requireArtifactSha(errors, path, expected, actual) {
  if (expected !== actual) {
    errors.push(
      error("artifact_hash_mismatch", `${path} must match the source artifact`),
    );
  }
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

function stringArray(value) {
  return arrayValue(value)
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function stringValue(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function normalizeId(value) {
  if (value === undefined || value === null || value === "") return null;
  return String(value);
}

function sameStringArray(left, right) {
  const normalizedLeft = [...new Set(stringArray(left))].sort();
  const normalizedRight = [...new Set(stringArray(right))].sort();
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((value, index) => value === normalizedRight[index])
  );
}

function smokeFlag(smoke, keys) {
  return keys.some((key) => smoke?.[key] === true);
}

function migrationOutputPassed(output) {
  if (typeof output !== "string" || output.trim() === "") {
    return false;
  }

  return (
    /\[MergeStewardMigrate\] complete/u.test(output) &&
    !/checksum mismatch|failed/i.test(output)
  );
}

function restoreDrillPassed(output) {
  if (typeof output !== "string" || !/restore drill passed/u.test(output)) {
    return false;
  }

  return sameStringArray(
    restoreDrillVerifiedTables(output),
    EXPECTED_RESTORE_TABLES,
  );
}

function restoreDrillVerifiedTables(output) {
  const verifiedLine = /^verified_tables=(.+)$/mu.exec(output);
  if (!verifiedLine) {
    return [];
  }

  return verifiedLine[1]
    .split(",")
    .map((table) => table.trim())
    .filter(Boolean);
}

function error(code, message) {
  return { code, message };
}
