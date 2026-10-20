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
