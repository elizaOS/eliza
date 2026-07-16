export function completeEvidence() {
  return {
    domain: {
      forgejoRootUrl: "https://git.eliza.example/",
      forgejoDomain: "git.eliza.example",
      probeEvidence: {
        source: "/var/lib/eliza-hub-artifacts/domain-evidence.json",
        sha256:
          "1111111111111111111111111111111111111111111111111111111111111111",
        checkedAt: "2026-07-06T00:00:00.000Z",
        status: "ready",
        checkCount: 5,
      },
      tlsVerified: true,
      rootUrlCanonical: true,
      reverseProxyReviewed: true,
    },
    sso: {
      issuerUrl: "https://cloud.eliza.example",
      smokeEvidence: {
        source: "/var/lib/eliza-hub-artifacts/sso-smoke.json",
        sha256:
          "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        checkedAt: "2026-07-06T00:05:00.000Z",
      },
      bootstrapEvidence: {
        source:
          "/var/lib/eliza-hub-artifacts/eliza-hub-identity-bootstrap-evidence.json",
        sha256:
          "efefefefefefefefefefefefefefefefefefefefefefefefefefefefefefefef",
        checkedAt: "2026-07-06T00:04:00.000Z",
        status: "passed",
        checkCount: 8,
      },
      oidcProviderStaged: true,
      forgejoOidcSourceConfigured: true,
      smokeTested: true,
      humanIdentitySmokePassed: true,
      agentIdentitySmokePassed: true,
      serviceIdentitySmokePassed: true,
      publicRegistrationLocked: true,
      autoCreateRestrictedToIssuer: true,
      recoveryAdminVerified: true,
    },
    backups: {
      scheduled: true,
      offHost: true,
      encrypted: true,
      backupEvidence: {
        source: "/var/lib/eliza-hub-artifacts/backup-audit.json",
        sha256:
          "3333333333333333333333333333333333333333333333333333333333333333",
        checkedAt: "2026-07-06T00:31:00.000Z",
        status: "verified",
        productionReady: true,
        backupCreatedAt: "2026-07-06T00:00:00.000Z",
        restoreCheckedAt: "2026-07-06T00:30:00.000Z",
        componentCount: 6,
        checkCount: 10,
        offsiteUploadReceipt: {
          source:
            "/var/lib/eliza-hub-artifacts/eliza-hub-backup-offsite-receipt.json",
          sha256:
            "3434343434343434343434343434343434343434343434343434343434343434",
          checkedAt: "2026-07-06T00:10:00.000Z",
          status: "verified",
          backupName: "eliza-forgejo-production-20260706T000000Z",
          backupCreatedAt: "2026-07-06T00:00:00.000Z",
          remoteArchive:
            "r2:eliza-hub-backups/production/eliza-forgejo-production-20260706T000000Z/eliza-forgejo-production-20260706T000000Z.tar.gz.age",
          remoteReceipt:
            "r2:eliza-hub-backups/production/eliza-forgejo-production-20260706T000000Z/receipt.json",
          ciphertextSha256:
            "3535353535353535353535353535353535353535353535353535353535353535",
          ciphertextBytes: 1048576,
          encryptionFormat: "age",
          recipientsFileSha256:
            "3737373737373737373737373737373737373737373737373737373737373737",
          verificationMethod: "download_sha256",
          verified: true,
        },
        offsiteRestoreReceipt: {
          source:
            "/var/lib/eliza-hub-artifacts/eliza-hub-backup-offsite-restore-receipt.json",
          sha256:
            "3636363636363636363636363636363636363636363636363636363636363636",
          checkedAt: "2026-07-06T00:30:00.000Z",
          status: "verified",
          remoteArchive:
            "r2:eliza-hub-backups/production/eliza-forgejo-production-20260706T000000Z/eliza-forgejo-production-20260706T000000Z.tar.gz.age",
          remoteReceipt:
            "r2:eliza-hub-backups/production/eliza-forgejo-production-20260706T000000Z/receipt.json",
          uploadReceiptSha256:
            "3434343434343434343434343434343434343434343434343434343434343434",
          ciphertextSha256:
            "3535353535353535353535353535353535353535353535353535353535353535",
          ciphertextBytes: 1048576,
          downloadVerified: true,
          decryptionVerified: true,
          archivePathsVerified: true,
          structuralRestoreCheckPassed: true,
          verified: true,
        },
      },
      lastBackupAt: "2026-07-06T00:00:00.000Z",
      lastRestoreCheckAt: "2026-07-06T00:30:00.000Z",
      includes: [
        "repositories",
        "database",
        "attachments",
        "packages",
        "lfs",
        "configuration",
      ],
    },
    database: {
      databaseEvidence: {
        source: "/var/lib/eliza-hub-artifacts/database-audit.json",
        sha256:
          "2222222222222222222222222222222222222222222222222222222222222222",
        checkedAt: "2026-07-06T00:32:00.000Z",
        status: "verified",
        productionReady: true,
        migrationOutputSource:
          "/var/lib/eliza-hub-artifacts/merge-steward-migrate.log",
        migrationOutputSha256:
          "5555555555555555555555555555555555555555555555555555555555555555",
        restoreDrillOutputSource:
          "/var/lib/eliza-hub-artifacts/restore-drill.log",
        restoreDrillOutputSha256:
          "6666666666666666666666666666666666666666666666666666666666666666",
        checkCount: 5,
        verifiedTableCount: 6,
      },
      forgejoPostgres: true,
      stewardPostgres: true,
      migrationsApplied: true,
      emptyHostRestoreDrillPassed: true,
      checksumDriftClean: true,
    },
    imageProvenance: {
      forgejoImage:
        "codeberg.org/forgejo/forgejo@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      stewardImage:
        "registry.eliza.example/eliza/merge-steward@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      runnerImage:
        "data.forgejo.org/forgejo/runner@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      dindImage:
        "docker.io/library/docker@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      provenanceEvidence: {
        source: "/var/lib/eliza-hub-artifacts/image-provenance-audit.json",
        sha256:
          "4444444444444444444444444444444444444444444444444444444444444444",
        checkedAt: "2026-07-06T00:01:00.000Z",
        imageCount: 4,
        checkCount: 5,
      },
      stewardImageBuiltByCi: true,
      stewardImageSignatureVerified: true,
      sbomGenerated: true,
      vulnerabilityScanClean: true,
    },
    runner: {
      smokeEvidence: {
        source:
          "/var/lib/eliza-hub-artifacts/eliza-hub-runner-smoke-evidence.json",
        sha256:
          "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        checkedAt: "2026-07-06T00:03:00.000Z",
        repository: "elizaos/eliza",
        workflow: "runner-smoke.yml",
        runId: 42,
        workflowRunUrl:
          "https://git.eliza.example/elizaos/eliza/actions/runs/42",
      },
      auditEvidence: {
        source:
          "/var/lib/eliza-hub-artifacts/eliza-hub-runner-isolation-audit.json",
        sha256:
          "9999999999999999999999999999999999999999999999999999999999999999",
        checkedAt: "2026-07-06T00:04:00.000Z",
        status: "isolated",
        checkCount: 11,
      },
      isolated: true,
      noHostDockerSocket: true,
      noHostLabels: true,
      registrationTested: true,
      trustedSmokeWorkflowPassed: true,
      egressReviewed: true,
      secretExposureReviewed: true,
    },
    repository: {
      protectedBranches: ["main"],
      requiredChecks: ["merge-steward"],
      forkPolicyReviewed: true,
      actionsPolicyReviewed: true,
      adminBypassReviewed: true,
      liveProtectionEvidence: {
        source: "/var/lib/eliza-hub-artifacts/repository-protection.json",
        sha256:
          "7777777777777777777777777777777777777777777777777777777777777777",
        checkedAt: "2026-07-06T00:20:00.000Z",
        status: "protected",
        productionReady: true,
        liveAvailable: true,
        liveRequired: true,
        checkCount: 8,
      },
    },
    githubMigration: {
      pilotBootstrapEvidence: {
        source:
          "/var/lib/eliza-hub-artifacts/eliza-hub-pilot-bootstrap-evidence.json",
        sha256:
          "1919191919191919191919191919191919191919191919191919191919191919",
        checkedAt: "2026-07-06T00:22:00.000Z",
        status: "passed",
        dryRun: false,
        repo: "elizaos/eliza",
        upstreamHost: "github.com",
        stepCount: 9,
        requiredCheckCount: 1,
        trustedAgentCount: 2,
      },
      pilotBootstrapPassed: true,
      mirrorVerified: true,
      defaultBranchVerified: true,
      webhookVerified: true,
      branchProtectionVerified: true,
      repoPolicyVerified: true,
      agentIdentitiesSynced: true,
      pilotSurfacesVerified: true,
      pullMirrorOnly: true,
    },
    secrets: {
      secretEvidence: {
        source: "/var/lib/eliza-hub-artifacts/secret-management-audit.json",
        sha256:
          "1212121212121212121212121212121212121212121212121212121212121212",
        checkedAt: "2026-07-06T00:25:00.000Z",
        status: "verified",
        productionReady: true,
        groupCount: 4,
        checkCount: 7,
      },
      externalSecretStore: true,
      rotationPolicyDocumented: true,
      appIniSecretsIssued: true,
      runnerTokenIssued: true,
      oauthSecretsIssued: true,
      webhookSecretsIssued: true,
      noPlaintextSecretsCommitted: true,
    },
    mail: {
      mailEvidence: {
        source: "/var/lib/eliza-hub-artifacts/mail-smoke-audit.json",
        sha256:
          "1313131313131313131313131313131313131313131313131313131313131313",
        checkedAt: "2026-07-06T00:26:00.000Z",
        status: "verified",
        productionReady: true,
        checkCount: 4,
      },
      smtpConfigured: true,
      inviteSmokePassed: true,
      passwordResetSmokePassed: true,
      notificationSmokePassed: true,
    },
    storage: {
      storageEvidence: {
        source: "/var/lib/eliza-hub-artifacts/storage-retention-audit.json",
        sha256:
          "1414141414141414141414141414141414141414141414141414141414141414",
        checkedAt: "2026-07-06T00:27:00.000Z",
        status: "verified",
        productionReady: true,
        checkCount: 5,
      },
      sizingReviewed: true,
      artifactRetentionConfigured: true,
      packageRetentionConfigured: true,
      lfsCapacityReviewed: true,
      logRetentionConfigured: true,
    },
    observability: {
      observabilityEvidence: {
        source: "/var/lib/eliza-hub-artifacts/observability-audit.json",
        sha256:
          "1515151515151515151515151515151515151515151515151515151515151515",
        checkedAt: "2026-07-06T00:28:00.000Z",
        status: "verified",
        productionReady: true,
        checkCount: 6,
      },
      prometheusScrapeOk: true,
      alertRulesLoaded: true,
      alertRoutingConfigured: true,
      logsCollected: true,
      logRetentionDays: 30,
      noPageAlertsFiring: true,
    },
    steward: {
      preflight: { ok: true, mode: "production", errors: [] },
      doctor: { ok: true },
      preflightEvidence: {
        source: "/var/lib/eliza-hub-artifacts/steward-preflight.json",
        sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        checkedAt: "2026-07-06T00:10:00.000Z",
        mode: "production",
        errorCount: 0,
      },
      doctorEvidence: {
        source: "/var/lib/eliza-hub-artifacts/steward-doctor.json",
        sha256:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        target: "https://steward.eliza.example",
        checkedAt: "2026-07-06T00:15:00.000Z",
        checkCount: 21,
      },
      readyProductionMode: true,
      labelMirroringTested: true,
      botTokenPermissionsReviewed: true,
      strictWorkReservationsEnforced: true,
      strictWorkItemsEnforced: true,
      strictAgentBranchNamespacesEnforced: true,
      verifiedAgentRunReceiptsEnforced: true,
      agentIdentityRegistryEnforced: true,
    },
    mergeQueueRollout: {
      dryRunPassed: true,
      stagedLiveDrillPassed: true,
      workerLeaseVerified: true,
      strictWorkReservationsEnforced: true,
      strictWorkItemsEnforced: true,
      strictAgentBranchNamespacesEnforced: true,
      verifiedAgentRunReceiptsEnforced: true,
      agentIdentityRegistryEnforced: true,
      stackDependencyOrderEnforced: true,
      rollbackDrillPassed: true,
      humanApprovalRecorded: true,
      dryRunEvidence: {
        source: "/var/lib/eliza-hub-artifacts/merge-queue-rollout-drill.json",
        sha256:
          "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        checkedAt: "2026-07-06T00:30:00.000Z",
        checkCount: 5,
      },
      liveDrillEvidence: {
        source: "/var/lib/eliza-hub-artifacts/merge-queue-live-drill.json",
        sha256:
          "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        checkedAt: "2026-07-06T00:45:00.000Z",
        runId: "run:elizaos/eliza#9001:attempt:1",
      },
    },
    securityReview: {
      securityEvidence: {
        source: "/var/lib/eliza-hub-artifacts/security-review-audit.json",
        sha256:
          "8888888888888888888888888888888888888888888888888888888888888888",
        checkedAt: "2026-07-06T01:00:00.000Z",
        status: "approved",
        productionReady: true,
        approvedBy: "eliza-security",
        approvedAt: "2026-07-06T01:00:00.000Z",
        checkCount: 6,
        reviewedSurfaceCount: 4,
      },
      authReviewed: true,
      tokensReviewed: true,
      runnerExecutionReviewed: true,
      repoPermissionsReviewed: true,
      approvedBy: "eliza-security",
      approvedAt: "2026-07-06T01:00:00.000Z",
    },
    deployment: {
      deployEvidence: {
        source: "/var/lib/eliza-hub-artifacts/eliza-hub-deploy-evidence.json",
        sha256:
          "1717171717171717171717171717171717171717171717171717171717171717",
        checkedAt: "2026-07-06T01:10:00.000Z",
        status: "passed",
        mode: "first-boot",
        dryRun: false,
        stepCount: 7,
        postDeployEvidenceSource:
          "/var/lib/eliza-hub-artifacts/eliza-hub-post-deploy-evidence.json",
        postDeployEvidenceSha256:
          "1818181818181818181818181818181818181818181818181818181818181818",
      },
      postDeployEvidence: {
        source:
          "/var/lib/eliza-hub-artifacts/eliza-hub-post-deploy-evidence.json",
        sha256:
          "1818181818181818181818181818181818181818181818181818181818181818",
        checkedAt: "2026-07-06T01:12:00.000Z",
        status: "passed",
        checkCount: 18,
        failedCount: 0,
        forgejoLocalUrl: "https://git.eliza.example/",
        stewardLocalUrl: "https://git.eliza.example/steward",
      },
      mode: "first-boot",
      applied: true,
      postDeployVerified: true,
    },
  };
}
