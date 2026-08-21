/**
 * Validates Railway PostgreSQL recovery and staging-isolation evidence captured
 * by the protected Cloud release workflow. The command is read-only: Railway
 * CLI calls happen in the workflow, while this process consumes their JSON and
 * emits only boolean checks plus SHA-256 receipts.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const POSTGRES_MOUNT = "/var/lib/postgresql/data";

export type GateMode = "report" | "enforce";
export type TargetEnvironment = "staging" | "production";

interface ResourceRef {
  id?: unknown;
  name?: unknown;
}

interface StatusDocument {
  id?: unknown;
  environments?: { edges?: Array<{ node?: ResourceRef }> };
  services?: { edges?: Array<{ node?: ResourceRef }> };
}

interface ServiceDocument extends ResourceRef {
  source?: { image?: unknown } | null;
  volumes?: Array<{
    name?: unknown;
    mountPath?: unknown;
    sizeMb?: unknown;
    state?: unknown;
  }>;
}

interface PitrDocument {
  service?: ResourceRef;
  environment?: ResourceRef;
  root?: ResourceRef;
  enabled?: unknown;
  bucketWired?: unknown;
  blockers?: unknown;
}

interface VolumeInventoryDocument {
  data?: {
    environment?: {
      id?: unknown;
      volumeInstances?: {
        edges?: Array<{
          node?: {
            id?: unknown;
            environmentId?: unknown;
            serviceId?: unknown;
            volumeId?: unknown;
            mountPath?: unknown;
            sizeMB?: unknown;
            state?: unknown;
            deletedAt?: unknown;
            isPendingDeletion?: unknown;
          };
        }>;
      };
    };
  };
  errors?: unknown;
}

interface ScheduleDocument {
  id?: unknown;
  kind?: unknown;
  retentionSeconds?: unknown;
}

interface BackupDocument {
  id?: unknown;
  createdAt?: unknown;
  scheduleId?: unknown;
}

export interface ResilienceEvidence {
  status: StatusDocument;
  services: ServiceDocument[];
  volumes: VolumeInventoryDocument;
  pitr: PitrDocument;
  schedules: ScheduleDocument[];
  backups: BackupDocument[];
}

export interface ResilienceExpectation {
  environment: TargetEnvironment;
  projectId: string;
  environmentId: string;
  serviceId: string;
  productionServiceReceipt?: string;
  productionVolumeReceipt?: string;
  maxBackupAgeHours: number;
}

export interface ResilienceReceipt {
  schemaVersion: 1;
  environment: TargetEnvironment;
  verdict: "pass" | "fail";
  checks: Record<string, boolean>;
  receipts: {
    service: string | null;
    volume: string | null;
    latestScheduledBackup: string | null;
  };
}

export interface CliArgs extends ResilienceExpectation {
  mode: GateMode;
  statusPath: string;
  servicesPath: string;
  volumesPath: string;
  pitrPath: string;
  schedulesPath: string;
  backupsPath: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : null;
}

function requireUuid(value: string, name: string): string {
  if (!UUID.test(value))
    throw new TypeError(`${name} must be a lowercase UUID`);
  return value;
}

function requireReceipt(value: string | undefined, name: string): string {
  if (!value || !SHA256.test(value)) {
    throw new TypeError(`${name} must be a lowercase SHA-256 receipt`);
  }
  return value;
}

function readJson(path: string): unknown {
  const bytes = readFileSync(path);
  if (bytes.byteLength > MAX_INPUT_BYTES) {
    throw new TypeError(
      `Railway evidence file exceeds ${MAX_INPUT_BYTES} bytes`,
    );
  }
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

function hasResource(
  edges: Array<{ node?: ResourceRef }> | undefined,
  id: string,
  expectedName?: string,
): boolean {
  return (edges ?? []).some(
    ({ node }) =>
      node?.id === id &&
      (expectedName === undefined || node?.name === expectedName),
  );
}

function validSchedule(schedule: ScheduleDocument, kind: string): boolean {
  if (schedule.kind !== kind || !canonicalString(schedule.id)) return false;
  return (
    schedule.retentionSeconds === null ||
    (typeof schedule.retentionSeconds === "number" &&
      Number.isSafeInteger(schedule.retentionSeconds) &&
      schedule.retentionSeconds > 0)
  );
}

function scheduledBackupTime(backup: BackupDocument): number | null {
  if (!canonicalString(backup.id) || !canonicalString(backup.scheduleId))
    return null;
  const createdAt = canonicalString(backup.createdAt);
  if (!createdAt) return null;
  const time = Date.parse(createdAt);
  return Number.isFinite(time) ? time : null;
}

export function verifyRailwayPostgresResilience(
  evidence: ResilienceEvidence,
  expected: ResilienceExpectation,
  now = new Date(),
): ResilienceReceipt {
  requireUuid(expected.projectId, "projectId");
  requireUuid(expected.environmentId, "environmentId");
  requireUuid(expected.serviceId, "serviceId");
  if (
    !Number.isSafeInteger(expected.maxBackupAgeHours) ||
    expected.maxBackupAgeHours < 1
  ) {
    throw new TypeError("maxBackupAgeHours must be a positive integer");
  }

  const matching = evidence.services.filter(
    ({ id }) => id === expected.serviceId,
  );
  const service = matching.length === 1 ? matching[0] : undefined;
  const projectBound = evidence.status.id === expected.projectId;
  const volumes = (service?.volumes ?? []).filter(
    (volume) =>
      volume.mountPath === POSTGRES_MOUNT &&
      volume.state === "READY" &&
      typeof volume.sizeMb === "number" &&
      Number.isFinite(volume.sizeMb) &&
      volume.sizeMb > 0 &&
      canonicalString(volume.name),
  );
  const serviceReceipt = service ? sha256(String(service.id)) : null;
  const immutableVolumes = (
    evidence.volumes.data?.environment?.volumeInstances?.edges ?? []
  )
    .map(({ node }) => node)
    .filter(
      (candidate) =>
        candidate !== undefined &&
        UUID.test(canonicalString(candidate.id) ?? "") &&
        UUID.test(canonicalString(candidate.volumeId) ?? "") &&
        candidate.environmentId === expected.environmentId &&
        candidate.serviceId === expected.serviceId &&
        candidate.mountPath === POSTGRES_MOUNT &&
        candidate.state === "READY" &&
        candidate.deletedAt === null &&
        candidate.isPendingDeletion === false &&
        typeof candidate.sizeMB === "number" &&
        Number.isSafeInteger(candidate.sizeMB) &&
        candidate.sizeMB > 0,
    );
  const immutableVolume =
    immutableVolumes.length === 1 ? immutableVolumes[0] : undefined;
  const immutableVolumeId = canonicalString(immutableVolume?.id);
  const immutableVolumeBound =
    projectBound &&
    evidence.volumes.errors === undefined &&
    evidence.volumes.data?.environment?.id === expected.environmentId &&
    immutableVolumes.length === 1;
  const volumeReceipt =
    immutableVolumeBound && immutableVolumeId
      ? sha256(immutableVolumeId)
      : null;

  const backupCandidates = evidence.backups
    .map((backup) => ({ backup, time: scheduledBackupTime(backup) }))
    .filter(
      (entry): entry is { backup: BackupDocument; time: number } =>
        entry.time !== null,
    )
    .sort((a, b) => b.time - a.time);
  const latestBackup = backupCandidates[0];
  const latestBackupId = canonicalString(latestBackup?.backup.id);
  const latestBackupReceipt = latestBackupId ? sha256(latestBackupId) : null;
  const ageMs = latestBackup
    ? now.getTime() - latestBackup.time
    : Number.POSITIVE_INFINITY;
  const backupFresh =
    ageMs >= -5 * 60 * 1000 &&
    ageMs <= expected.maxBackupAgeHours * 60 * 60 * 1000;
  const blockers = Array.isArray(evidence.pitr.blockers)
    ? evidence.pitr.blockers
    : [];

  const checks: Record<string, boolean> = {
    projectBound,
    environmentBound: hasResource(
      evidence.status.environments?.edges,
      expected.environmentId,
      expected.environment,
    ),
    serviceBound: hasResource(
      evidence.status.services?.edges,
      expected.serviceId,
    ),
    exactPostgres18Service:
      matching.length === 1 &&
      typeof service?.source?.image === "string" &&
      /(?:^|\/)postgres[^:]*:18(?:$|[-.])/.test(service.source.image),
    exactReadyVolume: volumes.length === 1,
    immutableVolumeBound,
    pitrTargetBound:
      evidence.pitr.service?.id === expected.serviceId &&
      evidence.pitr.root?.id === expected.serviceId &&
      evidence.pitr.environment?.id === expected.environmentId,
    pitrEnabled:
      evidence.pitr.enabled === true &&
      evidence.pitr.bucketWired === true &&
      blockers.length === 0,
    dailyBackupScheduled: evidence.schedules.some((schedule) =>
      validSchedule(schedule, "DAILY"),
    ),
    weeklyBackupScheduled: evidence.schedules.some((schedule) =>
      validSchedule(schedule, "WEEKLY"),
    ),
    recentScheduledBackup: backupFresh,
  };

  if (expected.environment === "staging") {
    const productionServiceReceipt = requireReceipt(
      expected.productionServiceReceipt,
      "productionServiceReceipt",
    );
    const productionVolumeReceipt = requireReceipt(
      expected.productionVolumeReceipt,
      "productionVolumeReceipt",
    );
    checks.physicallyDistinctService =
      serviceReceipt !== null && serviceReceipt !== productionServiceReceipt;
    checks.physicallyDistinctVolume =
      volumeReceipt !== null && volumeReceipt !== productionVolumeReceipt;
  }

  return {
    schemaVersion: 1,
    environment: expected.environment,
    verdict: Object.values(checks).every(Boolean) ? "pass" : "fail",
    checks,
    receipts: {
      service: serviceReceipt,
      volume: volumeReceipt,
      latestScheduledBackup: latestBackupReceipt,
    },
  };
}

export function parseCliArgs(argv: string[]): CliArgs {
  const parsed = parseArgs({
    args: argv,
    strict: true,
    options: {
      mode: { type: "string" },
      environment: { type: "string" },
      "project-id": { type: "string" },
      "environment-id": { type: "string" },
      "service-id": { type: "string" },
      "production-service-receipt": { type: "string" },
      "production-volume-receipt": { type: "string" },
      "max-backup-age-hours": { type: "string", default: "36" },
      "status-json": { type: "string" },
      "services-json": { type: "string" },
      "volumes-json": { type: "string" },
      "pitr-json": { type: "string" },
      "schedules-json": { type: "string" },
      "backups-json": { type: "string" },
    },
  });
  const value = (name: keyof typeof parsed.values): string => {
    const found = parsed.values[name];
    if (
      typeof found !== "string" ||
      found.length === 0 ||
      found !== found.trim()
    ) {
      throw new TypeError(`--${name} is required and must be canonical`);
    }
    return found;
  };
  const mode = value("mode");
  const environment = value("environment");
  if (mode !== "report" && mode !== "enforce") {
    throw new TypeError("--mode must be report or enforce");
  }
  if (environment !== "staging" && environment !== "production") {
    throw new TypeError("--environment must be staging or production");
  }
  const maxBackupAgeHours = Number(value("max-backup-age-hours"));
  return {
    mode,
    environment,
    projectId: requireUuid(value("project-id"), "projectId"),
    environmentId: requireUuid(value("environment-id"), "environmentId"),
    serviceId: requireUuid(value("service-id"), "serviceId"),
    productionServiceReceipt: parsed.values["production-service-receipt"],
    productionVolumeReceipt: parsed.values["production-volume-receipt"],
    maxBackupAgeHours,
    statusPath: value("status-json"),
    servicesPath: value("services-json"),
    volumesPath: value("volumes-json"),
    pitrPath: value("pitr-json"),
    schedulesPath: value("schedules-json"),
    backupsPath: value("backups-json"),
  };
}

function main(): void {
  const args = parseCliArgs(process.argv.slice(2));
  const receipt = verifyRailwayPostgresResilience(
    {
      status: readJson(args.statusPath) as StatusDocument,
      services: readJson(args.servicesPath) as ServiceDocument[],
      volumes: readJson(args.volumesPath) as VolumeInventoryDocument,
      pitr: readJson(args.pitrPath) as PitrDocument,
      schedules: readJson(args.schedulesPath) as ScheduleDocument[],
      backups: readJson(args.backupsPath) as BackupDocument[],
    },
    args,
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (args.mode === "enforce" && receipt.verdict !== "pass")
    process.exitCode = 1;
}

if (import.meta.main) main();
