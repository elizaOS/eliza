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

// Categories describe evidence only. They never relax the release evaluator.
function serviceImageClass(evidence: ResilienceEvidence, serviceId: string) {
  const matches = evidence.services.filter(
    (service) => service.id === serviceId,
  );
  if (matches.length !== 1) return "service_missing_or_ambiguous";
  const image = matches[0].source?.image;
  if (typeof image !== "string" || image.length === 0) return "image_missing";
  if (/^(?:[^\s]+\/)?postgres[^:@\s]*@sha256:[a-f0-9]{64}$/.test(image))
    return "postgres_digest_pinned";
  if (/(?:^|\/)postgres[^:]*:18(?:$|[-.])/.test(image))
    return "postgres18_tag_matches_release_gate";
  if (/(?:^|\/)postgres[^:]*:[0-9]+(?:$|[-.])/.test(image))
    return "other_postgres_major_tag";
  return "unrecognized_image_metadata";
}
function observedBoolean(value: unknown) {
  return typeof value === "boolean" ? value : null;
}
function majorCategory(value: unknown) {
  return value === "18" || value === "other" ? value : "unavailable";
}
function liveProbeCategory(live: Record<string, unknown>) {
  const reason = live.unavailableReason;
  // Exact pinned Railway 5.38.0 preflight text; arbitrary provider text is never returned.
  if (
    reason ===
    "no SSH keys found in your SSH agent or ~/.ssh/\n\ngenerate one with `ssh-keygen -t ed25519`, then register it with `railway ssh keys add`"
  )
    return "ssh_key_unavailable";
  if (
    typeof reason === "string" &&
    /^probe timed out after [0-9]+s$/.test(reason)
  )
    return "probe_timeout";
  if (live.available !== true) return "unavailable_or_unknown";
  if (reason !== undefined) return "inconsistent_available_evidence";
  if (live.backupCoverageError !== undefined) return "backup_coverage_error";
  if (live.archiverError !== undefined) return "archiver_probe_error";
  return "available";
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
    diagnostics: {
      serviceImage: serviceImageClass(input.evidence, input.expected.serviceId),
      postgresMajor: {
        canonical: majorCategory(
          object(object(input.authorityAudit).postgresMajor).canonical,
        ),
        protected: majorCategory(
          object(object(input.authorityAudit).postgresMajor).protected,
        ),
      },
      pitrEnabled: observedBoolean(input.evidence.pitr.enabled),
      bucketWired: observedBoolean(input.evidence.pitr.bucketWired),
      blockersPresent: Array.isArray(input.evidence.pitr.blockers)
        ? input.evidence.pitr.blockers.length > 0
        : null,
      blockerKinds: Array.isArray(input.evidence.pitr.blockers)
        ? {
            unsupportedImage: input.evidence.pitr.blockers.includes(
              "Image is not an official Railway Postgres image -- PITR is not supported.",
            ),
            minorVersionPinned: input.evidence.pitr.blockers.includes(
              "Image is pinned to a minor version -- unpin to the major tag (e.g. `:16`) before enabling PITR.",
            ),
            customStartCommand: input.evidence.pitr.blockers.includes(
              "A custom start command overrides the entrypoint that turns on WAL archiving -- clear it before enabling PITR.",
            ),
            unknown: input.evidence.pitr.blockers.some(
              (value) =>
                ![
                  "Image is not an official Railway Postgres image -- PITR is not supported.",
                  "Image is pinned to a minor version -- unpin to the major tag (e.g. `:16`) before enabling PITR.",
                  "A custom start command overrides the entrypoint that turns on WAL archiving -- clear it before enabling PITR.",
                ].includes(value),
            ),
          }
        : null,
      liveProbe: liveProbeCategory(live),
    },
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
