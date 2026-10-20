/** Read-only protected backup evidence. Never starts a backup, restore, or database connection. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ResilienceEvidence,
  type ResilienceExpectation,
  verifyRailwayPostgresResilience,
} from "./preflight-railway-postgres-resilience";

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export function fixedUtcTarget(value: string, now: Date): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value))
    throw Error("invalid_fixed_utc_target");
  const time = Date.parse(value);
  if (
    !Number.isFinite(time) ||
    new Date(time).toISOString() !== value.replace("Z", ".000Z") ||
    time > now.getTime()
  )
    throw Error("invalid_fixed_utc_target");
  return time;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function timestamp(value: unknown) {
  if (typeof value !== "string") return NaN;
  // The pinned CLI emits RFC3339 backup times and PostgreSQL archiver times.
  const normalized = value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const parts =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(
      normalized,
    );
  if (!parts) return NaN;
  const calendar = new Date(
    Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])),
  );
  if (
    calendar.getUTCFullYear() !== Number(parts[1]) ||
    calendar.getUTCMonth() + 1 !== Number(parts[2]) ||
    calendar.getUTCDate() !== Number(parts[3]) ||
    Number(parts[4]) > 23 ||
    Number(parts[5]) > 59 ||
    Number(parts[6]) > 59
  )
    return NaN;
  return Date.parse(normalized);
}

export function productionBackupReadiness(input: {
  evidence: ResilienceEvidence;
  expected: ResilienceExpectation;
  authorityAudit: unknown;
  targetUtc: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const target = fixedUtcTarget(input.targetUtc, now);
  if (input.expected.environment !== "production")
    throw Error("production_evidence_required");
  const resilience = verifyRailwayPostgresResilience(
    input.evidence,
    input.expected,
    now,
  );
  const authority = object(object(input.authorityAudit).checks);
  const live = object(object(input.evidence.pitr).live);
  const backup = timestamp(live.latestBackupAt);
  const archived = timestamp(live.archiverLastArchivedAt);
  const ceiling = timestamp(live.maxRestoreTime);
  const walMin = typeof live.walMin === "string" ? live.walMin : "";
  const walMax = typeof live.walMax === "string" ? live.walMax : "";
  const checks = {
    protectedAuthorityMatches:
      authority.railwayTarget === "match" &&
      authority.protectedDatabaseAuthority === "match",
    resilienceEnforced: resilience.verdict === "pass",
    liveProbeAvailable:
      live.available === true && live.unavailableReason === undefined,
    backupProbeComplete:
      live.backupCoverageError === undefined &&
      typeof live.backupSetCount === "number" &&
      Number.isSafeInteger(live.backupSetCount) &&
      Number(live.backupSetCount) > 0,
    archiverHealthy:
      live.archiverError === undefined && live.archiverHealthy === true,
    observedWalRange:
      /^[A-F0-9]{24}$/.test(walMin) &&
      /^[A-F0-9]{24}$/.test(walMax) &&
      walMin.slice(0, 8) === walMax.slice(0, 8) &&
      walMin <= walMax,
    targetAfterObservedBackup: Number.isFinite(backup) && backup <= target,
    targetBeforeObservedCeiling:
      Number.isFinite(ceiling) && target <= ceiling && ceiling <= now.getTime(),
    targetBeforeLastArchive:
      Number.isFinite(archived) &&
      target <= archived &&
      archived <= now.getTime(),
  };
  return {
    schemaVersion: 1,
    purpose: "read_only_restore_candidate" as const,
    gateMode: "enforce" as const,
    verdict: Object.values(checks).every(Boolean) ? "pass" : "fail",
    checks,
    resilienceChecks: resilience.checks,
    receipts: { ...resilience.receipts, targetUtc: hash(input.targetUtc) },
    // CLI coverage is explicitly best-effort, not an archive continuity proof.
    archiveContinuityProven: false,
    restoreProven: false,
    productionMigrationReady: false,
  };
}

if (import.meta.main) {
  try {
    const directory = process.env.BACKUP_EVIDENCE_DIR;
    if (!directory) throw Error("evidence_required");
    const digests: Record<string, string> = {};
    const read = (name: string) => {
      const bytes = readFileSync(join(directory, name));
      if (bytes.length > 2 * 1024 * 1024) throw Error("evidence_too_large");
      digests[name] = hash(bytes.toString("utf8"));
      return JSON.parse(bytes.toString("utf8"));
    };
    const serviceId = readFileSync(
      join(directory, "resolved-service-id"),
      "utf8",
    ).trim();
    const report = productionBackupReadiness({
      evidence: {
        status: read("status.json"),
        services: read("services.json"),
        volumes: read("volumes.json"),
        pitr: read("pitr.json"),
        schedules: read("schedules.json"),
        backups: read("backups.json"),
      },
      authorityAudit: read("report.json"),
      targetUtc: process.env.RESTORE_TARGET_UTC ?? "",
      expected: {
        environment: "production",
        projectId: process.env.RAILWAY_PROJECT_ID ?? "",
        environmentId: process.env.RAILWAY_ENVIRONMENT_ID ?? "",
        serviceId,
        maxBackupAgeHours: Number(
          process.env.DATABASE_RESILIENCE_MAX_BACKUP_AGE_HOURS ?? "36",
        ),
      },
    });
    console.log(
      JSON.stringify({ ...report, privateEvidenceSha256: digests }, null, 2),
    );
    if (report.verdict !== "pass") process.exitCode = 1;
  } catch {
    // error-policy:J1 no provider errors, resource IDs, customer rows or raw timestamps leave the process.
    console.log(
      JSON.stringify({
        schemaVersion: 1,
        purpose: "read_only_restore_candidate",
        gateMode: "enforce",
        verdict: "fail",
        failure: "private_evidence_invalid_or_unavailable",
        restoreProven: false,
        productionMigrationReady: false,
      }),
    );
    process.exitCode = 1;
  }
}
