/** Normalize private provider evidence for the existing stage boundary. No provider actions. */
import { createHash } from "node:crypto";
import { pitrPatchReceipt } from "./pitr-reviewed-patch";
import type { StageSnapshot } from "./pitr-reviewed-stage";

type Json = Parameters<typeof pitrPatchReceipt>[0];
function object(v: unknown): Record<string, Json> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw Error("stage_observation_invalid");
  return v as Record<string, Json>;
}
function data(v: unknown) {
  const r = object(v);
  if (r.errors) throw Error("stage_observation_invalid");
  return object(r.data);
}
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function normalizeStageObservation(input: {
  projectId: string;
  environmentId: string;
  serviceId: string;
  sourceHead: string;
  expectedVolumeReceipt: string;
  expectedImageReceipt: string;
  approvedBackup: {
    backupReceipt: string;
    volumeReceipt: string;
    createdAtMs: number;
    expiresAtMs: number | null;
    validUntilMs: number;
  };
  authority: unknown;
  authorityObservedAtMs: number;
  now: number;
  environment: unknown;
  project: unknown;
  volumes: unknown;
  staged: unknown;
  backups: unknown;
  pitr: unknown;
}): {
  snapshot: StageSnapshot;
  privateBuckets: Record<string, Json>;
  workspaceId: string;
  privateConfig: Json;
} {
  input = structuredClone(input);
  const fail = () => {
    throw Error("stage_observation_invalid");
  };
  const authority = object(input.authority),
    checks = object(authority.checks),
    major = object(authority.postgresMajor);
  if (
    !Number.isFinite(input.now) ||
    !Number.isFinite(input.authorityObservedAtMs) ||
    input.authorityObservedAtMs > input.now ||
    input.now - input.authorityObservedAtMs > 60000 ||
    checks.railwayTarget !== "match" ||
    checks.protectedDatabaseAuthority !== "match" ||
    major.canonical !== "18" ||
    major.protected !== "18"
  )
    fail();
  const env = object(data(input.environment).environment),
    config = object(env.config);
  if (env.id !== input.environmentId) fail();
  const service = object(object(config.services)[input.serviceId]),
    image = object(service.source).image;
  if (typeof image !== "string" || sha(image) !== input.expectedImageReceipt)
    fail();
  if (object(input.pitr).isHaCluster !== false) fail();
  const project = object(data(input.project).project),
    connection = object(project.buckets),
    page = object(connection.pageInfo);
  if (
    project.id !== input.projectId ||
    typeof project.workspaceId !== "string" ||
    !project.workspaceId ||
    page.hasNextPage !== false ||
    page.hasPreviousPage !== false ||
    !Array.isArray(connection.edges)
  )
    fail();
  const privateBuckets: Record<string, Json> = {};
  for (const edge of connection.edges as Json[]) {
    const b = object(object(edge).node);
    if (
      typeof b.id !== "string" ||
      !b.id ||
      b.projectId !== input.projectId ||
      Object.hasOwn(privateBuckets, b.id)
    )
      fail();
    privateBuckets[b.id as string] = {
      ...b,
      environmentConfig: object(config.buckets)[b.id as string] ?? null,
    };
  }
  const ve = object(data(input.volumes).environment),
    edges = object(ve.volumeInstances).edges;
  if (ve.id !== input.environmentId || !Array.isArray(edges)) fail();
  const matching = (edges as Json[])
    .map((e) => object(object(e).node))
    .filter(
      (v) =>
        v.environmentId === input.environmentId &&
        v.serviceId === input.serviceId &&
        v.mountPath === "/var/lib/postgresql/data" &&
        v.state === "READY" &&
        v.deletedAt === null &&
        v.isPendingDeletion === false,
    );
  if (
    matching.length !== 1 ||
    typeof matching[0].id !== "string" ||
    sha(matching[0].id) !== input.expectedVolumeReceipt ||
    input.approvedBackup.volumeReceipt !== input.expectedVolumeReceipt
  )
    fail();
  const backups = data(input.backups).volumeInstanceBackupList;
  if (!Array.isArray(backups)) fail();
  const found = (backups as Json[])
    .map(object)
    .filter(
      (b) =>
        typeof b.id === "string" &&
        sha(b.id) === input.approvedBackup.backupReceipt,
    );
  if (found.length !== 1) fail();
  const backup = found[0],
    created =
      typeof backup.createdAt === "string" ? Date.parse(backup.createdAt) : NaN,
    expiry =
      backup.expiresAt === null
        ? null
        : typeof backup.expiresAt === "string"
          ? Date.parse(backup.expiresAt)
          : NaN;
  if (
    !Number.isFinite(input.approvedBackup.validUntilMs) ||
    input.now >= input.approvedBackup.validUntilMs ||
    created !== input.approvedBackup.createdAtMs ||
    expiry !== input.approvedBackup.expiresAtMs ||
    (expiry !== null && (!Number.isFinite(expiry) || expiry <= input.now))
  )
    fail();
  const staged = object(data(input.staged).environmentStagedChanges),
    patch = object(staged.patch);
  // Stage-only must not modify any active service/source/credential/volume config.
  const preserved = { ...config };
  delete preserved.buckets;
  return {
    privateBuckets,
    workspaceId: project.workspaceId as string,
    privateConfig: config,
    snapshot: {
      binding: {
        projectId: input.projectId,
        environmentId: input.environmentId,
        serviceId: input.serviceId,
        volumeId: matching[0].id as string,
        imageSha256: input.expectedImageReceipt,
        sourceHead: input.sourceHead,
        configSha256: pitrPatchReceipt(config),
        stagedSha256: pitrPatchReceipt(patch),
        observedAtMs: input.now,
        standalone: true,
        authorityMatches: true,
        postgresMajor: "18",
        backupReceipt: input.approvedBackup.backupReceipt,
        backupCompleted: true,
        backupRetained: true,
        healthy: true,
      },
      bucketIds: Object.keys(privateBuckets).sort(),
      preservedConfigSha256: pitrPatchReceipt(preserved),
      stagedPatch: patch,
    },
  };
}
