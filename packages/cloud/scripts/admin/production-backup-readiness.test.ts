import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pitrProvisioningPlan } from "./pitr-provisioning-plan";
import type {
  ResilienceEvidence,
  ResilienceExpectation,
} from "./preflight-railway-postgres-resilience";
import {
  fixedUtcTarget,
  productionBackupReadiness,
} from "./production-backup-readiness";

function fixture() {
  const projectId = "10000000-0000-0000-0000-000000000001";
  const environmentId = "10000000-0000-0000-0000-000000000002";
  const serviceId = "10000000-0000-0000-0000-000000000003";
  return {
    expected: {
      environment: "production" as const,
      projectId,
      environmentId,
      serviceId,
      maxBackupAgeHours: 36,
    },
    targetUtc: "2026-10-19T21:00:00Z",
    now: new Date("2026-10-19T22:00:00Z"),
    authorityAudit: {
      postgresMajor: { canonical: "18", protected: "18" },
      checks: { railwayTarget: "match", protectedDatabaseAuthority: "match" },
    },
    evidence: {
      status: {
        id: projectId,
        environments: {
          edges: [{ node: { id: environmentId, name: "production" } }],
        },
        services: { edges: [{ node: { id: serviceId } }] },
      },
      services: [
        {
          id: serviceId,
          source: { image: "ghcr.io/railwayapp-templates/postgres-ssl:18" },
          volumes: [
            {
              name: "private-volume",
              mountPath: "/var/lib/postgresql/data",
              sizeMb: 1024,
              state: "READY",
            },
          ],
        },
      ],
      volumes: {
        data: {
          environment: {
            id: environmentId,
            volumeInstances: {
              edges: [
                {
                  node: {
                    id: "10000000-0000-0000-0000-000000000004",
                    volumeId: "10000000-0000-0000-0000-000000000005",
                    environmentId,
                    serviceId,
                    mountPath: "/var/lib/postgresql/data",
                    state: "READY",
                    sizeMB: 1024,
                    deletedAt: null,
                    isPendingDeletion: false,
                  },
                },
              ],
            },
          },
        },
      },
      pitr: {
        service: { id: serviceId },
        environment: { id: environmentId },
        root: { id: serviceId },
        enabled: true,
        bucketWired: true,
        blockers: [],
        live: {
          available: true,
          backupSetCount: 2,
          latestBackupAt: "2026-10-19T20:00:00+00:00",
          walMin: "000000010000000000000001",
          walMax: "000000010000000000000004",
          archiverHealthy: true,
          archiverLastArchivedAt: "2026-10-19 21:30:00.123456+00",
          maxRestoreTime: "2026-10-19 21:20:00+00",
        },
      },
      schedules: [
        { id: "private-daily", kind: "DAILY", retentionSeconds: 604800 },
        { id: "private-weekly", kind: "WEEKLY", retentionSeconds: 2419200 },
      ],
      backups: [
        {
          id: "private-backup",
          scheduleId: "private-daily",
          createdAt: "2026-10-19T20:00:00Z",
        },
      ],
    },
  };
}

test("pinned CLI timestamp formats yield only a candidate, never restore or migration authority", () => {
  const input = fixture();
  const report = productionBackupReadiness(input);
  expect(report.verdict).toBe("pass");
  expect(report.gateMode).toBe("enforce");
  expect(report.restoreProven).toBe(false);
  expect(report.archiveContinuityProven).toBe(false);
  expect(report.productionMigrationReady).toBe(false);
  const text = JSON.stringify(report);
  for (const privateValue of [
    input.expected.serviceId,
    input.expected.projectId,
    input.expected.environmentId,
    input.targetUtc,
    "private-backup",
    input.evidence.pitr.live.walMin,
  ])
    expect(text).not.toContain(privateValue);
});

test("unavailable, malformed, contradictory and unhealthy provider observations fail closed without raw messages", () => {
  for (const patch of [
    { available: false, unavailableReason: "PRIVATE_SSH_ERROR" },
    { backupCoverageError: "PRIVATE_BUCKET_ERROR" },
    { archiverError: "PRIVATE_DATABASE_ERROR" },
    { archiverHealthy: false },
    { backupSetCount: 0 },
    { latestBackupAt: "2026-10-19T21:30:00Z" },
    { latestBackupAt: "2026-02-30T01:00:00Z" },
    { maxRestoreTime: "2026-10-19T20:30:00Z" },
    { maxRestoreTime: "2027-01-01T00:00:00Z" },
    { archiverLastArchivedAt: "garbage" },
    { walMax: "000000020000000000000004" },
    { walMin: "000000010000000000000005" },
  ]) {
    const input = fixture();
    Object.assign(input.evidence.pitr.live, patch);
    const report = productionBackupReadiness(input);
    expect(report.verdict).toBe("fail");
    expect(JSON.stringify(report)).not.toContain("PRIVATE_");
  }
});

test("wrong authority, backup age, volume identity and disabled PITR cannot pass", () => {
  const authority = fixture();
  authority.authorityAudit.checks.protectedDatabaseAuthority = "mismatch";
  expect(productionBackupReadiness(authority).verdict).toBe("fail");
  const stale = fixture();
  stale.evidence.backups[0].createdAt = "2026-10-01T00:00:00Z";
  expect(productionBackupReadiness(stale).verdict).toBe("fail");
  const volume = fixture();
  volume.evidence.volumes.data.environment.volumeInstances.edges[0].node.serviceId =
    "10000000-0000-0000-0000-000000000099";
  expect(productionBackupReadiness(volume).verdict).toBe("fail");
  const disabled = fixture();
  disabled.evidence.pitr.enabled = false;
  expect(productionBackupReadiness(disabled).verdict).toBe("fail");
  for (const target of [
    "30m",
    "2026-02-30T00:00:00Z",
    "2026-10-19 21:00:00Z",
    "2027-01-01T00:00:00Z",
    "2026-10-19T21:00:00+00:00",
  ])
    expect(() => fixedUtcTarget(target, fixture().now)).toThrow(
      "invalid_fixed_utc_target",
    );
});

test("CLI scrubs malformed private evidence and exits unsuccessfully", () => {
  const directory = mkdtempSync(join(tmpdir(), "backup-readiness-"));
  try {
    writeFileSync(join(directory, "resolved-service-id"), "PRIVATE_SERVICE_ID");
    writeFileSync(
      join(directory, "status.json"),
      "PRIVATE_TOKEN_AND_CUSTOMER_VALUE",
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        new URL("./production-backup-readiness.ts", import.meta.url).pathname,
      ],
      { env: { BACKUP_EVIDENCE_DIR: directory } },
    );
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    const output = new TextDecoder().decode(result.stdout);
    expect(output).not.toContain("PRIVATE_");
    expect(JSON.parse(output).failure).toBe(
      "private_evidence_invalid_or_unavailable",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("separates actual PG18 from image metadata and PITR prerequisites without exposing private failures", () => {
  const input = fixture();
  input.evidence.services[0].source.image =
    "private-registry/private-image:private-tag";
  input.evidence.pitr.enabled = false;
  input.evidence.pitr.bucketWired = false;
  const pitr = input.evidence.pitr as Record<string, unknown>;
  pitr.blockers = [
    "Image is not an official Railway Postgres image -- PITR is not supported.",
    "private-provider-blocker",
  ];
  pitr.live = {
    available: false,
    unavailableReason:
      "no SSH keys found in your SSH agent or ~/.ssh/\n\ngenerate one with `ssh-keygen -t ed25519`, then register it with `railway ssh keys add`",
  };
  const report = productionBackupReadiness(input);
  expect(report.diagnostics).toEqual({
    serviceImage: "unrecognized_image_metadata",
    postgresMajor: { canonical: "18", protected: "18" },
    pitrEnabled: false,
    bucketWired: false,
    blockersPresent: true,
    blockerKinds: {
      unsupportedImage: true,
      minorVersionPinned: false,
      customStartCommand: false,
      unknown: true,
    },
    liveProbe: "ssh_key_unavailable",
  });
  expect(report.checks.protectedAuthorityMatches).toBe(true);
  expect(report.resilienceChecks.exactPostgres18Service).toBe(false);
  expect(report.verdict).toBe("fail");
  for (const privateText of [
    "private-registry",
    "private-image",
    "private-tag",
    "private-provider-blocker",
    "ssh-keygen",
  ])
    expect(JSON.stringify(report)).not.toContain(privateText);
  pitr.live = {
    available: false,
    unavailableReason: "private failure with token and resource",
  };
  expect(productionBackupReadiness(input).diagnostics.liveProbe).toBe(
    "unavailable_or_unknown",
  );
  expect(JSON.stringify(productionBackupReadiness(input))).not.toContain(
    "private failure",
  );
  pitr.enabled = "private-invalid-boolean";
  pitr.bucketWired = null;
  pitr.blockers = "private-invalid-blockers";
  const malformed = productionBackupReadiness(input);
  expect(malformed.diagnostics.pitrEnabled).toBeNull();
  expect(malformed.diagnostics.bucketWired).toBeNull();
  expect(malformed.diagnostics.blockersPresent).toBeNull();
  expect(malformed.diagnostics.blockerKinds).toBeNull();
  expect(malformed.verdict).toBe("fail");
});

test("finite diagnostic categories cannot turn missing or contradictory evidence into readiness", () => {
  const input = fixture();
  for (const [image, expected] of [
    [`postgres@sha256:${"a".repeat(64)}`, "postgres_digest_pinned"],
    ["postgres:17", "other_postgres_major_tag"],
    ["", "image_missing"],
  ]) {
    input.evidence.services[0].source.image = image;
    const report = productionBackupReadiness(input);
    expect(report.diagnostics.serviceImage).toBe(expected);
    expect(report.verdict).toBe("fail");
    expect(report.productionMigrationReady).toBe(false);
  }
  input.evidence.services.push(input.evidence.services[0]);
  expect(productionBackupReadiness(input).diagnostics.serviceImage).toBe(
    "service_missing_or_ambiguous",
  );
  for (const [live, category] of [
    [
      { available: false, unavailableReason: "probe timed out after 30s" },
      "probe_timeout",
    ],
    [
      { available: true, unavailableReason: "private contradiction" },
      "inconsistent_available_evidence",
    ],
    [
      { available: true, backupCoverageError: "private backup" },
      "backup_coverage_error",
    ],
    [
      { available: true, archiverError: "private archiver" },
      "archiver_probe_error",
    ],
  ] as const) {
    (input.evidence.pitr as Record<string, unknown>).live = live;
    const report = productionBackupReadiness(input);
    expect(report.diagnostics.liveProbe).toBe(category);
    expect(report.verdict).toBe("fail");
    expect(JSON.stringify(report)).not.toContain("private contradiction");
  }
});

test("CLI publishes split diagnostics from private fixture files without publishing raw values", () => {
  const directory = mkdtempSync(join(tmpdir(), "backup-diagnostics-"));
  try {
    const input = fixture();
    input.evidence.services[0].source.image = "PRIVATE_IMAGE";
    input.evidence.pitr.enabled = false;
    (input.evidence.pitr as Record<string, unknown>).live = {
      available: false,
      unavailableReason: "PRIVATE_ERROR_WITH_TOKEN",
    };
    for (const [name, value] of Object.entries(input.evidence))
      writeFileSync(join(directory, `${name}.json`), JSON.stringify(value));
    writeFileSync(
      join(directory, "report.json"),
      JSON.stringify(input.authorityAudit),
    );
    writeFileSync(
      join(directory, "resolved-service-id"),
      input.expected.serviceId,
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        new URL("./production-backup-readiness.ts", import.meta.url).pathname,
      ],
      {
        env: {
          BACKUP_EVIDENCE_DIR: directory,
          RAILWAY_PROJECT_ID: input.expected.projectId,
          RAILWAY_ENVIRONMENT_ID: input.expected.environmentId,
          RESTORE_TARGET_UTC: "2020-01-01T00:00:00Z",
        },
      },
    );
    const output = new TextDecoder().decode(result.stdout);
    expect(result.exitCode).toBe(1);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(output).not.toContain("PRIVATE_");
    expect(output).not.toContain(input.expected.serviceId);
    const report = JSON.parse(output);
    expect(report.diagnostics.postgresMajor.canonical).toBe("18");
    expect(report.diagnostics.serviceImage).toBe("unrecognized_image_metadata");
    expect(report.diagnostics.pitrEnabled).toBe(false);
    expect(report.diagnostics.liveProbe).toBe("unavailable_or_unknown");
    expect(report.productionMigrationReady).toBe(false);
    expect(report.privateEvidenceSha256["pitr.json"]).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only an independently approved exact digest and matching live PG18 authority can replace tag admission", () => {
  const input = fixture();
  const evidence: ResilienceEvidence = input.evidence;
  const expected: ResilienceExpectation = input.expected;
  const image = `ghcr.io/railwayapp-templates/postgres-ssl@sha256:${"a".repeat(64)}`;
  input.evidence.services[0].source.image = image;
  expect(
    productionBackupReadiness(input).resilienceChecks.exactPostgres18Service,
  ).toBe(false);
  const receipt = createHash("sha256").update(image).digest("hex");
  expected.approvedImageSha256 = receipt;
  evidence.imageAuthority = {
    projectId: expected.projectId,
    environmentId: expected.environmentId,
    serviceId: expected.serviceId,
    imageSha256: receipt,
    canonicalPostgresMajor: "18",
    protectedPostgresMajor: "18",
    protectedAuthorityMatches: true,
  };
  const evaluate = () =>
    productionBackupReadiness({ ...input, evidence, expected });
  expect(evaluate().resilienceChecks.exactPostgres18Service).toBe(true);
  for (const patch of [
    { serviceId: "another-service" },
    { environmentId: "another-environment" },
    { projectId: "another-project" },
    { imageSha256: "b".repeat(64) },
    { canonicalPostgresMajor: "other" as const },
    { protectedPostgresMajor: "unavailable" as const },
    { protectedAuthorityMatches: false },
  ]) {
    const good: NonNullable<ResilienceEvidence["imageAuthority"]> =
      evidence.imageAuthority;
    evidence.imageAuthority = { ...good, ...patch };
    expect(evaluate().resilienceChecks.exactPostgres18Service).toBe(false);
    evidence.imageAuthority = good;
  }
  input.evidence.services[0].source.image = "postgres:18";
  expect(evaluate().resilienceChecks.exactPostgres18Service).toBe(false);
  input.evidence.services[0].source.image = image.replace(
    "a".repeat(64),
    "c".repeat(64),
  );
  expect(evaluate().resilienceChecks.exactPostgres18Service).toBe(false);
  input.evidence.services[0].source.image = image;
  input.evidence.pitr.enabled = false;
  expect(evaluate().resilienceChecks.exactPostgres18Service).toBe(true);
  expect(evaluate().verdict).toBe("fail");
  expect(evaluate().productionMigrationReady).toBe(false);
  expected.approvedImageSha256 = "malformed";
  expect(evaluate).toThrow();
});

function planFixture() {
  const input = fixture();
  input.evidence.services[0].source.image = `ghcr.io/railwayapp-templates/postgres-ssl@sha256:${"a".repeat(64)}`;
  (input.evidence.pitr as Record<string, unknown>).isHaCluster = false;
  (input.evidence.backups[0] as Record<string, unknown>).expiresAt = null;
  return {
    ...input,
    baseline: {
      data: {
        environment: {
          id: input.expected.environmentId,
          config: {
            services: {
              [input.expected.serviceId]: {
                source: { image: input.evidence.services[0].source.image },
                variables: {
                  PRIVATE_CREDENTIAL_NAME: { value: "PRIVATE_ENCRYPTED_VALUE" },
                },
              },
            },
          },
        },
      },
    },
    staged: {
      data: {
        environmentStagedChanges: {
          id: "PRIVATE_PATCH",
          status: "PENDING",
          patch: {} as Record<string, unknown>,
        },
      },
    },
    template: {
      data: {
        template: {
          id: "PRIVATE_TEMPLATE",
          serializedConfig: {
            services: {
              root: {
                variables: {
                  WAL_ARCHIVE_BUCKET: { value: "PRIVATE_BUCKET_REFERENCE" },
                },
              },
            },
            buckets: { archive: { name: "PRIVATE_BUCKET" } },
          },
        },
      },
    },
  };
}

test("read-only provisioning plan binds existing resources and reports effects without enabling changes", () => {
  const input = planFixture();
  const report = pitrProvisioningPlan(input);
  expect(report.observationVerdict).toBe("reviewable");
  expect(report.observations.templateServiceCount).toBe(1);
  expect(report.observations.templateBucketCount).toBe(1);
  expect(report.observations.templateDeclaresWalArchiveBucket).toBe(true);
  expect(report.stageCreatesResources).toBe(true);
  expect(report.atomicStagedCommitAvailable).toBe(false);
  expect(report.provisioningEnabled).toBe(false);
  expect(report.productionMutationPerformed).toBe(false);
  expect(report.restoreProven).toBe(false);
  expect(report.backupCompletionProven).toBe(false);
  expect(report.templateEffects[0].variables[0].name).toBe(
    "WAL_ARCHIVE_BUCKET",
  );
  expect(JSON.stringify(report)).not.toContain("PRIVATE_");
  expect(JSON.stringify(report)).not.toContain(input.expected.serviceId);
  expect(report.receipts.observedImage).toMatch(/^[a-f0-9]{64}$/);
  for (const change of [
    (f: ReturnType<typeof planFixture>) => {
      f.staged.data.environmentStagedChanges.patch = {
        services: { foreign: { variables: { PRIVATE: "secret" } } },
      };
    },
    (f: ReturnType<typeof planFixture>) => {
      (f.evidence.pitr as Record<string, unknown>).isHaCluster = true;
    },
    (f: ReturnType<typeof planFixture>) => {
      f.baseline.data.environment.id = "wrong-environment";
    },
    (f: ReturnType<typeof planFixture>) => {
      (f.evidence.backups[0] as Record<string, unknown>).expiresAt =
        "2026-10-19T21:00:00Z";
    },
    (f: ReturnType<typeof planFixture>) => {
      (
        f.template.data.template.serializedConfig.services.root as Record<
          string,
          unknown
        >
      ).source = { image: "PRIVATE_REPLACEMENT_IMAGE" };
    },
    (f: ReturnType<typeof planFixture>) => {
      (f.template as Record<string, unknown>).errors = [
        { message: "PRIVATE_ERROR" },
      ];
    },
  ]) {
    const drift = planFixture();
    change(drift);
    const rejected = pitrProvisioningPlan(drift);
    expect(rejected.observationVerdict).toBe("incomplete");
    expect(rejected.provisioningEnabled).toBe(false);
    expect(JSON.stringify(rejected)).not.toContain("PRIVATE_");
  }
});

test("plan CLI consumes private captures and never exposes their contents", () => {
  const directory = mkdtempSync(join(tmpdir(), "pitr-plan-"));
  try {
    const input = planFixture();
    for (const [name, value] of Object.entries(input.evidence))
      writeFileSync(join(directory, `${name}.json`), JSON.stringify(value));
    for (const name of ["baseline", "staged", "template"] as const)
      writeFileSync(
        join(directory, `pitr-plan-${name}.json`),
        JSON.stringify(input[name]),
      );
    writeFileSync(
      join(directory, "report.json"),
      JSON.stringify(input.authorityAudit),
    );
    writeFileSync(
      join(directory, "resolved-service-id"),
      input.expected.serviceId,
    );
    const run = () =>
      Bun.spawnSync(
        [
          process.execPath,
          "--no-env-file",
          new URL("./pitr-provisioning-plan.ts", import.meta.url).pathname,
        ],
        {
          env: {
            BACKUP_EVIDENCE_DIR: directory,
            RESTORE_TARGET_UTC: "2020-01-01T00:00:00Z",
            RAILWAY_PROJECT_ID: input.expected.projectId,
            RAILWAY_ENVIRONMENT_ID: input.expected.environmentId,
          },
        },
      );
    const result = run();
    const output = new TextDecoder().decode(result.stdout);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(output).not.toContain("PRIVATE_");
    expect(JSON.parse(output).provisioningEnabled).toBe(false);
    writeFileSync(
      join(directory, "pitr-plan-template.json"),
      "PRIVATE_BROKEN_TOKEN",
    );
    const failed = run();
    expect(failed.exitCode).toBe(1);
    expect(new TextDecoder().decode(failed.stderr)).toBe("");
    expect(JSON.parse(new TextDecoder().decode(failed.stdout)).failure).toBe(
      "private_plan_evidence_invalid_or_unavailable",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("plan retention is tied to the selected backup and never substitutes another retained entry", () => {
  const input = planFixture();
  const selected = input.evidence.backups[0] as Record<string, unknown>;
  selected.expiresAt = "2026-10-19T21:00:00Z";
  input.evidence.backups.push({
    ...input.evidence.backups[0],
    id: "PRIVATE_OTHER_BACKUP",
    createdAt: "2026-10-19T19:00:00Z",
    expiresAt: null,
  } as (typeof input.evidence.backups)[0]);
  expect(pitrProvisioningPlan(input).checks.freshRetainedScheduledBackup).toBe(
    false,
  );
  selected.expiresAt = null;
  input.evidence.backups.push(input.evidence.backups[0]);
  expect(pitrProvisioningPlan(input).checks.freshRetainedScheduledBackup).toBe(
    false,
  );
  const malformed = planFixture();
  Object.assign(
    malformed.template.data.template.serializedConfig.services.root.variables,
    {
      "PRIVATE_SECRET_WITH_NEWLINE\n": { value: "private-value" },
    },
  );
  expect(() => pitrProvisioningPlan(malformed)).toThrow(
    "template_variable_shape_not_reviewable",
  );
});
