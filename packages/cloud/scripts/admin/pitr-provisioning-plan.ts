/** Private-file, read-only plan capture. No provider client or mutation entrypoint. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { productionBackupReadiness } from "./production-backup-readiness";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function emptyPatch(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  return Object.values(value).every(
    (entry) =>
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      Object.keys(entry).length === 0,
  );
}
export function pitrProvisioningPlan(
  input: Parameters<typeof productionBackupReadiness>[0] & {
    baseline: unknown;
    staged: unknown;
    template: unknown;
  },
) {
  const candidate = productionBackupReadiness(input);
  const environment = object(object(input.baseline).data).environment;
  const config = object(object(environment).config);
  const service = object(object(config.services)[input.expected.serviceId]);
  const image = object(service.source).image;
  const captured = input.evidence.services.filter(
    (value) => value.id === input.expected.serviceId,
  );
  const staged = object(object(input.staged).data).environmentStagedChanges;
  const template = object(object(input.template).data).template;
  const serialized = object(template).serializedConfig;
  const templateConfig =
    typeof serialized === "string" ? JSON.parse(serialized) : serialized;
  const templateServices = Object.values(
    object(object(templateConfig).services),
  ).map(object);
  const now = (input.now ?? new Date()).getTime();
  const backups = input.evidence.backups as Array<Record<string, unknown>>;
  const selectedBackups = backups.filter(
    (backup) =>
      typeof backup.id === "string" &&
      createHash("sha256").update(backup.id).digest("hex") ===
        candidate.receipts.latestScheduledBackup,
  );
  const retained =
    selectedBackups.length === 1 &&
    (() => {
      const backup = selectedBackups[0];
      const created =
        typeof backup.createdAt === "string"
          ? Date.parse(backup.createdAt)
          : NaN;
      const expiry =
        typeof backup.expiresAt === "string"
          ? Date.parse(backup.expiresAt)
          : NaN;
      return (
        typeof backup.scheduleId === "string" &&
        backup.scheduleId.length > 0 &&
        created <= now &&
        now - created <= input.expected.maxBackupAgeHours * 3600000 &&
        (backup.expiresAt === null || expiry > now)
      );
    })();
  const templateEffects = templateServices.map((service) => {
    const variables = Object.entries(object(service.variables));
    if (
      variables.length > 128 ||
      variables.some(([name]) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(name))
    )
      throw Error("template_variable_shape_not_reviewable");
    const keys = (value: unknown, allowed: string[]) => {
      const names = Object.keys(object(value));
      return {
        known: names.filter((name) => allowed.includes(name)).sort(),
        unknownCount: names.filter((name) => !allowed.includes(name)).length,
      };
    };
    return {
      variables: variables
        .map(([name, value]) => ({
          name,
          representation: value === null ? "null" : typeof value,
          valueType: typeof object(value).value,
          isReference:
            typeof object(value).value === "string" &&
            /^\$\{\{[^{}]+\}\}$/.test(String(object(value).value)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      sourceKeys: keys(service.source, [
        "image",
        "repo",
        "branch",
        "rootDirectory",
      ]),
      deployKeys: keys(service.deploy, [
        "startCommand",
        "healthcheckPath",
        "healthcheckTimeout",
        "restartPolicyType",
        "restartPolicyMaxRetries",
        "numReplicas",
        "multiRegionConfig",
        "region",
        "sleepApplication",
        "drainingSeconds",
        "overlapSeconds",
      ]),
      rootKeys: keys(service, [
        "name",
        "variables",
        "source",
        "deploy",
        "build",
        "networking",
        "volumes",
        "clusterRole",
        "icon",
        "region",
      ]),
    };
  });
  const pitr = object(input.evidence.pitr);
  const checks = {
    sourceEvidenceWellFormed:
      object(input.baseline).errors === undefined &&
      object(input.staged).errors === undefined &&
      object(input.template).errors === undefined,
    protectedAuthorityMatches: candidate.checks.protectedAuthorityMatches,
    actualPostgres18:
      candidate.diagnostics.postgresMajor.canonical === "18" &&
      candidate.diagnostics.postgresMajor.protected === "18",
    exactEnvironment: object(environment).id === input.expected.environmentId,
    exactService:
      captured.length === 1 &&
      captured[0].source?.image === image &&
      Object.keys(service).length > 0,
    originalDigestImage:
      typeof image === "string" &&
      /^ghcr\.io\/railwayapp-templates\/(?:postgres-ssl|postgres-ha\/postgres-patroni)@sha256:[a-f0-9]{64}$/.test(
        image,
      ),
    exactReadyVolume:
      candidate.resilienceChecks.exactReadyVolume &&
      candidate.resilienceChecks.immutableVolumeBound,
    standalone: pitr.isHaCluster === false,
    noStagedChanges: emptyPatch(object(staged).patch),
    freshRetainedScheduledBackup:
      candidate.resilienceChecks.recentScheduledBackup && retained,
    templatePresent:
      typeof object(template).id === "string" &&
      templateConfig !== null &&
      typeof templateConfig === "object" &&
      !Array.isArray(templateConfig),
    singleTemplateService: templateServices.length === 1,
    templateHasNoImageOverride:
      templateServices.length === 1 &&
      templateServices.every(
        (value) =>
          value.source === undefined ||
          (value.source !== null &&
            typeof value.source === "object" &&
            !Array.isArray(value.source) &&
            Object.keys(value.source).length === 0),
      ),
  };
  return {
    schemaVersion: 1,
    purpose: "read_only_pitr_provisioning_plan",
    observationVerdict: Object.values(checks).every(Boolean)
      ? "reviewable"
      : "incomplete",
    checks,
    templateEffects,
    observations: {
      pitrEnabled: candidate.diagnostics.pitrEnabled,
      bucketWired: candidate.diagnostics.bucketWired,
      templateServiceCount: templateServices.length,
      templateBucketCount: Object.keys(object(object(templateConfig).buckets))
        .length,
      templateVariableCount: templateServices.reduce(
        (sum, value) => sum + Object.keys(object(value.variables)).length,
        0,
      ),
      templateDeclaresWalArchiveBucket: templateServices.some((value) =>
        Object.hasOwn(object(value.variables), "WAL_ARCHIVE_BUCKET"),
      ),
      templateHasDeployOverrides: templateServices.some(
        (value) => value.deploy !== undefined,
      ),
    },
    receipts: {
      ...candidate.receipts,
      observedImage:
        typeof image === "string"
          ? createHash("sha256").update(image).digest("hex")
          : null,
      baseline: hash(input.baseline),
      staged: hash(input.staged),
      template: hash(input.template),
      serializedTemplate: hash(templateConfig ?? null),
    },
    // stageOnly creates resources. The public commit API has no CAS token.
    stageCreatesResources: true,
    atomicStagedCommitAvailable: false,
    provisioningEnabled: false,
    productionMutationPerformed: false,
    // Pinned backup-list schema has no completion status; metadata is not a restore proof.
    backupCompletionProven: false,
    restoreProven: false,
    productionMigrationReady: false,
  };
}
if (import.meta.main) {
  try {
    const directory = process.env.BACKUP_EVIDENCE_DIR;
    if (!directory) throw Error("evidence_required");
    const read = (name: string) => {
      const data = readFileSync(join(directory, name));
      if (data.length > 4 * 1024 * 1024) throw Error("evidence_too_large");
      return JSON.parse(data.toString("utf8"));
    };
    const report = pitrProvisioningPlan({
      baseline: read("pitr-plan-baseline.json"),
      staged: read("pitr-plan-staged.json"),
      template: read("pitr-plan-template.json"),
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
        serviceId: readFileSync(
          join(directory, "resolved-service-id"),
          "utf8",
        ).trim(),
        maxBackupAgeHours: Number(
          process.env.DATABASE_RESILIENCE_MAX_BACKUP_AGE_HOURS ?? "36",
        ),
      },
    });
    console.log(JSON.stringify(report, null, 2));
    if (report.observationVerdict !== "reviewable") process.exitCode = 1;
  } catch {
    // error-policy:J1 provider/config contents never leave the private evidence boundary.
    console.log(
      JSON.stringify({
        purpose: "read_only_pitr_provisioning_plan",
        observationVerdict: "incomplete",
        failure: "private_plan_evidence_invalid_or_unavailable",
        provisioningEnabled: false,
        productionMutationPerformed: false,
      }),
    );
    process.exitCode = 1;
  }
}
