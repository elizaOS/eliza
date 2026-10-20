import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
