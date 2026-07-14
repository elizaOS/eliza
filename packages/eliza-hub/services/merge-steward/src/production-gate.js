import { validateProductionEvidenceShape } from "./production-evidence-schema.js";

export const PRODUCTION_GATE_CHECKS = Object.freeze([
  "domain_tls",
  "sso_registration",
  "backup_restore",
  "database_migration",
  "image_provenance",
  "runner_isolation",
  "repository_protection",
  "github_migration_rehearsal",
  "secret_management",
  "mail_notifications",
  "storage_retention",
  "observability",
  "steward_runtime",
  "merge_queue_rollout",
  "security_review",
  "deployment_verification",
]);

const BACKUP_COMPONENTS = Object.freeze([
  "repositories",
  "database",
  "attachments",
  "packages",
  "lfs",
  "configuration",
]);

const EXPECTED_RESTORE_TABLES = Object.freeze([
  "steward_schema_migrations",
  "steward_queue_items",
  "steward_runs",
  "steward_events",
  "steward_agent_claims",
  "steward_worker_leases",
]);

export function runProductionGate({ evidence = {}, now = new Date() } = {}) {
  const evidenceShape = validateProductionEvidenceShape(evidence);
  const checks = [
    checkDomainTls(evidence),
    checkSsoRegistration(evidence),
    checkBackupRestore(evidence),
    checkDatabaseMigration(evidence),
    checkImageProvenance(evidence),
    checkRunnerIsolation(evidence),
    checkRepositoryProtection(evidence),
    checkGithubMigrationRehearsal(evidence),
    checkSecretManagement(evidence),
    checkMailNotifications(evidence),
    checkStorageRetention(evidence),
    checkObservability(evidence),
    checkStewardRuntime(evidence),
    checkMergeQueueRollout(evidence),
    checkSecurityReview(evidence),
    checkDeploymentVerification(evidence),
  ];

  const failed = checks.filter((check) => !check.ok).length;

  return {
    ok: evidenceShape.ok && failed === 0,
    checkedAt: toIso(now),
    evidenceShape,
    summary: {
      total: checks.length,
      passed: checks.length - failed,
      failed,
      shapeErrors: evidenceShape.errors.length,
    },
    checks,
  };
}

function checkDomainTls(evidence) {
  const domain = evidence.domain ?? {};
  const probeEvidence = domain.probeEvidence ?? {};
  const errors = [];

  requireHttpsUrl(errors, "domain.forgejoRootUrl", domain.forgejoRootUrl, {
    trailingSlash: true,
  });
  requirePresent(errors, "domain.forgejoDomain", domain.forgejoDomain);
  requireObject(errors, "domain.probeEvidence", domain.probeEvidence);
  requirePresent(errors, "domain.probeEvidence.source", probeEvidence.source);
  requireSha256(errors, "domain.probeEvidence.sha256", probeEvidence.sha256);
  requireIsoDate(
    errors,
    "domain.probeEvidence.checkedAt",
    probeEvidence.checkedAt,
  );
  requireEqual(
    errors,
    "domain.probeEvidence.status",
    probeEvidence.status,
    "ready",
  );
  requireMinimumNumber(
    errors,
    "domain.probeEvidence.checkCount",
    probeEvidence.checkCount,
    1,
  );
  requireTrue(errors, "domain.tlsVerified", domain.tlsVerified);
  requireTrue(errors, "domain.rootUrlCanonical", domain.rootUrlCanonical);
  requireTrue(
    errors,
    "domain.reverseProxyReviewed",
    domain.reverseProxyReviewed,
  );

  if (domain.forgejoRootUrl && domain.forgejoDomain) {
    const host = hostFromHttpsUrl(domain.forgejoRootUrl);
    if (host && host !== domain.forgejoDomain) {
      errors.push(
        error(
          "domain_root_host_mismatch",
          "domain.forgejoRootUrl host must match domain.forgejoDomain",
        ),
      );
    }
  }

  return result("domain_tls", errors, [
    "domain.forgejoRootUrl",
    "domain.forgejoDomain",
    "domain.probeEvidence",
    "domain.probeEvidence.source",
    "domain.probeEvidence.sha256",
    "domain.probeEvidence.checkedAt",
    "domain.probeEvidence.status",
    "domain.probeEvidence.checkCount",
    "domain.tlsVerified",
    "domain.rootUrlCanonical",
    "domain.reverseProxyReviewed",
  ]);
}

function checkSsoRegistration(evidence) {
  const sso = evidence.sso ?? {};
  const smokeEvidence = sso.smokeEvidence ?? {};
  const bootstrapEvidence = sso.bootstrapEvidence ?? {};
  const errors = [];

  requireHttpsUrl(errors, "sso.issuerUrl", sso.issuerUrl);
  requireObject(errors, "sso.smokeEvidence", sso.smokeEvidence);
  requirePresent(errors, "sso.smokeEvidence.source", smokeEvidence.source);
  requireSha256(errors, "sso.smokeEvidence.sha256", smokeEvidence.sha256);
  requireIsoDate(
    errors,
    "sso.smokeEvidence.checkedAt",
    smokeEvidence.checkedAt,
  );
  requireObject(errors, "sso.bootstrapEvidence", sso.bootstrapEvidence);
  requirePresent(
    errors,
    "sso.bootstrapEvidence.source",
    bootstrapEvidence.source,
  );
  requireSha256(
    errors,
    "sso.bootstrapEvidence.sha256",
    bootstrapEvidence.sha256,
  );
  requireIsoDate(
    errors,
    "sso.bootstrapEvidence.checkedAt",
    bootstrapEvidence.checkedAt,
  );
  requireEqual(
    errors,
    "sso.bootstrapEvidence.status",
    bootstrapEvidence.status,
    "passed",
  );
  requireMinimumNumber(
    errors,
    "sso.bootstrapEvidence.checkCount",
    bootstrapEvidence.checkCount,
    8,
  );
  requireTrue(errors, "sso.oidcProviderStaged", sso.oidcProviderStaged);
  requireTrue(
    errors,
    "sso.forgejoOidcSourceConfigured",
    sso.forgejoOidcSourceConfigured,
  );
  requireTrue(errors, "sso.smokeTested", sso.smokeTested);
  requireTrue(
    errors,
    "sso.humanIdentitySmokePassed",
    sso.humanIdentitySmokePassed,
  );
  requireTrue(
    errors,
    "sso.agentIdentitySmokePassed",
    sso.agentIdentitySmokePassed,
  );
  requireTrue(
    errors,
    "sso.serviceIdentitySmokePassed",
    sso.serviceIdentitySmokePassed,
  );
  requireTrue(
    errors,
    "sso.publicRegistrationLocked",
    sso.publicRegistrationLocked,
  );
  requireTrue(
    errors,
    "sso.autoCreateRestrictedToIssuer",
    sso.autoCreateRestrictedToIssuer,
  );
  requireTrue(errors, "sso.recoveryAdminVerified", sso.recoveryAdminVerified);

  return result("sso_registration", errors, [
    "sso.issuerUrl",
    "sso.smokeEvidence",
    "sso.smokeEvidence.source",
    "sso.smokeEvidence.sha256",
    "sso.smokeEvidence.checkedAt",
    "sso.bootstrapEvidence",
    "sso.bootstrapEvidence.source",
    "sso.bootstrapEvidence.sha256",
    "sso.bootstrapEvidence.checkedAt",
    "sso.bootstrapEvidence.status",
    "sso.bootstrapEvidence.checkCount",
    "sso.oidcProviderStaged",
    "sso.forgejoOidcSourceConfigured",
    "sso.smokeTested",
    "sso.humanIdentitySmokePassed",
    "sso.agentIdentitySmokePassed",
    "sso.serviceIdentitySmokePassed",
    "sso.publicRegistrationLocked",
    "sso.autoCreateRestrictedToIssuer",
    "sso.recoveryAdminVerified",
  ]);
}

function checkBackupRestore(evidence) {
  const backups = evidence.backups ?? {};
  const backupEvidence = backups.backupEvidence ?? {};
  const offsiteUpload = backupEvidence.offsiteUploadReceipt ?? {};
  const offsiteRestore = backupEvidence.offsiteRestoreReceipt ?? {};
  const errors = [];

  requireTrue(errors, "backups.scheduled", backups.scheduled);
  requireTrue(errors, "backups.offHost", backups.offHost);
  requireTrue(errors, "backups.encrypted", backups.encrypted);
  requireObject(errors, "backups.backupEvidence", backups.backupEvidence);
  requirePresent(
    errors,
    "backups.backupEvidence.source",
    backupEvidence.source,
  );
  requireSha256(errors, "backups.backupEvidence.sha256", backupEvidence.sha256);
  requireIsoDate(
    errors,
    "backups.backupEvidence.checkedAt",
    backupEvidence.checkedAt,
  );
  requireEqual(
    errors,
    "backups.backupEvidence.status",
    backupEvidence.status,
    "verified",
  );
  requireTrue(
    errors,
    "backups.backupEvidence.productionReady",
    backupEvidence.productionReady,
  );
  requireIsoDate(
    errors,
    "backups.backupEvidence.backupCreatedAt",
    backupEvidence.backupCreatedAt,
  );
  requireIsoDate(
    errors,
    "backups.backupEvidence.restoreCheckedAt",
    backupEvidence.restoreCheckedAt,
  );
  requireMinimumNumber(
    errors,
    "backups.backupEvidence.componentCount",
    backupEvidence.componentCount,
    BACKUP_COMPONENTS.length,
  );
  requireMinimumNumber(
    errors,
    "backups.backupEvidence.checkCount",
    backupEvidence.checkCount,
    1,
  );
  requireObject(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt",
    backupEvidence.offsiteUploadReceipt,
  );
  requirePresent(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.source",
    offsiteUpload.source,
  );
  requireSha256(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.sha256",
    offsiteUpload.sha256,
  );
  requireIsoDate(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.checkedAt",
    offsiteUpload.checkedAt,
  );
  requireEqual(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.status",
    offsiteUpload.status,
    "verified",
  );
  requireTrue(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.verified",
    offsiteUpload.verified,
  );
  requirePresent(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.backupName",
    offsiteUpload.backupName,
  );
  requireIsoDate(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.backupCreatedAt",
    offsiteUpload.backupCreatedAt,
  );
  requirePresent(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.remoteArchive",
    offsiteUpload.remoteArchive,
  );
  requirePresent(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.remoteReceipt",
    offsiteUpload.remoteReceipt,
  );
  requireRclonePath(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.remoteArchive",
    offsiteUpload.remoteArchive,
  );
  requireRclonePath(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.remoteReceipt",
    offsiteUpload.remoteReceipt,
  );
  requireSha256(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.ciphertextSha256",
    offsiteUpload.ciphertextSha256,
  );
  requireMinimumNumber(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.ciphertextBytes",
    offsiteUpload.ciphertextBytes,
    1,
  );
  requireEqual(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.encryptionFormat",
    offsiteUpload.encryptionFormat,
    "age",
  );
  requireSha256(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.recipientsFileSha256",
    offsiteUpload.recipientsFileSha256,
  );
  requireEqual(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.verificationMethod",
    offsiteUpload.verificationMethod,
    "download_sha256",
  );
  requireObject(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt",
    backupEvidence.offsiteRestoreReceipt,
  );
  requirePresent(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.source",
    offsiteRestore.source,
  );
  requireSha256(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.sha256",
    offsiteRestore.sha256,
  );
  requireIsoDate(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.checkedAt",
    offsiteRestore.checkedAt,
  );
  requireEqual(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.status",
    offsiteRestore.status,
    "verified",
  );
  requireTrue(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.verified",
    offsiteRestore.verified,
  );
  requirePresent(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.remoteArchive",
    offsiteRestore.remoteArchive,
  );
  requirePresent(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.remoteReceipt",
    offsiteRestore.remoteReceipt,
  );
  requireSha256(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.uploadReceiptSha256",
    offsiteRestore.uploadReceiptSha256,
  );
  requireSha256(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.ciphertextSha256",
    offsiteRestore.ciphertextSha256,
  );
  requireMinimumNumber(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.ciphertextBytes",
    offsiteRestore.ciphertextBytes,
    1,
  );
  requireTrue(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.downloadVerified",
    offsiteRestore.downloadVerified,
  );
  requireTrue(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.decryptionVerified",
    offsiteRestore.decryptionVerified,
  );
  requireTrue(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.archivePathsVerified",
    offsiteRestore.archivePathsVerified,
  );
  requireTrue(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.structuralRestoreCheckPassed",
    offsiteRestore.structuralRestoreCheckPassed,
  );
  requireEqual(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.remoteArchive",
    offsiteRestore.remoteArchive,
    offsiteUpload.remoteArchive,
  );
  requireEqual(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.remoteReceipt",
    offsiteRestore.remoteReceipt,
    offsiteUpload.remoteReceipt,
  );
  requireEqual(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.uploadReceiptSha256",
    offsiteRestore.uploadReceiptSha256,
    offsiteUpload.sha256,
  );
  requireEqual(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.ciphertextSha256",
    offsiteRestore.ciphertextSha256,
    offsiteUpload.ciphertextSha256,
  );
  requireEqual(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.ciphertextBytes",
    offsiteRestore.ciphertextBytes,
    offsiteUpload.ciphertextBytes,
  );
  requireEqual(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.backupCreatedAt",
    offsiteUpload.backupCreatedAt,
    backupEvidence.backupCreatedAt,
  );
  requireEqual(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.checkedAt",
    offsiteRestore.checkedAt,
    backupEvidence.restoreCheckedAt,
  );
  requireIsoDate(errors, "backups.lastBackupAt", backups.lastBackupAt);
  requireIsoDate(
    errors,
    "backups.lastRestoreCheckAt",
    backups.lastRestoreCheckAt,
  );
  requireEqual(
    errors,
    "backups.lastBackupAt",
    backups.lastBackupAt,
    backupEvidence.backupCreatedAt,
  );
  requireEqual(
    errors,
    "backups.lastRestoreCheckAt",
    backups.lastRestoreCheckAt,
    backupEvidence.restoreCheckedAt,
  );
  requireTimestampAtOrAfter(
    errors,
    "backups.backupEvidence.offsiteUploadReceipt.checkedAt",
    offsiteUpload.checkedAt,
    "backups.backupEvidence.offsiteUploadReceipt.backupCreatedAt",
    offsiteUpload.backupCreatedAt,
  );
  requireTimestampAtOrAfter(
    errors,
    "backups.backupEvidence.offsiteRestoreReceipt.checkedAt",
    offsiteRestore.checkedAt,
    "backups.backupEvidence.offsiteUploadReceipt.checkedAt",
    offsiteUpload.checkedAt,
  );
  if (
    typeof offsiteUpload.remoteArchive === "string" &&
    typeof offsiteUpload.remoteReceipt === "string" &&
    offsiteUpload.remoteReceipt !==
      `${offsiteUpload.remoteArchive.slice(0, offsiteUpload.remoteArchive.lastIndexOf("/"))}/receipt.json`
  ) {
    errors.push(
      error(
        "evidence_mismatch",
        "backups.backupEvidence off-site archive and receipt must share a remote backup directory",
      ),
    );
  }
  if (
    typeof offsiteUpload.backupName === "string" &&
    typeof offsiteUpload.remoteArchive === "string" &&
    !offsiteUpload.remoteArchive.endsWith(
      `/${offsiteUpload.backupName}.tar.gz.age`,
    )
  ) {
    errors.push(
      error(
        "evidence_mismatch",
        "backups.backupEvidence off-site archive must match backupName",
      ),
    );
  }
  requireIncludes(
    errors,
    "backups.includes",
    backups.includes,
    BACKUP_COMPONENTS,
  );

  return result("backup_restore", errors, [
    "backups.scheduled",
    "backups.offHost",
    "backups.encrypted",
    "backups.backupEvidence",
    "backups.backupEvidence.source",
    "backups.backupEvidence.sha256",
    "backups.backupEvidence.checkedAt",
    "backups.backupEvidence.status",
    "backups.backupEvidence.productionReady",
    "backups.backupEvidence.backupCreatedAt",
    "backups.backupEvidence.restoreCheckedAt",
    "backups.backupEvidence.componentCount",
    "backups.backupEvidence.checkCount",
    "backups.backupEvidence.offsiteUploadReceipt",
    "backups.backupEvidence.offsiteUploadReceipt.source",
    "backups.backupEvidence.offsiteUploadReceipt.sha256",
    "backups.backupEvidence.offsiteUploadReceipt.checkedAt",
    "backups.backupEvidence.offsiteUploadReceipt.status",
    "backups.backupEvidence.offsiteUploadReceipt.verified",
    "backups.backupEvidence.offsiteUploadReceipt.remoteArchive",
    "backups.backupEvidence.offsiteUploadReceipt.ciphertextSha256",
    "backups.backupEvidence.offsiteUploadReceipt.encryptionFormat",
    "backups.backupEvidence.offsiteUploadReceipt.recipientsFileSha256",
    "backups.backupEvidence.offsiteUploadReceipt.verificationMethod",
    "backups.backupEvidence.offsiteRestoreReceipt",
    "backups.backupEvidence.offsiteRestoreReceipt.source",
    "backups.backupEvidence.offsiteRestoreReceipt.sha256",
    "backups.backupEvidence.offsiteRestoreReceipt.checkedAt",
    "backups.backupEvidence.offsiteRestoreReceipt.status",
    "backups.backupEvidence.offsiteRestoreReceipt.verified",
    "backups.backupEvidence.offsiteRestoreReceipt.uploadReceiptSha256",
    "backups.backupEvidence.offsiteRestoreReceipt.downloadVerified",
    "backups.backupEvidence.offsiteRestoreReceipt.decryptionVerified",
    "backups.backupEvidence.offsiteRestoreReceipt.archivePathsVerified",
    "backups.backupEvidence.offsiteRestoreReceipt.structuralRestoreCheckPassed",
    "backups.lastBackupAt",
    "backups.lastRestoreCheckAt",
    "backups.includes",
  ]);
}

function checkDatabaseMigration(evidence) {
  const database = evidence.database ?? {};
  const databaseEvidence = database.databaseEvidence ?? {};
  const errors = [];

  requireObject(errors, "database.databaseEvidence", database.databaseEvidence);
  requirePresent(
    errors,
    "database.databaseEvidence.source",
    databaseEvidence.source,
  );
  requireSha256(
    errors,
    "database.databaseEvidence.sha256",
    databaseEvidence.sha256,
  );
  requireIsoDate(
    errors,
    "database.databaseEvidence.checkedAt",
    databaseEvidence.checkedAt,
  );
  requireEqual(
    errors,
    "database.databaseEvidence.status",
    databaseEvidence.status,
    "verified",
  );
  requireTrue(
    errors,
    "database.databaseEvidence.productionReady",
    databaseEvidence.productionReady,
  );
  requirePresent(
    errors,
    "database.databaseEvidence.migrationOutputSource",
    databaseEvidence.migrationOutputSource,
  );
  requireSha256(
    errors,
    "database.databaseEvidence.migrationOutputSha256",
    databaseEvidence.migrationOutputSha256,
  );
  requirePresent(
    errors,
    "database.databaseEvidence.restoreDrillOutputSource",
    databaseEvidence.restoreDrillOutputSource,
  );
  requireSha256(
    errors,
    "database.databaseEvidence.restoreDrillOutputSha256",
    databaseEvidence.restoreDrillOutputSha256,
  );
  requireMinimumNumber(
    errors,
    "database.databaseEvidence.checkCount",
    databaseEvidence.checkCount,
    1,
  );
  requireMinimumNumber(
    errors,
    "database.databaseEvidence.verifiedTableCount",
    databaseEvidence.verifiedTableCount,
    EXPECTED_RESTORE_TABLES.length,
  );
  requireTrue(errors, "database.forgejoPostgres", database.forgejoPostgres);
  requireTrue(errors, "database.stewardPostgres", database.stewardPostgres);
  requireTrue(errors, "database.migrationsApplied", database.migrationsApplied);
  requireTrue(
    errors,
    "database.emptyHostRestoreDrillPassed",
    database.emptyHostRestoreDrillPassed,
  );
  requireTrue(
    errors,
    "database.checksumDriftClean",
    database.checksumDriftClean,
  );

  return result("database_migration", errors, [
    "database.databaseEvidence",
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
    "database.forgejoPostgres",
    "database.stewardPostgres",
    "database.migrationsApplied",
    "database.emptyHostRestoreDrillPassed",
    "database.checksumDriftClean",
  ]);
}

function checkImageProvenance(evidence) {
  const images = evidence.imageProvenance ?? {};
  const provenanceEvidence = images.provenanceEvidence ?? {};
  const errors = [];

  requireDigestImage(
    errors,
    "imageProvenance.forgejoImage",
    images.forgejoImage,
  );
  requireDigestImage(
    errors,
    "imageProvenance.stewardImage",
    images.stewardImage,
  );
  requireDigestImage(errors, "imageProvenance.runnerImage", images.runnerImage);
  requireDigestImage(errors, "imageProvenance.dindImage", images.dindImage);
  requireObject(
    errors,
    "imageProvenance.provenanceEvidence",
    images.provenanceEvidence,
  );
  requirePresent(
    errors,
    "imageProvenance.provenanceEvidence.source",
    provenanceEvidence.source,
  );
  requireSha256(
    errors,
    "imageProvenance.provenanceEvidence.sha256",
    provenanceEvidence.sha256,
  );
  requireIsoDate(
    errors,
    "imageProvenance.provenanceEvidence.checkedAt",
    provenanceEvidence.checkedAt,
  );
  requireMinimumNumber(
    errors,
    "imageProvenance.provenanceEvidence.imageCount",
    provenanceEvidence.imageCount,
    4,
  );
  requireMinimumNumber(
    errors,
    "imageProvenance.provenanceEvidence.checkCount",
    provenanceEvidence.checkCount,
    1,
  );
  requireTrue(
    errors,
    "imageProvenance.stewardImageBuiltByCi",
    images.stewardImageBuiltByCi,
  );
  requireTrue(
    errors,
    "imageProvenance.stewardImageSignatureVerified",
    images.stewardImageSignatureVerified,
  );
  requireTrue(errors, "imageProvenance.sbomGenerated", images.sbomGenerated);
  requireTrue(
    errors,
    "imageProvenance.vulnerabilityScanClean",
    images.vulnerabilityScanClean,
  );

  return result("image_provenance", errors, [
    "imageProvenance.forgejoImage",
    "imageProvenance.stewardImage",
    "imageProvenance.runnerImage",
    "imageProvenance.dindImage",
    "imageProvenance.provenanceEvidence",
    "imageProvenance.provenanceEvidence.source",
    "imageProvenance.provenanceEvidence.sha256",
    "imageProvenance.provenanceEvidence.checkedAt",
    "imageProvenance.provenanceEvidence.imageCount",
    "imageProvenance.provenanceEvidence.checkCount",
    "imageProvenance.stewardImageBuiltByCi",
    "imageProvenance.stewardImageSignatureVerified",
    "imageProvenance.sbomGenerated",
    "imageProvenance.vulnerabilityScanClean",
  ]);
}

function checkRunnerIsolation(evidence) {
  const runner = evidence.runner ?? {};
  const smokeEvidence = runner.smokeEvidence ?? {};
  const auditEvidence = runner.auditEvidence ?? {};
  const errors = [];

  requireObject(errors, "runner.smokeEvidence", runner.smokeEvidence);
  requirePresent(errors, "runner.smokeEvidence.source", smokeEvidence.source);
  requireSha256(errors, "runner.smokeEvidence.sha256", smokeEvidence.sha256);
  requireIsoDate(
    errors,
    "runner.smokeEvidence.checkedAt",
    smokeEvidence.checkedAt,
  );
  requirePresent(
    errors,
    "runner.smokeEvidence.repository",
    smokeEvidence.repository,
  );
  requirePresent(
    errors,
    "runner.smokeEvidence.workflow",
    smokeEvidence.workflow,
  );
  requirePresent(errors, "runner.smokeEvidence.runId", smokeEvidence.runId);
  requireHttpsUrl(
    errors,
    "runner.smokeEvidence.workflowRunUrl",
    smokeEvidence.workflowRunUrl,
  );
  requireObject(errors, "runner.auditEvidence", runner.auditEvidence);
  requirePresent(errors, "runner.auditEvidence.source", auditEvidence.source);
  requireSha256(errors, "runner.auditEvidence.sha256", auditEvidence.sha256);
  requireIsoDate(
    errors,
    "runner.auditEvidence.checkedAt",
    auditEvidence.checkedAt,
  );
  requireEqual(
    errors,
    "runner.auditEvidence.status",
    auditEvidence.status,
    "isolated",
  );
  requireMinimumNumber(
    errors,
    "runner.auditEvidence.checkCount",
    auditEvidence.checkCount,
    1,
  );
  requireTrue(errors, "runner.isolated", runner.isolated);
  requireTrue(errors, "runner.noHostDockerSocket", runner.noHostDockerSocket);
  requireTrue(errors, "runner.noHostLabels", runner.noHostLabels);
  requireTrue(errors, "runner.registrationTested", runner.registrationTested);
  requireTrue(
    errors,
    "runner.trustedSmokeWorkflowPassed",
    runner.trustedSmokeWorkflowPassed,
  );
  requireTrue(errors, "runner.egressReviewed", runner.egressReviewed);
  requireTrue(
    errors,
    "runner.secretExposureReviewed",
    runner.secretExposureReviewed,
  );

  return result("runner_isolation", errors, [
    "runner.smokeEvidence",
    "runner.smokeEvidence.source",
    "runner.smokeEvidence.sha256",
    "runner.smokeEvidence.checkedAt",
    "runner.smokeEvidence.repository",
    "runner.smokeEvidence.workflow",
    "runner.smokeEvidence.runId",
    "runner.smokeEvidence.workflowRunUrl",
    "runner.auditEvidence",
    "runner.auditEvidence.source",
    "runner.auditEvidence.sha256",
    "runner.auditEvidence.checkedAt",
    "runner.auditEvidence.status",
    "runner.auditEvidence.checkCount",
    "runner.isolated",
    "runner.noHostDockerSocket",
    "runner.noHostLabels",
    "runner.registrationTested",
    "runner.trustedSmokeWorkflowPassed",
    "runner.egressReviewed",
    "runner.secretExposureReviewed",
  ]);
}

function checkRepositoryProtection(evidence) {
  const repo = evidence.repository ?? {};
  const errors = [];

  requireNonEmptyArray(
    errors,
    "repository.protectedBranches",
    repo.protectedBranches,
  );
  requireNonEmptyArray(
    errors,
    "repository.requiredChecks",
    repo.requiredChecks,
  );
  requireTrue(errors, "repository.forkPolicyReviewed", repo.forkPolicyReviewed);
  requireTrue(
    errors,
    "repository.actionsPolicyReviewed",
    repo.actionsPolicyReviewed,
  );
  requireTrue(
    errors,
    "repository.adminBypassReviewed",
    repo.adminBypassReviewed,
  );
  requireObject(
    errors,
    "repository.liveProtectionEvidence",
    repo.liveProtectionEvidence,
  );
  requirePresent(
    errors,
    "repository.liveProtectionEvidence.source",
    repo.liveProtectionEvidence?.source,
  );
  requireSha256(
    errors,
    "repository.liveProtectionEvidence.sha256",
    repo.liveProtectionEvidence?.sha256,
  );
  requireIsoDate(
    errors,
    "repository.liveProtectionEvidence.checkedAt",
    repo.liveProtectionEvidence?.checkedAt,
  );
  requireEqual(
    errors,
    "repository.liveProtectionEvidence.status",
    repo.liveProtectionEvidence?.status,
    "protected",
  );
  requireTrue(
    errors,
    "repository.liveProtectionEvidence.productionReady",
    repo.liveProtectionEvidence?.productionReady,
  );
  requireTrue(
    errors,
    "repository.liveProtectionEvidence.liveAvailable",
    repo.liveProtectionEvidence?.liveAvailable,
  );
  requireTrue(
    errors,
    "repository.liveProtectionEvidence.liveRequired",
    repo.liveProtectionEvidence?.liveRequired,
  );
  requireMinimumNumber(
    errors,
    "repository.liveProtectionEvidence.checkCount",
    repo.liveProtectionEvidence?.checkCount,
    1,
  );

  return result("repository_protection", errors, [
    "repository.protectedBranches",
    "repository.requiredChecks",
    "repository.forkPolicyReviewed",
    "repository.actionsPolicyReviewed",
    "repository.adminBypassReviewed",
    "repository.liveProtectionEvidence",
    "repository.liveProtectionEvidence.source",
    "repository.liveProtectionEvidence.sha256",
    "repository.liveProtectionEvidence.checkedAt",
    "repository.liveProtectionEvidence.status",
    "repository.liveProtectionEvidence.productionReady",
    "repository.liveProtectionEvidence.liveAvailable",
    "repository.liveProtectionEvidence.liveRequired",
    "repository.liveProtectionEvidence.checkCount",
  ]);
}

function checkGithubMigrationRehearsal(evidence) {
  const migration = evidence.githubMigration ?? {};
  const pilotBootstrapEvidence = migration.pilotBootstrapEvidence ?? {};
  const errors = [];

  requireObject(
    errors,
    "githubMigration.pilotBootstrapEvidence",
    migration.pilotBootstrapEvidence,
  );
  requirePresent(
    errors,
    "githubMigration.pilotBootstrapEvidence.source",
    pilotBootstrapEvidence.source,
  );
  requireSha256(
    errors,
    "githubMigration.pilotBootstrapEvidence.sha256",
    pilotBootstrapEvidence.sha256,
  );
  requireIsoDate(
    errors,
    "githubMigration.pilotBootstrapEvidence.checkedAt",
    pilotBootstrapEvidence.checkedAt,
  );
  requireEqual(
    errors,
    "githubMigration.pilotBootstrapEvidence.status",
    pilotBootstrapEvidence.status,
    "passed",
  );
  requireEqual(
    errors,
    "githubMigration.pilotBootstrapEvidence.dryRun",
    pilotBootstrapEvidence.dryRun,
    false,
  );
  requirePresent(
    errors,
    "githubMigration.pilotBootstrapEvidence.repo",
    pilotBootstrapEvidence.repo,
  );
  requireEqual(
    errors,
    "githubMigration.pilotBootstrapEvidence.upstreamHost",
    pilotBootstrapEvidence.upstreamHost,
    "github.com",
  );
  requireMinimumNumber(
    errors,
    "githubMigration.pilotBootstrapEvidence.stepCount",
    pilotBootstrapEvidence.stepCount,
    8,
  );
  requireMinimumNumber(
    errors,
    "githubMigration.pilotBootstrapEvidence.requiredCheckCount",
    pilotBootstrapEvidence.requiredCheckCount,
    1,
  );
  requireMinimumNumber(
    errors,
    "githubMigration.pilotBootstrapEvidence.trustedAgentCount",
    pilotBootstrapEvidence.trustedAgentCount,
    1,
  );
  requireTrue(
    errors,
    "githubMigration.pilotBootstrapPassed",
    migration.pilotBootstrapPassed,
  );
  requireTrue(
    errors,
    "githubMigration.mirrorVerified",
    migration.mirrorVerified,
  );
  requireTrue(
    errors,
    "githubMigration.defaultBranchVerified",
    migration.defaultBranchVerified,
  );
  requireTrue(
    errors,
    "githubMigration.webhookVerified",
    migration.webhookVerified,
  );
  requireTrue(
    errors,
    "githubMigration.branchProtectionVerified",
    migration.branchProtectionVerified,
  );
  requireTrue(
    errors,
    "githubMigration.repoPolicyVerified",
    migration.repoPolicyVerified,
  );
  requireTrue(
    errors,
    "githubMigration.agentIdentitiesSynced",
    migration.agentIdentitiesSynced,
  );
  requireTrue(
    errors,
    "githubMigration.pilotSurfacesVerified",
    migration.pilotSurfacesVerified,
  );
  requireTrue(
    errors,
    "githubMigration.pullMirrorOnly",
    migration.pullMirrorOnly,
  );

  return result("github_migration_rehearsal", errors, [
    "githubMigration.pilotBootstrapEvidence",
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
  ]);
}

function checkSecretManagement(evidence) {
  const secrets = evidence.secrets ?? {};
  const secretEvidence = secrets.secretEvidence ?? {};
  const errors = [];

  requireObject(errors, "secrets.secretEvidence", secrets.secretEvidence);
  requirePresent(
    errors,
    "secrets.secretEvidence.source",
    secretEvidence.source,
  );
  requireSha256(errors, "secrets.secretEvidence.sha256", secretEvidence.sha256);
  requireIsoDate(
    errors,
    "secrets.secretEvidence.checkedAt",
    secretEvidence.checkedAt,
  );
  requireEqual(
    errors,
    "secrets.secretEvidence.status",
    secretEvidence.status,
    "verified",
  );
  requireTrue(
    errors,
    "secrets.secretEvidence.productionReady",
    secretEvidence.productionReady,
  );
  requireMinimumNumber(
    errors,
    "secrets.secretEvidence.groupCount",
    secretEvidence.groupCount,
    4,
  );
  requireMinimumNumber(
    errors,
    "secrets.secretEvidence.checkCount",
    secretEvidence.checkCount,
    1,
  );
  requireTrue(
    errors,
    "secrets.externalSecretStore",
    secrets.externalSecretStore,
  );
  requireTrue(
    errors,
    "secrets.rotationPolicyDocumented",
    secrets.rotationPolicyDocumented,
  );
  requireTrue(
    errors,
    "secrets.appIniSecretsIssued",
    secrets.appIniSecretsIssued,
  );
  requireTrue(errors, "secrets.runnerTokenIssued", secrets.runnerTokenIssued);
  requireTrue(errors, "secrets.oauthSecretsIssued", secrets.oauthSecretsIssued);
  requireTrue(
    errors,
    "secrets.webhookSecretsIssued",
    secrets.webhookSecretsIssued,
  );
  requireTrue(
    errors,
    "secrets.noPlaintextSecretsCommitted",
    secrets.noPlaintextSecretsCommitted,
  );

  return result("secret_management", errors, [
    "secrets.secretEvidence",
    "secrets.secretEvidence.source",
    "secrets.secretEvidence.sha256",
    "secrets.secretEvidence.checkedAt",
    "secrets.secretEvidence.status",
    "secrets.secretEvidence.productionReady",
    "secrets.secretEvidence.groupCount",
    "secrets.secretEvidence.checkCount",
    "secrets.externalSecretStore",
    "secrets.rotationPolicyDocumented",
    "secrets.appIniSecretsIssued",
    "secrets.runnerTokenIssued",
    "secrets.oauthSecretsIssued",
    "secrets.webhookSecretsIssued",
    "secrets.noPlaintextSecretsCommitted",
  ]);
}

function checkMailNotifications(evidence) {
  const mail = evidence.mail ?? {};
  const mailEvidence = mail.mailEvidence ?? {};
  const errors = [];

  requireObject(errors, "mail.mailEvidence", mail.mailEvidence);
  requirePresent(errors, "mail.mailEvidence.source", mailEvidence.source);
  requireSha256(errors, "mail.mailEvidence.sha256", mailEvidence.sha256);
  requireIsoDate(errors, "mail.mailEvidence.checkedAt", mailEvidence.checkedAt);
  requireEqual(
    errors,
    "mail.mailEvidence.status",
    mailEvidence.status,
    "verified",
  );
  requireTrue(
    errors,
    "mail.mailEvidence.productionReady",
    mailEvidence.productionReady,
  );
  requireMinimumNumber(
    errors,
    "mail.mailEvidence.checkCount",
    mailEvidence.checkCount,
    4,
  );
  requireTrue(errors, "mail.smtpConfigured", mail.smtpConfigured);
  requireTrue(errors, "mail.inviteSmokePassed", mail.inviteSmokePassed);
  requireTrue(
    errors,
    "mail.passwordResetSmokePassed",
    mail.passwordResetSmokePassed,
  );
  requireTrue(
    errors,
    "mail.notificationSmokePassed",
    mail.notificationSmokePassed,
  );

  return result("mail_notifications", errors, [
    "mail.mailEvidence",
    "mail.mailEvidence.source",
    "mail.mailEvidence.sha256",
    "mail.mailEvidence.checkedAt",
    "mail.mailEvidence.status",
    "mail.mailEvidence.productionReady",
    "mail.mailEvidence.checkCount",
    "mail.smtpConfigured",
    "mail.inviteSmokePassed",
    "mail.passwordResetSmokePassed",
    "mail.notificationSmokePassed",
  ]);
}

function checkStorageRetention(evidence) {
  const storage = evidence.storage ?? {};
  const storageEvidence = storage.storageEvidence ?? {};
  const errors = [];

  requireObject(errors, "storage.storageEvidence", storage.storageEvidence);
  requirePresent(
    errors,
    "storage.storageEvidence.source",
    storageEvidence.source,
  );
  requireSha256(
    errors,
    "storage.storageEvidence.sha256",
    storageEvidence.sha256,
  );
  requireIsoDate(
    errors,
    "storage.storageEvidence.checkedAt",
    storageEvidence.checkedAt,
  );
  requireEqual(
    errors,
    "storage.storageEvidence.status",
    storageEvidence.status,
    "verified",
  );
  requireTrue(
    errors,
    "storage.storageEvidence.productionReady",
    storageEvidence.productionReady,
  );
  requireMinimumNumber(
    errors,
    "storage.storageEvidence.checkCount",
    storageEvidence.checkCount,
    5,
  );
  requireTrue(errors, "storage.sizingReviewed", storage.sizingReviewed);
  requireTrue(
    errors,
    "storage.artifactRetentionConfigured",
    storage.artifactRetentionConfigured,
  );
  requireTrue(
    errors,
    "storage.packageRetentionConfigured",
    storage.packageRetentionConfigured,
  );
  requireTrue(
    errors,
    "storage.lfsCapacityReviewed",
    storage.lfsCapacityReviewed,
  );
  requireTrue(
    errors,
    "storage.logRetentionConfigured",
    storage.logRetentionConfigured,
  );

  return result("storage_retention", errors, [
    "storage.storageEvidence",
    "storage.storageEvidence.source",
    "storage.storageEvidence.sha256",
    "storage.storageEvidence.checkedAt",
    "storage.storageEvidence.status",
    "storage.storageEvidence.productionReady",
    "storage.storageEvidence.checkCount",
    "storage.sizingReviewed",
    "storage.artifactRetentionConfigured",
    "storage.packageRetentionConfigured",
    "storage.lfsCapacityReviewed",
    "storage.logRetentionConfigured",
  ]);
}

function checkObservability(evidence) {
  const observability = evidence.observability ?? {};
  const observabilityEvidence = observability.observabilityEvidence ?? {};
  const errors = [];

  requireObject(
    errors,
    "observability.observabilityEvidence",
    observability.observabilityEvidence,
  );
  requirePresent(
    errors,
    "observability.observabilityEvidence.source",
    observabilityEvidence.source,
  );
  requireSha256(
    errors,
    "observability.observabilityEvidence.sha256",
    observabilityEvidence.sha256,
  );
  requireIsoDate(
    errors,
    "observability.observabilityEvidence.checkedAt",
    observabilityEvidence.checkedAt,
  );
  requireEqual(
    errors,
    "observability.observabilityEvidence.status",
    observabilityEvidence.status,
    "verified",
  );
  requireTrue(
    errors,
    "observability.observabilityEvidence.productionReady",
    observabilityEvidence.productionReady,
  );
  requireMinimumNumber(
    errors,
    "observability.observabilityEvidence.checkCount",
    observabilityEvidence.checkCount,
    6,
  );
  requireTrue(
    errors,
    "observability.prometheusScrapeOk",
    observability.prometheusScrapeOk,
  );
  requireTrue(
    errors,
    "observability.alertRulesLoaded",
    observability.alertRulesLoaded,
  );
  requireTrue(
    errors,
    "observability.alertRoutingConfigured",
    observability.alertRoutingConfigured,
  );
  requireTrue(
    errors,
    "observability.logsCollected",
    observability.logsCollected,
  );
  requireMinimumNumber(
    errors,
    "observability.logRetentionDays",
    observability.logRetentionDays,
    7,
  );
  requireTrue(
    errors,
    "observability.noPageAlertsFiring",
    observability.noPageAlertsFiring,
  );

  return result("observability", errors, [
    "observability.observabilityEvidence",
    "observability.observabilityEvidence.source",
    "observability.observabilityEvidence.sha256",
    "observability.observabilityEvidence.checkedAt",
    "observability.observabilityEvidence.status",
    "observability.observabilityEvidence.productionReady",
    "observability.observabilityEvidence.checkCount",
    "observability.prometheusScrapeOk",
    "observability.alertRulesLoaded",
    "observability.alertRoutingConfigured",
    "observability.logsCollected",
    "observability.logRetentionDays",
    "observability.noPageAlertsFiring",
  ]);
}

function checkStewardRuntime(evidence) {
  const steward = evidence.steward ?? {};
  const preflight = steward.preflight ?? {};
  const doctor = steward.doctor ?? {};
  const preflightEvidence = steward.preflightEvidence ?? {};
  const doctorEvidence = steward.doctorEvidence ?? {};
  const errors = [];

  requireTrue(errors, "steward.preflight.ok", preflight.ok);
  requireEqual(errors, "steward.preflight.mode", preflight.mode, "production");
  requireEmptyArray(errors, "steward.preflight.errors", preflight.errors);
  requireTrue(errors, "steward.doctor.ok", doctor.ok);
  requireObject(errors, "steward.preflightEvidence", steward.preflightEvidence);
  requirePresent(
    errors,
    "steward.preflightEvidence.source",
    preflightEvidence.source,
  );
  requireSha256(
    errors,
    "steward.preflightEvidence.sha256",
    preflightEvidence.sha256,
  );
  requireIsoDate(
    errors,
    "steward.preflightEvidence.checkedAt",
    preflightEvidence.checkedAt,
  );
  requireEqual(
    errors,
    "steward.preflightEvidence.mode",
    preflightEvidence.mode,
    "production",
  );
  requireEqual(
    errors,
    "steward.preflightEvidence.errorCount",
    preflightEvidence.errorCount,
    0,
  );
  requireObject(errors, "steward.doctorEvidence", steward.doctorEvidence);
  requirePresent(
    errors,
    "steward.doctorEvidence.source",
    doctorEvidence.source,
  );
  requireSha256(errors, "steward.doctorEvidence.sha256", doctorEvidence.sha256);
  requirePresent(
    errors,
    "steward.doctorEvidence.target",
    doctorEvidence.target,
  );
  requireIsoDate(
    errors,
    "steward.doctorEvidence.checkedAt",
    doctorEvidence.checkedAt,
  );
  requireMinimumNumber(
    errors,
    "steward.doctorEvidence.checkCount",
    doctorEvidence.checkCount,
    1,
  );
  requireTrue(
    errors,
    "steward.readyProductionMode",
    steward.readyProductionMode,
  );
  requireTrue(
    errors,
    "steward.labelMirroringTested",
    steward.labelMirroringTested,
  );
  requireTrue(
    errors,
    "steward.botTokenPermissionsReviewed",
    steward.botTokenPermissionsReviewed,
  );
  requireTrue(
    errors,
    "steward.strictWorkReservationsEnforced",
    steward.strictWorkReservationsEnforced,
  );
  requireTrue(
    errors,
    "steward.strictWorkItemsEnforced",
    steward.strictWorkItemsEnforced,
  );
  requireTrue(
    errors,
    "steward.strictAgentBranchNamespacesEnforced",
    steward.strictAgentBranchNamespacesEnforced,
  );
  requireTrue(
    errors,
    "steward.verifiedAgentRunReceiptsEnforced",
    steward.verifiedAgentRunReceiptsEnforced,
  );
  requireTrue(
    errors,
    "steward.agentIdentityRegistryEnforced",
    steward.agentIdentityRegistryEnforced,
  );

  return result("steward_runtime", errors, [
    "steward.preflight",
    "steward.preflight.ok",
    "steward.preflight.mode",
    "steward.preflight.errors",
    "steward.doctor",
    "steward.doctor.ok",
    "steward.preflightEvidence",
    "steward.preflightEvidence.source",
    "steward.preflightEvidence.sha256",
    "steward.preflightEvidence.checkedAt",
    "steward.preflightEvidence.mode",
    "steward.preflightEvidence.errorCount",
    "steward.doctorEvidence",
    "steward.doctorEvidence.source",
    "steward.doctorEvidence.sha256",
    "steward.doctorEvidence.target",
    "steward.doctorEvidence.checkedAt",
    "steward.doctorEvidence.checkCount",
    "steward.readyProductionMode",
    "steward.labelMirroringTested",
    "steward.botTokenPermissionsReviewed",
    "steward.strictWorkReservationsEnforced",
    "steward.strictWorkItemsEnforced",
    "steward.strictAgentBranchNamespacesEnforced",
    "steward.verifiedAgentRunReceiptsEnforced",
    "steward.agentIdentityRegistryEnforced",
  ]);
}

function checkMergeQueueRollout(evidence) {
  const rollout = evidence.mergeQueueRollout ?? {};
  const errors = [];

  requireTrue(errors, "mergeQueueRollout.dryRunPassed", rollout.dryRunPassed);
  requireTrue(
    errors,
    "mergeQueueRollout.stagedLiveDrillPassed",
    rollout.stagedLiveDrillPassed,
  );
  requireTrue(
    errors,
    "mergeQueueRollout.workerLeaseVerified",
    rollout.workerLeaseVerified,
  );
  requireTrue(
    errors,
    "mergeQueueRollout.strictWorkReservationsEnforced",
    rollout.strictWorkReservationsEnforced,
  );
  requireTrue(
    errors,
    "mergeQueueRollout.strictWorkItemsEnforced",
    rollout.strictWorkItemsEnforced,
  );
  requireTrue(
    errors,
    "mergeQueueRollout.strictAgentBranchNamespacesEnforced",
    rollout.strictAgentBranchNamespacesEnforced,
  );
  requireTrue(
    errors,
    "mergeQueueRollout.verifiedAgentRunReceiptsEnforced",
    rollout.verifiedAgentRunReceiptsEnforced,
  );
  requireTrue(
    errors,
    "mergeQueueRollout.agentIdentityRegistryEnforced",
    rollout.agentIdentityRegistryEnforced,
  );
  requireTrue(
    errors,
    "mergeQueueRollout.stackDependencyOrderEnforced",
    rollout.stackDependencyOrderEnforced,
  );
  requireTrue(
    errors,
    "mergeQueueRollout.rollbackDrillPassed",
    rollout.rollbackDrillPassed,
  );
  requireTrue(
    errors,
    "mergeQueueRollout.humanApprovalRecorded",
    rollout.humanApprovalRecorded,
  );
  requireObject(
    errors,
    "mergeQueueRollout.dryRunEvidence",
    rollout.dryRunEvidence,
  );
  requirePresent(
    errors,
    "mergeQueueRollout.dryRunEvidence.source",
    rollout.dryRunEvidence?.source,
  );
  requireSha256(
    errors,
    "mergeQueueRollout.dryRunEvidence.sha256",
    rollout.dryRunEvidence?.sha256,
  );
  requireIsoDate(
    errors,
    "mergeQueueRollout.dryRunEvidence.checkedAt",
    rollout.dryRunEvidence?.checkedAt,
  );
  requireMinimumNumber(
    errors,
    "mergeQueueRollout.dryRunEvidence.checkCount",
    rollout.dryRunEvidence?.checkCount,
    1,
  );
  requireObject(
    errors,
    "mergeQueueRollout.liveDrillEvidence",
    rollout.liveDrillEvidence,
  );
  requirePresent(
    errors,
    "mergeQueueRollout.liveDrillEvidence.source",
    rollout.liveDrillEvidence?.source,
  );
  requireSha256(
    errors,
    "mergeQueueRollout.liveDrillEvidence.sha256",
    rollout.liveDrillEvidence?.sha256,
  );
  requireIsoDate(
    errors,
    "mergeQueueRollout.liveDrillEvidence.checkedAt",
    rollout.liveDrillEvidence?.checkedAt,
  );
  requirePresent(
    errors,
    "mergeQueueRollout.liveDrillEvidence.runId",
    rollout.liveDrillEvidence?.runId,
  );

  return result("merge_queue_rollout", errors, [
    "mergeQueueRollout.dryRunPassed",
    "mergeQueueRollout.stagedLiveDrillPassed",
    "mergeQueueRollout.workerLeaseVerified",
    "mergeQueueRollout.strictWorkReservationsEnforced",
    "mergeQueueRollout.strictWorkItemsEnforced",
    "mergeQueueRollout.strictAgentBranchNamespacesEnforced",
    "mergeQueueRollout.verifiedAgentRunReceiptsEnforced",
    "mergeQueueRollout.agentIdentityRegistryEnforced",
    "mergeQueueRollout.stackDependencyOrderEnforced",
    "mergeQueueRollout.rollbackDrillPassed",
    "mergeQueueRollout.humanApprovalRecorded",
    "mergeQueueRollout.dryRunEvidence",
    "mergeQueueRollout.dryRunEvidence.source",
    "mergeQueueRollout.dryRunEvidence.sha256",
    "mergeQueueRollout.dryRunEvidence.checkedAt",
    "mergeQueueRollout.dryRunEvidence.checkCount",
    "mergeQueueRollout.liveDrillEvidence",
    "mergeQueueRollout.liveDrillEvidence.source",
    "mergeQueueRollout.liveDrillEvidence.sha256",
    "mergeQueueRollout.liveDrillEvidence.checkedAt",
    "mergeQueueRollout.liveDrillEvidence.runId",
  ]);
}

function checkSecurityReview(evidence) {
  const security = evidence.securityReview ?? {};
  const securityEvidence = security.securityEvidence ?? {};
  const errors = [];

  requireObject(
    errors,
    "securityReview.securityEvidence",
    security.securityEvidence,
  );
  requirePresent(
    errors,
    "securityReview.securityEvidence.source",
    securityEvidence.source,
  );
  requireSha256(
    errors,
    "securityReview.securityEvidence.sha256",
    securityEvidence.sha256,
  );
  requireIsoDate(
    errors,
    "securityReview.securityEvidence.checkedAt",
    securityEvidence.checkedAt,
  );
  requireEqual(
    errors,
    "securityReview.securityEvidence.status",
    securityEvidence.status,
    "approved",
  );
  requireTrue(
    errors,
    "securityReview.securityEvidence.productionReady",
    securityEvidence.productionReady,
  );
  requirePresent(
    errors,
    "securityReview.securityEvidence.approvedBy",
    securityEvidence.approvedBy,
  );
  requireIsoDate(
    errors,
    "securityReview.securityEvidence.approvedAt",
    securityEvidence.approvedAt,
  );
  requireMinimumNumber(
    errors,
    "securityReview.securityEvidence.checkCount",
    securityEvidence.checkCount,
    1,
  );
  requireMinimumNumber(
    errors,
    "securityReview.securityEvidence.reviewedSurfaceCount",
    securityEvidence.reviewedSurfaceCount,
    4,
  );
  requireTrue(errors, "securityReview.authReviewed", security.authReviewed);
  requireTrue(errors, "securityReview.tokensReviewed", security.tokensReviewed);
  requireTrue(
    errors,
    "securityReview.runnerExecutionReviewed",
    security.runnerExecutionReviewed,
  );
  requireTrue(
    errors,
    "securityReview.repoPermissionsReviewed",
    security.repoPermissionsReviewed,
  );
  requirePresent(errors, "securityReview.approvedBy", security.approvedBy);
  requireIsoDate(errors, "securityReview.approvedAt", security.approvedAt);

  return result("security_review", errors, [
    "securityReview.securityEvidence",
    "securityReview.securityEvidence.source",
    "securityReview.securityEvidence.sha256",
    "securityReview.securityEvidence.checkedAt",
    "securityReview.securityEvidence.status",
    "securityReview.securityEvidence.productionReady",
    "securityReview.securityEvidence.approvedBy",
    "securityReview.securityEvidence.approvedAt",
    "securityReview.securityEvidence.checkCount",
    "securityReview.securityEvidence.reviewedSurfaceCount",
    "securityReview.authReviewed",
    "securityReview.tokensReviewed",
    "securityReview.runnerExecutionReviewed",
    "securityReview.repoPermissionsReviewed",
    "securityReview.approvedBy",
    "securityReview.approvedAt",
  ]);
}

function checkDeploymentVerification(evidence) {
  const deployment = evidence.deployment ?? {};
  const deployEvidence = deployment.deployEvidence ?? {};
  const postDeployEvidence = deployment.postDeployEvidence ?? {};
  const errors = [];

  if (!["first-boot", "rolling"].includes(deployment.mode)) {
    errors.push(
      error(
        "unexpected_evidence_value",
        "deployment.mode must be first-boot or rolling",
      ),
    );
  }
  requireTrue(errors, "deployment.applied", deployment.applied);
  requireTrue(
    errors,
    "deployment.postDeployVerified",
    deployment.postDeployVerified,
  );
  requireObject(errors, "deployment.deployEvidence", deployment.deployEvidence);
  requirePresent(
    errors,
    "deployment.deployEvidence.source",
    deployEvidence.source,
  );
  requireSha256(
    errors,
    "deployment.deployEvidence.sha256",
    deployEvidence.sha256,
  );
  requireIsoDate(
    errors,
    "deployment.deployEvidence.checkedAt",
    deployEvidence.checkedAt,
  );
  requireEqual(
    errors,
    "deployment.deployEvidence.status",
    deployEvidence.status,
    "passed",
  );
  requireEqual(
    errors,
    "deployment.deployEvidence.mode",
    deployEvidence.mode,
    deployment.mode,
  );
  requireEqual(
    errors,
    "deployment.deployEvidence.dryRun",
    deployEvidence.dryRun,
    false,
  );
  requireMinimumNumber(
    errors,
    "deployment.deployEvidence.stepCount",
    deployEvidence.stepCount,
    5,
  );
  requirePresent(
    errors,
    "deployment.deployEvidence.postDeployEvidenceSource",
    deployEvidence.postDeployEvidenceSource,
  );
  requireSha256(
    errors,
    "deployment.deployEvidence.postDeployEvidenceSha256",
    deployEvidence.postDeployEvidenceSha256,
  );
  requireObject(
    errors,
    "deployment.postDeployEvidence",
    deployment.postDeployEvidence,
  );
  requirePresent(
    errors,
    "deployment.postDeployEvidence.source",
    postDeployEvidence.source,
  );
  requireSha256(
    errors,
    "deployment.postDeployEvidence.sha256",
    postDeployEvidence.sha256,
  );
  requireIsoDate(
    errors,
    "deployment.postDeployEvidence.checkedAt",
    postDeployEvidence.checkedAt,
  );
  requireEqual(
    errors,
    "deployment.postDeployEvidence.status",
    postDeployEvidence.status,
    "passed",
  );
  requireMinimumNumber(
    errors,
    "deployment.postDeployEvidence.checkCount",
    postDeployEvidence.checkCount,
    1,
  );
  requireEqual(
    errors,
    "deployment.postDeployEvidence.failedCount",
    postDeployEvidence.failedCount,
    0,
  );
  requirePresent(
    errors,
    "deployment.postDeployEvidence.forgejoLocalUrl",
    postDeployEvidence.forgejoLocalUrl,
  );
  requirePresent(
    errors,
    "deployment.postDeployEvidence.stewardLocalUrl",
    postDeployEvidence.stewardLocalUrl,
  );

  return result("deployment_verification", errors, [
    "deployment.mode",
    "deployment.applied",
    "deployment.postDeployVerified",
    "deployment.deployEvidence",
    "deployment.deployEvidence.source",
    "deployment.deployEvidence.sha256",
    "deployment.deployEvidence.checkedAt",
    "deployment.deployEvidence.status",
    "deployment.deployEvidence.mode",
    "deployment.deployEvidence.dryRun",
    "deployment.deployEvidence.stepCount",
    "deployment.deployEvidence.postDeployEvidenceSource",
    "deployment.deployEvidence.postDeployEvidenceSha256",
    "deployment.postDeployEvidence",
    "deployment.postDeployEvidence.source",
    "deployment.postDeployEvidence.sha256",
    "deployment.postDeployEvidence.checkedAt",
    "deployment.postDeployEvidence.status",
    "deployment.postDeployEvidence.checkCount",
    "deployment.postDeployEvidence.failedCount",
    "deployment.postDeployEvidence.forgejoLocalUrl",
    "deployment.postDeployEvidence.stewardLocalUrl",
  ]);
}

function result(name, errors, evidenceKeys = []) {
  return {
    name,
    ok: errors.length === 0,
    status: errors.length === 0 ? "ok" : "failed",
    evidence: evidenceKeys,
    errors,
  };
}

function error(code, message) {
  return { code, message };
}

function requirePresent(errors, path, value) {
  if (value === undefined || value === null || value === "") {
    errors.push(error("missing_evidence", `${path} is required`));
  }
}

function requireObject(errors, path, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(error("missing_evidence", `${path} must be an object`));
  }
}

function requireTrue(errors, path, value) {
  if (value !== true) {
    errors.push(error("evidence_not_true", `${path} must be true`));
  }
}

function requireEqual(errors, path, value, expected) {
  if (value !== expected) {
    errors.push(
      error(
        "unexpected_evidence_value",
        `${path} must be ${JSON.stringify(expected)}`,
      ),
    );
  }
}

function requireEmptyArray(errors, path, value) {
  if (!Array.isArray(value) || value.length !== 0) {
    errors.push(error("evidence_not_empty", `${path} must be an empty array`));
  }
}

function requireNonEmptyArray(errors, path, value) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(error("missing_evidence", `${path} must be a non-empty array`));
  }
}

function requireIncludes(errors, path, value, expectedItems) {
  if (!Array.isArray(value)) {
    errors.push(error("missing_evidence", `${path} must be an array`));
    return;
  }

  for (const item of expectedItems) {
    if (!value.includes(item)) {
      errors.push(error("missing_evidence", `${path} must include ${item}`));
    }
  }
}

function requireDigestImage(errors, path, value) {
  requirePresent(errors, path, value);
  if (value === undefined || value === null || value === "") {
    return;
  }

  if (
    typeof value !== "string" ||
    !/^[^\s@]+@sha256:[a-f0-9]{64}$/i.test(value)
  ) {
    errors.push(
      error("image_digest_required", `${path} must be pinned by sha256 digest`),
    );
  }
}

function requireSha256(errors, path, value) {
  requirePresent(errors, path, value);
  if (value === undefined || value === null || value === "") {
    return;
  }

  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    errors.push(
      error("sha256_required", `${path} must be a sha256 hex digest`),
    );
  }
}

function requireMinimumNumber(errors, path, value, minimum) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    errors.push(
      error("evidence_below_minimum", `${path} must be at least ${minimum}`),
    );
  }
}

function requireIsoDate(errors, path, value) {
  requirePresent(errors, path, value);
  if (value === undefined || value === null || value === "") {
    return;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    errors.push(error("invalid_timestamp", `${path} must be an ISO timestamp`));
  }
}

function requireTimestampAtOrAfter(
  errors,
  path,
  value,
  referencePath,
  referenceValue,
) {
  const timestamp = Date.parse(value);
  const referenceTimestamp = Date.parse(referenceValue);
  if (
    Number.isFinite(timestamp) &&
    Number.isFinite(referenceTimestamp) &&
    timestamp < referenceTimestamp
  ) {
    errors.push(
      error(
        "invalid_timestamp_order",
        `${path} must not predate ${referencePath}`,
      ),
    );
  }
}

function requireRclonePath(errors, path, value) {
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9._-]+:.+\/.+$/u.test(value) ||
    /[\r\n]/u.test(value)
  ) {
    errors.push(
      error(
        "invalid_remote_path",
        `${path} must be a newline-free rclone path`,
      ),
    );
  }
}

function requireHttpsUrl(errors, path, value, { trailingSlash = false } = {}) {
  requirePresent(errors, path, value);
  if (value === undefined || value === null || value === "") {
    return;
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    // error-policy:J3 URL parse failure becomes a typed validation error
    errors.push(error("invalid_url", `${path} must be a valid URL`));
    return;
  }

  if (url.protocol !== "https:") {
    errors.push(error("https_required", `${path} must use https://`));
  }

  if (trailingSlash && !String(value).endsWith("/")) {
    errors.push(error("trailing_slash_required", `${path} must end with /`));
  }
}

function hostFromHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.hostname : null;
  } catch {
    // error-policy:J3 unparseable URL has no host; callers treat null as
    // invalid
    return null;
  }
}

function toIso(value) {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
