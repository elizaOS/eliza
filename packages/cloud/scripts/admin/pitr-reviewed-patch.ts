/** Reviewed exact-patch boundary. No credentials, CLI, or production transport is connected. */
import { createHash } from "node:crypto";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const SHA = /^[a-f0-9]{64}$/;
function canonical(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function pitrPatchReceipt(value: Json): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function object(value: Json | undefined): { [key: string]: Json } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("invalid_patch_shape");
  return value;
}
export interface PitrSnapshot {
  projectId: string;
  environmentId: string;
  serviceId: string;
  volumeId: string;
  imageSha256: string;
  sourceHead: string;
  configSha256: string;
  stagedSha256: string;
  observedAtMs: number;
  standalone: boolean;
  authorityMatches: boolean;
  postgresMajor: "18" | "other" | "unavailable";
  backupReceipt: string;
  backupCompleted: boolean;
  backupRetained: boolean;
  healthy: boolean;
}
export interface PitrPatchReview {
  /** Private protected bindings; never included in the public result. */
  before: PitrSnapshot;
  afterConfigSha256: string;
  afterStagedSha256: string;
  patchSha256: string;
  allowedVariableNames: readonly string[];
  /** Must derive from observed created-resource ownership, never template labels alone. */
  ownedBucketIds: readonly string[];
  writerMaintenanceReceipt: string;
  expiresAtMs: number;
}
export interface PitrPatchTransport {
  /**
   * Must read current provider config and independent DB authority with bounded timeouts.
   * After commit, bound readiness/reconnect through the expected restart; timestamps
   * describe actual observation, not retrieval of a cached precommit snapshot.
   * Backup completion must have independent proof, not inferred BackupList metadata.
   */
  snapshot(): Promise<PitrSnapshot>;
  /** Must send this exact patch to environmentPatchCommit, NEVER commitStaged. */
  commitExactPatch(environmentId: string, patch: Json): Promise<unknown>;
}
function sameBindings(a: PitrSnapshot, b: PitrSnapshot) {
  return [
    "projectId",
    "environmentId",
    "serviceId",
    "volumeId",
    "imageSha256",
    "sourceHead",
    "backupReceipt",
  ].every(
    (key) => a[key as keyof PitrSnapshot] === b[key as keyof PitrSnapshot],
  );
}
export function validSnapshot(value: PitrSnapshot) {
  return (
    [
      value.projectId,
      value.environmentId,
      value.serviceId,
      value.volumeId,
    ].every((id) => typeof id === "string" && id.length > 0) &&
    [
      value.imageSha256,
      value.configSha256,
      value.stagedSha256,
      value.backupReceipt,
    ].every((hash) => SHA.test(hash)) &&
    /^[a-f0-9]{40}$/.test(value.sourceHead) &&
    Number.isFinite(value.observedAtMs)
  );
}
function healthyAuthority(value: PitrSnapshot) {
  return (
    value.standalone &&
    value.authorityMatches &&
    value.postgresMajor === "18" &&
    value.backupCompleted &&
    value.backupRetained &&
    value.healthy
  );
}
function scopedPatch(patch: Json, review: PitrPatchReview) {
  const root = object(patch);
  if (Object.keys(root).some((key) => !["services", "buckets"].includes(key)))
    return false;
  const services = object(root.services);
  if (
    Object.keys(services).length !== 1 ||
    !Object.hasOwn(services, review.before.serviceId)
  )
    return false;
  const service = object(services[review.before.serviceId]);
  if (Object.keys(service).length !== 1 || !Object.hasOwn(service, "variables"))
    return false;
  const variables = object(service.variables);
  if (
    !Object.hasOwn(variables, "WAL_ARCHIVE_BUCKET") ||
    Object.keys(variables).some(
      (name) =>
        !name.startsWith("WAL_ARCHIVE_") ||
        !review.allowedVariableNames.includes(name),
    )
  )
    return false;
  if (
    root.buckets !== undefined &&
    Object.keys(object(root.buckets)).some(
      (id) => !review.ownedBucketIds.includes(id),
    )
  )
    return false;
  return true;
}
/**
 * This is NOT atomic CAS. Practical exclusive-writer maintenance is a prerequisite;
 * the fresh pre/post observations detect drift but cannot eliminate the commit race.
 * No automatic retry, staged-patch clearing, revert, or bucket deletion occurs.
 */
export async function commitReviewedPitrPatch(input: {
  patch: Json;
  review: PitrPatchReview;
  transport: PitrPatchTransport;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const result = (
    state:
      | "refused_before_mutation"
      | "commit_unconfirmed"
      | "post_commit_drift"
      | "committed_observed",
  ) => ({
    state,
    nonAtomicWriterRaceRemains: true,
    automaticRetryAllowed: false,
    restoreProven: false,
    productionMigrationReady: false,
  });
  let submitted = false;
  try {
    const review = structuredClone(input.review);
    const patch: Json = JSON.parse(JSON.stringify(input.patch));
    if (
      !validSnapshot(review.before) ||
      !Number.isFinite(review.expiresAtMs) ||
      !Number.isFinite(now()) ||
      !SHA.test(review.patchSha256) ||
      !SHA.test(review.writerMaintenanceReceipt) ||
      !SHA.test(review.afterConfigSha256) ||
      !SHA.test(review.afterStagedSha256) ||
      now() >= review.expiresAtMs ||
      pitrPatchReceipt(patch) !== review.patchSha256 ||
      !scopedPatch(patch, review)
    )
      return result("refused_before_mutation");
    const before = await input.transport.snapshot();
    if (
      !validSnapshot(before) ||
      !Number.isFinite(now()) ||
      !sameBindings(before, review.before) ||
      !healthyAuthority(before) ||
      before.configSha256 !== review.before.configSha256 ||
      before.stagedSha256 !== review.before.stagedSha256 ||
      before.observedAtMs > now() ||
      now() - before.observedAtMs > 60000 ||
      now() >= review.expiresAtMs
    )
      return result("refused_before_mutation");
    // Awaiting this reply may fail after the server commits. Never retry it here.
    submitted = true;
    const response = await input.transport.commitExactPatch(
      before.environmentId,
      patch,
    );
    const data =
      response !== null && typeof response === "object"
        ? (response as {
            data?: { environmentPatchCommit?: unknown };
            errors?: unknown;
          })
        : {};
    if (
      data.errors !== undefined ||
      typeof data.data?.environmentPatchCommit !== "string" ||
      data.data.environmentPatchCommit.length === 0
    )
      return result("commit_unconfirmed");
    const postReadStartedAtMs = now();
    const after = await input.transport.snapshot();
    if (
      !Number.isFinite(postReadStartedAtMs) ||
      !validSnapshot(after) ||
      !Number.isFinite(now()) ||
      !sameBindings(after, before) ||
      !healthyAuthority(after) ||
      after.configSha256 !== review.afterConfigSha256 ||
      after.stagedSha256 !== review.afterStagedSha256 ||
      after.observedAtMs < postReadStartedAtMs ||
      after.observedAtMs < before.observedAtMs ||
      after.observedAtMs > now() ||
      now() - after.observedAtMs > 60000
    )
      return result("post_commit_drift");
    return result("committed_observed");
  } catch {
    // error-policy:J1 provider failures may contain credentials, IDs and variable values.
    return result(submitted ? "commit_unconfirmed" : "refused_before_mutation");
  }
}
