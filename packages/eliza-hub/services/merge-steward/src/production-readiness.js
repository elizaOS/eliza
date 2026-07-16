import {
  buildGithubParityMatrix,
  GITHUB_PARITY_PATH,
} from "./github-parity.js";
import {
  PRODUCTION_GATE_CHECKS,
  runProductionGate,
} from "./production-gate.js";

export const PRODUCTION_READINESS_PATH = "/api/production-readiness";
export const PRODUCTION_CUTOVER_PATH = "/api/production-cutover";

export const PRODUCTION_READINESS_STATUS = Object.freeze({
  DEMO_READY: "demo_ready",
  BLOCKED: "blocked_until_private_evidence_passes",
  PRODUCTION_READY: "production_ready",
});

export const PRODUCTION_CUTOVER_STATUS = Object.freeze({
  BLOCKED: "blocked",
  READY: "ready_for_cutover",
});

const LAUNCH_DOMAINS = Object.freeze([
  {
    id: "domain_tls",
    title: "Domain, TLS, and reverse proxy",
    evidenceBlock: "domain",
    helper:
      "FORGEJO_REVERSE_PROXY_REVIEWED=true node services/merge-steward/src/cli.js domain-evidence https://git.example.invalid/",
    helperSteps: [
      {
        id: "capture_domain_probe_artifact",
        command:
          "FORGEJO_REVERSE_PROXY_REVIEWED=true node services/merge-steward/src/cli.js domain-evidence https://git.example.invalid/ > $ELIZA_ARTIFACT_ROOT/domain-evidence.json",
        produces: "$ELIZA_ARTIFACT_ROOT/domain-evidence.json",
        description:
          "Record the live HTTPS, TLS, canonical ROOT_URL, and reverse-proxy review probe as retained domain evidence.",
      },
      {
        id: "assemble_domain_probe_summary",
        command:
          "node deployment/hetzner-staging/scripts/production-evidence-assemble.mjs --template deployment/hetzner-staging/release/production-evidence.example.json --out $ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json $ELIZA_ARTIFACT_ROOT/domain-evidence.json",
        requires: ["$ELIZA_ARTIFACT_ROOT/domain-evidence.json"],
        produces: "domain.probeEvidence",
        description:
          "Preserve the retained domain probe source path, SHA-256 digest, timestamp, status, and check count in production evidence.",
      },
    ],
    surfaces: ["forgejo_root", "reverse_proxy", "canonical_root_url"],
    requiredEvidence: [
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
    ],
    nextAction:
      "Probe the live HTTPS forge root and record reverse-proxy review before accepting production traffic.",
  },
  {
    id: "sso_registration",
    title: "Eliza Cloud SSO and registration lock",
    evidenceBlock: "sso",
    helper: "node deployment/hetzner-staging/scripts/sso-evidence.mjs",
    helperSteps: [
      {
        id: "verify_forgejo_identity_bootstrap",
        command:
          "APPLY_BOOTSTRAP=false deployment/hetzner-staging/scripts/bootstrap-forgejo-identity.sh",
        produces:
          "$ELIZA_ARTIFACT_ROOT/eliza-hub-identity-bootstrap-evidence.json",
        description:
          "Verify the live Forgejo recovery admin, Eliza Cloud discovery document, OIDC auth source drift, and steward token owner without printing secrets.",
      },
      {
        id: "capture_sso_smoke_artifact",
        command:
          "node deployment/hetzner-staging/scripts/sso-smoke-evidence.mjs",
        produces: "$ELIZA_ARTIFACT_ROOT/sso-smoke.json",
        description:
          "Record timestamped live human, agent, service, registration-lock, issuer-restriction, and recovery-admin smoke evidence without printing OIDC secrets.",
      },
      {
        id: "generate_sso_production_evidence",
        command:
          "node deployment/hetzner-staging/scripts/sso-evidence.mjs --smoke-json $ELIZA_ARTIFACT_ROOT/sso-smoke.json --identity-bootstrap-json $ELIZA_ARTIFACT_ROOT/eliza-hub-identity-bootstrap-evidence.json",
        requires: [
          "$ELIZA_ARTIFACT_ROOT/sso-smoke.json",
          "$ELIZA_ARTIFACT_ROOT/eliza-hub-identity-bootstrap-evidence.json",
        ],
        produces: "$ELIZA_ARTIFACT_ROOT/eliza-hub-sso-evidence.json",
        description:
          "Convert private Eliza Cloud OIDC config, retained smoke artifact, and read-only Forgejo identity bootstrap receipt into the production-gate sso evidence block.",
      },
    ],
    surfaces: [
      "eliza_cloud_oidc",
      "forgejo_auth_source",
      "human_identity",
      "agent_identity",
      "service_identity",
      "local_recovery_admin",
    ],
    requiredEvidence: [
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
    ],
    nextAction:
      "Run read-only Forgejo identity bootstrap verification, then complete live Eliza Cloud human, agent, and service identity smoke tests with retained artifact provenance and public registration disabled.",
  },
  {
    id: "backup_restore",
    title: "Encrypted off-host backups and restore proof",
    evidenceBlock: "backups",
    helper: "node deployment/hetzner-staging/scripts/backup-evidence.mjs",
    helperSteps: [
      {
        id: "create_local_backup_bundle",
        command: "deployment/hetzner-staging/scripts/backup.sh",
        produces: "$BACKUP_DIR",
        description:
          "Create the checksummed Postgres, Forgejo data, configuration, package, attachment, and LFS backup bundle.",
        requires: [],
      },
      {
        id: "upload_encrypted_offsite_backup",
        command:
          'deployment/hetzner-staging/scripts/backup-offsite.sh --backup-dir "$BACKUP_DIR" --apply',
        produces: "$ELIZA_ARTIFACT_ROOT/eliza-hub-backup-offsite-receipt.json",
        description:
          "Stream the verified bundle through age, upload immutable ciphertext, and download-hash the remote object.",
        requires: ["$BACKUP_DIR"],
      },
      {
        id: "verify_offsite_recovery",
        command:
          'deployment/hetzner-staging/scripts/restore-offsite-check.sh --receipt-remote "$BACKUP_OFFSITE_REMOTE_RECEIPT" --expected-receipt-sha256 "$BACKUP_OFFSITE_EXPECTED_RECEIPT_SHA256" --apply',
        produces:
          "$ELIZA_ARTIFACT_ROOT/eliza-hub-backup-offsite-restore-receipt.json",
        description:
          "Match a separately supplied upload receipt digest, then independently download, decrypt, path-check, and structurally validate the off-site backup.",
        requires: [
          "$ELIZA_ARTIFACT_ROOT/eliza-hub-backup-offsite-receipt.json",
        ],
      },
      {
        id: "generate_backup_production_evidence",
        command:
          'node deployment/hetzner-staging/scripts/backup-evidence.mjs --backup-dir "$BACKUP_DIR" --offsite-upload-receipt "$ELIZA_ARTIFACT_ROOT/eliza-hub-backup-offsite-receipt.json" --offsite-restore-receipt "$ELIZA_ARTIFACT_ROOT/eliza-hub-backup-offsite-restore-receipt.json"',
        produces: "$ELIZA_ARTIFACT_ROOT/backup-audit.json",
        description:
          "Cross-check the local bundle and both cryptographic receipts into the production backup evidence block.",
        requires: [
          "$BACKUP_DIR",
          "$ELIZA_ARTIFACT_ROOT/eliza-hub-backup-offsite-receipt.json",
          "$ELIZA_ARTIFACT_ROOT/eliza-hub-backup-offsite-restore-receipt.json",
        ],
      },
    ],
    surfaces: [
      "repositories",
      "database",
      "attachments",
      "packages",
      "lfs",
      "configuration",
    ],
    requiredEvidence: [
      "backups.scheduled",
      "backups.offHost",
      "backups.encrypted",
      "backups.backupEvidence",
      "backups.backupEvidence.source",
      "backups.backupEvidence.sha256",
      "backups.backupEvidence.offsiteUploadReceipt",
      "backups.backupEvidence.offsiteUploadReceipt.source",
      "backups.backupEvidence.offsiteUploadReceipt.sha256",
      "backups.backupEvidence.offsiteUploadReceipt.remoteArchive",
      "backups.backupEvidence.offsiteUploadReceipt.ciphertextSha256",
      "backups.backupEvidence.offsiteUploadReceipt.encryptionFormat",
      "backups.backupEvidence.offsiteUploadReceipt.recipientsFileSha256",
      "backups.backupEvidence.offsiteUploadReceipt.verificationMethod",
      "backups.backupEvidence.offsiteRestoreReceipt",
      "backups.backupEvidence.offsiteRestoreReceipt.source",
      "backups.backupEvidence.offsiteRestoreReceipt.sha256",
      "backups.backupEvidence.offsiteRestoreReceipt.uploadReceiptSha256",
      "backups.backupEvidence.offsiteRestoreReceipt.downloadVerified",
      "backups.backupEvidence.offsiteRestoreReceipt.decryptionVerified",
      "backups.backupEvidence.offsiteRestoreReceipt.structuralRestoreCheckPassed",
      "backups.lastBackupAt",
      "backups.lastRestoreCheckAt",
      "backups.includes",
    ],
    nextAction:
      "Create a checksummed backup, upload age-encrypted ciphertext off host, independently download/decrypt/validate it, and retain both cryptographic receipts in backup evidence.",
  },
  {
    id: "database_migration",
    title: "Postgres migration and empty-host restore drill",
    evidenceBlock: "database",
    helper: "node deployment/hetzner-staging/scripts/database-evidence.mjs",
    surfaces: [
      "forgejo_postgres",
      "merge_steward_postgres",
      "schema_migrations",
    ],
    requiredEvidence: [
      "database.databaseEvidence",
      "database.databaseEvidence.source",
      "database.databaseEvidence.sha256",
      "database.databaseEvidence.migrationOutputSha256",
      "database.databaseEvidence.restoreDrillOutputSha256",
      "database.forgejoPostgres",
      "database.stewardPostgres",
      "database.migrationsApplied",
      "database.emptyHostRestoreDrillPassed",
      "database.checksumDriftClean",
    ],
    nextAction:
      "Deploy both stores on Postgres, apply migrations, pass an empty-host restore drill, and retain the database audit artifact plus migration and restore-drill log digests.",
  },
  {
    id: "image_provenance",
    title: "Digest-pinned image provenance",
    evidenceBlock: "imageProvenance",
    helper:
      "node deployment/hetzner-staging/scripts/image-provenance-evidence.mjs",
    surfaces: ["forgejo_image", "steward_image", "runner_image", "dind_image"],
    requiredEvidence: [
      "imageProvenance.forgejoImage",
      "imageProvenance.stewardImage",
      "imageProvenance.runnerImage",
      "imageProvenance.dindImage",
      "imageProvenance.provenanceEvidence",
      "imageProvenance.provenanceEvidence.source",
      "imageProvenance.provenanceEvidence.sha256",
      "imageProvenance.stewardImageBuiltByCi",
      "imageProvenance.stewardImageSignatureVerified",
      "imageProvenance.sbomGenerated",
      "imageProvenance.vulnerabilityScanClean",
    ],
    nextAction:
      "Pin every runtime image by sha256 digest and attach retained image provenance artifact evidence for CI build, signature, SBOM, and scan attestations.",
  },
  {
    id: "runner_isolation",
    title: "Isolated trusted runner pool",
    evidenceBlock: "runner",
    helper: "deployment/hetzner-staging/scripts/runner-evidence.sh",
    surfaces: [
      "forgejo_actions_runner",
      "docker_in_docker",
      "trusted_smoke_workflow",
    ],
    requiredEvidence: [
      "runner.smokeEvidence",
      "runner.auditEvidence",
      "runner.isolated",
      "runner.noHostDockerSocket",
      "runner.noHostLabels",
      "runner.registrationTested",
      "runner.trustedSmokeWorkflowPassed",
      "runner.egressReviewed",
      "runner.secretExposureReviewed",
    ],
    nextAction:
      "Register the isolated runner, pass the trusted smoke workflow, and record smoke plus audit artifact provenance with egress and secret-exposure review.",
  },
  {
    id: "repository_protection",
    title: "Protected branches and required checks",
    evidenceBlock: "repository",
    helper:
      "node deployment/hetzner-staging/scripts/repository-evidence.mjs --require-live",
    surfaces: [
      "protected_branches",
      "required_checks",
      "fork_policy",
      "admin_bypass_policy",
    ],
    requiredEvidence: [
      "repository.protectedBranches",
      "repository.requiredChecks",
      "repository.forkPolicyReviewed",
      "repository.actionsPolicyReviewed",
      "repository.adminBypassReviewed",
      "repository.liveProtectionEvidence",
      "repository.liveProtectionEvidence.source",
      "repository.liveProtectionEvidence.sha256",
    ],
    nextAction:
      "Verify branch protection and required checks through the live repository-protection audit, then retain the local audit artifact and digest.",
  },
  {
    id: "github_migration_rehearsal",
    title: "GitHub migration rehearsal",
    evidenceBlock: "githubMigration",
    helper:
      "node deployment/hetzner-staging/scripts/pilot-bootstrap.mjs --apply",
    helperSteps: [
      {
        id: "plan_github_migration_bootstrap",
        command:
          "PILOT_BOOTSTRAP_DRY_RUN=true node deployment/hetzner-staging/scripts/pilot-bootstrap.mjs",
        produces:
          "$ELIZA_ARTIFACT_ROOT/eliza-hub-pilot-bootstrap-evidence.json",
        description:
          "Preview the GitHub-to-Eliza Hub mirror, webhook, branch protection, steward policy, trusted agent identities, and pilot product surfaces without mutation.",
      },
      {
        id: "apply_github_migration_bootstrap",
        command:
          "node deployment/hetzner-staging/scripts/pilot-bootstrap.mjs --apply",
        produces:
          "$ELIZA_ARTIFACT_ROOT/eliza-hub-pilot-bootstrap-evidence.json",
        description:
          "Create or verify the private pull mirror from GitHub, steward webhook, required branch checks, repo policy, trusted agent identities, and pilot surfaces.",
      },
      {
        id: "assemble_github_migration_evidence",
        command:
          "node deployment/hetzner-staging/scripts/production-evidence-assemble.mjs --out $ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json $ELIZA_ARTIFACT_ROOT/eliza-hub-pilot-bootstrap-evidence.json",
        requires: [
          "$ELIZA_ARTIFACT_ROOT/eliza-hub-pilot-bootstrap-evidence.json",
        ],
        produces: "githubMigration.pilotBootstrapEvidence",
        description:
          "Preserve the applied pilot bootstrap receipt path, SHA-256 digest, timestamp, GitHub upstream host, step counts, and migration guardrail booleans in production evidence.",
      },
    ],
    surfaces: [
      "github_pull_mirror",
      "forgejo_webhook",
      "branch_protection",
      "steward_repo_policy",
      "trusted_agent_identities",
      "pilot_product_surfaces",
    ],
    requiredEvidence: [
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
    ],
    nextAction:
      "Run the applied private pilot bootstrap against the live Forgejo and steward, retain the non-secret receipt, and assemble it into production evidence before GitHub cutover.",
  },
  {
    id: "secret_management",
    title: "Secret issuance and rotation policy",
    evidenceBlock: "secrets",
    helper:
      "node deployment/hetzner-staging/scripts/secret-management-evidence.mjs",
    surfaces: ["app_ini", "runner_registration", "oauth", "webhook_tokens"],
    requiredEvidence: [
      "secrets.secretEvidence",
      "secrets.secretEvidence.source",
      "secrets.secretEvidence.sha256",
      "secrets.externalSecretStore",
      "secrets.rotationPolicyDocumented",
      "secrets.appIniSecretsIssued",
      "secrets.runnerTokenIssued",
      "secrets.oauthSecretsIssued",
      "secrets.webhookSecretsIssued",
      "secrets.noPlaintextSecretsCommitted",
    ],
    nextAction:
      "Issue production secrets from an external store, record rotation policy review, and retain the non-secret secret-management audit artifact plus digest.",
  },
  {
    id: "mail_notifications",
    title: "Mail and account notification smoke tests",
    evidenceBlock: "mail",
    helper: "node deployment/hetzner-staging/scripts/mail-evidence.mjs",
    surfaces: ["smtp", "invites", "password_reset", "notifications"],
    requiredEvidence: [
      "mail.mailEvidence",
      "mail.mailEvidence.source",
      "mail.mailEvidence.sha256",
      "mail.smtpConfigured",
      "mail.inviteSmokePassed",
      "mail.passwordResetSmokePassed",
      "mail.notificationSmokePassed",
    ],
    nextAction:
      "Configure SMTP, pass invite/password reset/notification smoke tests, and retain the mail smoke audit artifact plus digest.",
  },
  {
    id: "storage_retention",
    title: "Storage sizing and retention",
    evidenceBlock: "storage",
    helper: "node deployment/hetzner-staging/scripts/storage-evidence.mjs",
    surfaces: ["artifacts", "packages", "lfs", "logs"],
    requiredEvidence: [
      "storage.storageEvidence",
      "storage.storageEvidence.source",
      "storage.storageEvidence.sha256",
      "storage.sizingReviewed",
      "storage.artifactRetentionConfigured",
      "storage.packageRetentionConfigured",
      "storage.lfsCapacityReviewed",
      "storage.logRetentionConfigured",
    ],
    nextAction:
      "Set artifact/package/log retention, review capacity for mirrored repos and LFS, and retain the storage retention audit artifact plus digest.",
  },
  {
    id: "observability",
    title: "Metrics, logs, alerts, and paging",
    evidenceBlock: "observability",
    helper:
      "node deployment/hetzner-staging/scripts/observability-evidence.mjs",
    surfaces: ["prometheus", "alertmanager", "logs", "page_alerts"],
    requiredEvidence: [
      "observability.observabilityEvidence",
      "observability.observabilityEvidence.source",
      "observability.observabilityEvidence.sha256",
      "observability.prometheusScrapeOk",
      "observability.alertRulesLoaded",
      "observability.alertRoutingConfigured",
      "observability.logsCollected",
      "observability.logRetentionDays",
      "observability.noPageAlertsFiring",
    ],
    nextAction:
      "Verify Prometheus scraping, alert routing, log retention, and no active page alerts, then retain the observability audit artifact plus digest.",
  },
  {
    id: "steward_runtime",
    title: "Merge Steward production runtime",
    evidenceBlock: "steward",
    helper: "node deployment/hetzner-staging/scripts/steward-evidence.mjs",
    surfaces: [
      "production_preflight",
      "deployment_doctor",
      "oidc_control_api",
      "bot_permissions",
      "agent_identities",
      "agent_branch_namespaces",
      "signed_agent_run_receipts",
    ],
    requiredEvidence: [
      "steward.preflight",
      "steward.doctor",
      "steward.preflightEvidence",
      "steward.doctorEvidence",
      "steward.readyProductionMode",
      "steward.labelMirroringTested",
      "steward.botTokenPermissionsReviewed",
      "steward.strictWorkReservationsEnforced",
      "steward.strictWorkItemsEnforced",
      "steward.strictAgentBranchNamespacesEnforced",
      "steward.verifiedAgentRunReceiptsEnforced",
      "steward.agentIdentityRegistryEnforced",
    ],
    nextAction:
      "Run production preflight and deployment doctor against the live steward, then review label mirroring, bot token scope, strict work-reservation enforcement, durable Work-item enforcement, strict agent branch namespaces, signed agent run receipts, and the allowed-agent identity registry.",
  },
  {
    id: "merge_queue_rollout",
    title: "Staged merge queue rollout",
    evidenceBlock: "mergeQueueRollout",
    helper:
      "node deployment/hetzner-staging/scripts/merge-queue-rollout-evidence.mjs",
    surfaces: [
      "dry_run_drill",
      "staged_live_drill",
      "worker_lease",
      "strict_work_reservations",
      "strict_work_items",
      "agent_identities",
      "agent_branch_namespaces",
      "signed_agent_run_receipts",
      "stack_dependency_order",
      "rollback",
    ],
    requiredEvidence: [
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
      "mergeQueueRollout.liveDrillEvidence",
    ],
    nextAction:
      "Complete dry-run and staged live drills with worker lease proof, strict work-reservation, durable Work-item links, allowed-agent registry, branch namespace, signed run receipt, stack dependency ordering, rollback, and human approval proof.",
  },
  {
    id: "security_review",
    title: "Launch security review",
    evidenceBlock: "securityReview",
    helper:
      "node deployment/hetzner-staging/scripts/security-review-evidence.mjs",
    surfaces: ["auth", "tokens", "runner_execution", "repo_permissions"],
    requiredEvidence: [
      "securityReview.securityEvidence",
      "securityReview.securityEvidence.source",
      "securityReview.securityEvidence.sha256",
      "securityReview.authReviewed",
      "securityReview.tokensReviewed",
      "securityReview.runnerExecutionReviewed",
      "securityReview.repoPermissionsReviewed",
      "securityReview.approvedBy",
      "securityReview.approvedAt",
    ],
    nextAction:
      "Record final human security approval for auth, tokens, runner execution, and repo permissions, then retain the security review audit artifact plus digest.",
  },
  {
    id: "deployment_verification",
    title: "Applied deploy and post-deploy receipt",
    evidenceBlock: "deployment",
    helper:
      "DEPLOY_MODE=first-boot deployment/hetzner-staging/scripts/deploy.sh --apply",
    helperSteps: [
      {
        id: "run_applied_deploy",
        command:
          "DEPLOY_MODE=first-boot deployment/hetzner-staging/scripts/deploy.sh --apply",
        produces: "$ELIZA_ARTIFACT_ROOT/eliza-hub-deploy-evidence.json",
        description:
          "Run the selected first-boot or rolling deploy path against the target host and write the deploy receipt outside Git.",
      },
      {
        id: "capture_post_deploy_receipt",
        command: "deployment/hetzner-staging/scripts/post-deploy-check.sh",
        produces: "$ELIZA_ARTIFACT_ROOT/eliza-hub-post-deploy-evidence.json",
        description:
          "Record the retained post-deploy API, health, readiness, theme, doctor, and safe rollout verification receipt.",
      },
      {
        id: "assemble_deployment_evidence",
        command:
          "node deployment/hetzner-staging/scripts/production-evidence-assemble.mjs --out $ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json $ELIZA_ARTIFACT_ROOT/eliza-hub-deploy-evidence.json",
        requires: [
          "$ELIZA_ARTIFACT_ROOT/eliza-hub-deploy-evidence.json",
          "$ELIZA_ARTIFACT_ROOT/eliza-hub-post-deploy-evidence.json",
        ],
        produces: "deployment.deployEvidence and deployment.postDeployEvidence",
        description:
          "Preserve deploy and post-deploy receipt source paths, SHA-256 digests, timestamps, status, and check counts in production evidence.",
      },
    ],
    surfaces: [
      "deploy_orchestrator",
      "post_deploy_verifier",
      "health_readiness",
      "product_api_smoke",
    ],
    requiredEvidence: [
      "deployment.deployEvidence",
      "deployment.deployEvidence.source",
      "deployment.deployEvidence.sha256",
      "deployment.deployEvidence.checkedAt",
      "deployment.deployEvidence.status",
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
      "deployment.applied",
      "deployment.postDeployVerified",
    ],
    nextAction:
      "Run an applied first-boot or rolling deploy on the target host, keep the deploy and post-deploy JSON receipts, and assemble them into the private production evidence file.",
  },
]);

const ASSEMBLY_COMMANDS = Object.freeze([
  "node deployment/hetzner-staging/scripts/production-evidence-inventory.mjs --strict",
  "node deployment/hetzner-staging/scripts/production-evidence-assemble.mjs",
  'node services/merge-steward/src/cli.js production-gate --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"',
  'node services/merge-steward/src/cli.js github-parity --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"',
]);

const CUTOVER_PHASES = Object.freeze([
  {
    id: "foundation",
    title: "Platform foundation",
    domainIds: [
      "domain_tls",
      "database_migration",
      "image_provenance",
      "backup_restore",
      "storage_retention",
    ],
  },
  {
    id: "identity_and_access",
    title: "Identity, secrets, and access",
    domainIds: ["sso_registration", "secret_management", "mail_notifications"],
  },
  {
    id: "runner_and_repository",
    title: "Runner, repository, migration, and observability",
    domainIds: [
      "runner_isolation",
      "repository_protection",
      "github_migration_rehearsal",
      "observability",
    ],
  },
  {
    id: "steward_and_merge_queue",
    title: "Steward runtime and merge queue rollout",
    domainIds: ["steward_runtime", "merge_queue_rollout"],
  },
  {
    id: "final_security_review",
    title: "Final security review",
    domainIds: ["security_review", "deployment_verification"],
  },
]);

export function buildProductionReadiness({
  generatedAt = new Date().toISOString(),
  evidence = null,
  productionGate = null,
} = {}) {
  const evaluatedGate =
    productionGate ??
    (evidence
      ? runProductionGate({
          evidence,
          now: generatedAt ? new Date(generatedAt) : new Date(),
        })
      : null);
  const domains = annotateDomains(
    domainsWithAuthoritativeEvidence(),
    evaluatedGate,
  );
  const missingGateChecks = PRODUCTION_GATE_CHECKS.filter(
    (check) => !domains.some((domain) => domain.id === check),
  );
  const summary = summarizeLaunchDomains(domains, evaluatedGate);
  const productionReady = evaluatedGate?.ok === true;

  return {
    schema: "https://eliza.hub/schemas/production-readiness.v1",
    checklistVersion: 1,
    generatedAt,
    status: productionReady
      ? PRODUCTION_READINESS_STATUS.PRODUCTION_READY
      : PRODUCTION_READINESS_STATUS.BLOCKED,
    currentUse: productionReady
      ? PRODUCTION_READINESS_STATUS.PRODUCTION_READY
      : PRODUCTION_READINESS_STATUS.DEMO_READY,
    productionReady,
    privateEvidenceRequired: true,
    privateEvidenceEvaluated: Boolean(evaluatedGate),
    authoritativeGate: {
      command:
        'node services/merge-steward/src/cli.js production-gate --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"',
      schema: "services/merge-steward/production-evidence.schema.json",
      template:
        "deployment/hetzner-staging/release/production-evidence.example.json",
      gateChecks: [...PRODUCTION_GATE_CHECKS],
      missingChecklistEntries: missingGateChecks,
      gateSummary: evaluatedGate?.summary ?? null,
      evidenceShape: evaluatedGate?.evidenceShape ?? null,
      extraChecks: evaluatedGate
        ? evaluatedGate.checks.filter(
            (check) => !PRODUCTION_GATE_CHECKS.includes(check.name),
          )
        : [],
    },
    assembly: {
      commands: [...ASSEMBLY_COMMANDS],
      note: "Generate private evidence fragments, assemble them locally, then run the production gate. Do not commit live evidence or secrets.",
    },
    summary,
    domains,
    nextActions: domains
      .filter((domain) => domain.status !== "passed")
      .map((domain) => ({
        id: domain.id,
        status: domain.status,
        helper: domain.helper,
        helperSteps: domain.helperSteps,
        nextAction: domain.nextAction,
        missingEvidence:
          domain.gateCheck?.errors?.map((error) => error.message) ??
          domain.requiredEvidence,
      })),
  };
}

export function buildProductionReadinessSummary() {
  const readiness = buildProductionReadiness({ generatedAt: null });

  return {
    status: readiness.status,
    currentUse: readiness.currentUse,
    checklistVersion: readiness.checklistVersion,
    link: PRODUCTION_READINESS_PATH,
    productionReady: readiness.productionReady,
    privateEvidenceRequired: readiness.privateEvidenceRequired,
    summary: readiness.summary,
    requiredEvidenceBlocks: readiness.domains.map(
      (domain) => domain.evidenceBlock,
    ),
    gateChecks: readiness.authoritativeGate.gateChecks,
  };
}

export function buildProductionCutoverPlan({
  generatedAt = new Date().toISOString(),
  evidence = null,
  productionGate = null,
  productionReadiness = null,
} = {}) {
  const evaluatedGate =
    productionGate ??
    (evidence
      ? runProductionGate({
          evidence,
          now: generatedAt ? new Date(generatedAt) : new Date(),
        })
      : null);
  const readiness =
    productionReadiness ??
    buildProductionReadiness({
      generatedAt,
      evidence,
      productionGate: evaluatedGate,
    });
  const githubParity = buildGithubParityMatrix({
    generatedAt,
    evidence: evidence ? evidence : null,
    productionGate: evaluatedGate,
  });
  const githubMigration = compactGithubMigration(githubParity);
  const phases = CUTOVER_PHASES.map((phase) =>
    cutoverPhase(phase, readiness.domains),
  );
  const blockedPhases = phases.filter((phase) => phase.status !== "passed");
  const nextPhase = blockedPhases[0] ?? null;
  const orderedSteps = cutoverSteps(phases);
  const productionReady =
    readiness.productionReady === true && githubMigration.cutoverReady === true;

  return {
    schema: "https://eliza.hub/schemas/production-cutover-plan.v1",
    planVersion: 1,
    generatedAt,
    readOnly: true,
    status: productionReady
      ? PRODUCTION_CUTOVER_STATUS.READY
      : PRODUCTION_CUTOVER_STATUS.BLOCKED,
    productionReady,
    privateEvidenceRequired: readiness.privateEvidenceRequired === true,
    privateEvidenceEvaluated: readiness.privateEvidenceEvaluated === true,
    nextPhase: nextPhase ? compactPhasePointer(nextPhase) : null,
    summary: {
      totalPhases: phases.length,
      passedPhases: phases.filter((phase) => phase.status === "passed").length,
      blockedPhases: blockedPhases.length,
      totalDomains: readiness.summary.totalDomains,
      passedDomains: readiness.summary.passedDomains,
      blockedDomains: readiness.summary.blockedDomains,
      gatePassed: readiness.summary.gatePassed === true,
      githubMigrationCutoverReady: githubMigration.cutoverReady === true,
      githubMigrationBlockedSurfaces: githubMigration.blockedSurfaces,
      githubMigrationReadySurfaces: githubMigration.readySurfaces,
      evidenceBlocks: readiness.summary.evidenceBlocks,
    },
    guardrails: {
      mutatesState: false,
      storesPrivateEvidence: false,
      liveAgentMergesAllowed: productionReady,
      githubMigrationReady: githubMigration.cutoverReady === true,
      liveAgentMergeRequires: [
        "production_cutover_status_ready_for_cutover",
        "github_parity_cutover_ready",
        "retained_private_evidence_artifacts",
        "release_gate_production_mode_passed",
        "human_security_approval",
      ],
      finalGate: readiness.authoritativeGate.command,
    },
    githubMigration,
    phases,
    executionPlan: {
      orderedSteps,
      assemblyCommands: readiness.assembly.commands,
      finalVerificationCommands: [
        'RELEASE_GATE_MODE=production PRODUCTION_EVIDENCE_FILE="$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json" deployment/hetzner-staging/scripts/release-gate.sh',
        'node services/merge-steward/src/cli.js github-parity --strict < "$ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json"',
        "deployment/hetzner-staging/scripts/post-deploy-check.sh",
      ],
    },
    links: {
      githubParity: GITHUB_PARITY_PATH,
      productionReadiness: PRODUCTION_READINESS_PATH,
      productionCutover: PRODUCTION_CUTOVER_PATH,
      workflows: "/api/workflows",
      releaseReadiness: "/api/release-readiness",
      repositoryProtection: "/api/repository-protection",
      mergeTrain: "/api/merge-train",
      discovery: "/.well-known/eliza-hub.json",
      openapi: "/openapi.json",
    },
    labels: cutoverLabels({ productionReady, phases, githubMigration }),
  };
}

function annotateDomains(domains, productionGate) {
  if (!productionGate) {
    return domains.map((domain) => ({
      ...domain,
      status: "blocked",
      gateCheck: null,
    }));
  }

  const checksByName = new Map(
    productionGate.checks.map((check) => [check.name, check]),
  );

  return domains.map((domain) => {
    const check = checksByName.get(domain.id);
    return {
      ...domain,
      status: check?.ok === true ? "passed" : "blocked",
      gateCheck: check
        ? {
            ok: check.ok === true,
            status: check.status,
            evidence: check.evidence ?? [],
            errorCount: Array.isArray(check.errors) ? check.errors.length : 0,
            errors: check.errors ?? [],
          }
        : {
            ok: false,
            status: "missing",
            evidence: [],
            errorCount: 1,
            errors: [
              {
                code: "missing_gate_check",
                message: `${domain.id} is missing from the production gate`,
              },
            ],
          },
    };
  });
}

function domainsWithAuthoritativeEvidence() {
  const evidenceByCheck = productionGateEvidenceByCheck();

  return LAUNCH_DOMAINS.map((domain) => ({
    ...cloneObject(domain),
    helperSteps: helperStepsForDomain(domain),
    requiredEvidence: evidenceByCheck.get(domain.id) ?? [
      ...domain.requiredEvidence,
    ],
  }));
}

function helperStepsForDomain(domain) {
  const explicitSteps = Array.isArray(domain.helperSteps)
    ? domain.helperSteps.map((step) => ({
        ...cloneObject(step),
        requires: Array.isArray(step.requires) ? [...step.requires] : [],
      }))
    : [];

  if (explicitSteps.length > 0) return explicitSteps;

  return [
    {
      id: `${domain.id}_evidence`,
      command: domain.helper,
      produces: domain.evidenceBlock,
      description: domain.nextAction,
      requires: [],
    },
  ];
}

function productionGateEvidenceByCheck() {
  return new Map(
    runProductionGate({
      evidence: {},
      now: new Date("1970-01-01T00:00:00.000Z"),
    }).checks.map((check) => [check.name, [...check.evidence]]),
  );
}

function summarizeLaunchDomains(domains, productionGate) {
  const passedDomains = domains
    .filter((domain) => domain.status === "passed")
    .map((domain) => domain.id);
  const blockedDomains = domains
    .filter((domain) => domain.status !== "passed")
    .map((domain) => domain.id);
  const extraChecks =
    productionGate?.checks?.filter(
      (check) => !PRODUCTION_GATE_CHECKS.includes(check.name),
    ) ?? [];
  const failedExtraChecks = extraChecks
    .filter((check) => !check.ok)
    .map((check) => check.name);
  const productionReady = productionGate?.ok === true;

  return {
    totalDomains: domains.length,
    gateChecks: PRODUCTION_GATE_CHECKS.length,
    evidenceBlocks: domains.map((domain) => domain.evidenceBlock),
    passedDomains,
    blockedDomains,
    privateEvidenceEvaluated: Boolean(productionGate),
    gatePassed: productionReady,
    failedExtraChecks,
    productPosition: productionReady
      ? "Production evidence passes the hard gate; proceed only with retained private artifacts and deployment approval."
      : "Demo-ready locally; production launch remains blocked until private evidence passes the production gate.",
  };
}

function cutoverPhase(phase, domains) {
  const phaseDomains = phase.domainIds
    .map((id) => domains.find((domain) => domain.id === id))
    .filter(Boolean);
  const blockedDomains = phaseDomains.filter(
    (domain) => domain.status !== "passed",
  );

  return {
    id: phase.id,
    title: phase.title,
    status: blockedDomains.length === 0 ? "passed" : "blocked",
    domainIds: phase.domainIds,
    blockers: blockedDomains.map((domain) => domain.id),
    domains: phaseDomains.map(compactCutoverDomain),
    nextActions: blockedDomains.map((domain) => ({
      id: domain.id,
      helper: domain.helper,
      helperSteps: domain.helperSteps,
      evidenceBlock: domain.evidenceBlock,
      nextAction: domain.nextAction,
      missingEvidence: missingEvidenceForDomain(domain),
    })),
  };
}

function compactCutoverDomain(domain) {
  return {
    id: domain.id,
    title: domain.title,
    status: domain.status,
    evidenceBlock: domain.evidenceBlock,
    helper: domain.helper,
    helperSteps: domain.helperSteps,
    surfaces: domain.surfaces,
    requiredEvidence: domain.requiredEvidence,
    missingEvidence: missingEvidenceForDomain(domain),
    gateCheck: domain.gateCheck
      ? {
          ok: domain.gateCheck.ok === true,
          status: domain.gateCheck.status,
          errorCount: domain.gateCheck.errorCount,
        }
      : null,
  };
}

function cutoverSteps(phases) {
  return phases.flatMap((phase) =>
    phase.domains
      .filter((domain) => domain.status !== "passed")
      .map((domain) => ({
        phaseId: phase.id,
        domainId: domain.id,
        title: domain.title,
        helper: domain.helper,
        helperSteps: domain.helperSteps,
        evidenceBlock: domain.evidenceBlock,
        requiredEvidence: domain.requiredEvidence,
        missingEvidence: domain.missingEvidence,
        verification:
          "Attach the generated private evidence fragment, assemble $ELIZA_ARTIFACT_ROOT/eliza-hub-production-evidence.json, then rerun the strict production gate.",
      })),
  );
}

function compactPhasePointer(phase) {
  return {
    id: phase.id,
    title: phase.title,
    status: phase.status,
    blockers: phase.blockers,
    firstAction: phase.nextActions[0] ?? null,
  };
}

function compactGithubMigration(matrix) {
  const summary = matrix.summary ?? {};
  return {
    status: summary.cutoverReady === true ? "ready" : "blocked",
    link: GITHUB_PARITY_PATH,
    matrixVersion: matrix.matrixVersion ?? null,
    githubDropInReplacement: false,
    migrationMode:
      summary.githubMigrationMode ??
      "surface_by_surface_with_agent_native_replacements",
    privateEvidenceEvaluated: summary.privateEvidenceEvaluated === true,
    productionGatePassed: summary.productionGatePassed === true,
    cutoverReady: summary.cutoverReady === true,
    readySurfaceCount: summary.readySurfaceCount ?? 0,
    blockedSurfaceCount: summary.blockedCutoverSurfaceCount ?? 0,
    readySurfaces: summary.readySurfaceIds ?? [],
    blockedSurfaces: summary.blockedCutoverSurfaceIds ?? [],
    cutoverBlockerSurfaces: summary.cutoverBlockerSurfaceIds ?? [],
    acceptedGapSurfaces: summary.acceptedGapSurfaceIds ?? [],
  };
}

function missingEvidenceForDomain(domain) {
  const errors = domain.gateCheck?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((error) => error.message).filter(Boolean);
  }
  return [...domain.requiredEvidence];
}

function cutoverLabels({ productionReady, phases, githubMigration }) {
  const labels = [
    productionReady ? "production-cutover:ready" : "production-cutover:blocked",
  ];
  labels.push(
    githubMigration?.cutoverReady === true
      ? "github-migration:ready"
      : "github-migration:blocked",
  );
  for (const phase of phases) {
    labels.push(`${phase.id}:${phase.status}`);
  }
  return labels;
}

function cloneObject(value) {
  return JSON.parse(JSON.stringify(value));
}
