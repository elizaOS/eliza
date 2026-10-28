/** Source-only stage boundary; no production transport is connected. */
import {
  type PitrSnapshot,
  pitrPatchReceipt,
  validSnapshot,
} from "./pitr-reviewed-patch";

type Json = Parameters<typeof pitrPatchReceipt>[0];
export const OBSERVED_TEMPLATE =
  "27fa18f6a5cc99b98ec163ffcc824a92b0b3eefd3c9ae6d3e3981d9ccc6e357d";
const SHA = /^[a-f0-9]{64}$/;
export interface StageSnapshot {
  binding: PitrSnapshot;
  bucketIds: string[];
  /** Private complete credential/source/volume subset hashes, computed from provider config. */
  preservedConfigSha256: string;
  stagedPatch: Json;
}
export interface StageReview {
  before: StageSnapshot;
  /** Hash of JSON.stringify(parsed templateConfig), matching the protected reporter, captured by the protected read-only plan. */
  serializedTemplateSha256: string;
  writerMaintenanceReceipt: string;
  operationReceipt: string;
  expiresAtMs: number;
  allowedVariableNames: string[];
}
export interface StageTransport {
  snapshot(): Promise<StageSnapshot>;
  /** Persist private intent and baseline inventory BEFORE resource-creating submission. */
  persistIntent(review: StageReview): Promise<void>;
  /** Exact captured template, existing root, stageOnly=true. Never auto-commit/deploy. */
  stage(template: Json, binding: PitrSnapshot): Promise<{ workflowId: string }>;
  /** Bounded wait; missing/denied/unknown is not completion. Never emit raw errors. */
  awaitComplete(workflowId: string): Promise<boolean>;
  /** Verify actual WAL references resolve to the sole new bucket and all existing buckets are unchanged.
   * This is operational ownership under exclusive writer maintenance, not provider atomic attribution. */
  verifyBucketBinding(
    before: StageSnapshot,
    after: StageSnapshot,
    newBucketId: string,
  ): Promise<boolean>;
  /** Store private actual patch/inventory for review; never export values. */
  persistObservation(
    snapshot: StageSnapshot,
    ownedBucketIds: string[],
  ): Promise<void>;
}
function record(value: Json): Record<string, Json> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw Error("invalid_shape");
  return value;
}
export function inspectPitrStagePatch(
  patch: Json,
  serviceId: string,
  variables: string[],
  buckets: string[],
) {
  const root = record(patch);
  if (Object.keys(root).some((key) => !["services", "buckets"].includes(key)))
    return false;
  const services = record(root.services);
  if (Object.keys(services).length !== 1 || !Object.hasOwn(services, serviceId))
    return false;
  const service = record(services[serviceId]);
  if (Object.keys(service).length !== 1 || !Object.hasOwn(service, "variables"))
    return false;
  const values = record(service.variables);
  if (
    !Object.hasOwn(values, "WAL_ARCHIVE_BUCKET") ||
    Object.keys(values).some(
      (key) => !key.startsWith("WAL_ARCHIVE_") || !variables.includes(key),
    )
  )
    return false;
  return (
    root.buckets === undefined ||
    Object.keys(record(root.buckets)).every((id) => buckets.includes(id))
  );
}
interface StageInput {
  serializedTemplate: Json;
  review: StageReview;
  transport: StageTransport;
  now?: () => number;
}
/** Production entrypoint is fixed to the independently captured template. */
export async function stageReviewedPitr(input: StageInput) {
  return stagePitrPolicyEngine(input, OBSERVED_TEMPLATE);
}
/** Internal engine for synthetic policy fixtures; production transport must use the fixed wrapper. */
export async function stagePitrPolicyEngine(
  input: StageInput,
  approvedTemplate: string,
) {
  const now = input.now ?? Date.now;
  let submitted = false;
  const result = (
    state:
      | "refused_before_stage"
      | "creation_unconfirmed"
      | "staged_requires_review"
      | "staged_prohibited_change",
  ) => ({
    state,
    automaticRetryAllowed: false,
    committed: false,
    productionMigrationReady: false,
    resourceCreationPossible: submitted,
    nonAtomicWriterRaceRemains: true,
  });
  try {
    const review = structuredClone(input.review);
    const template: Json =
      typeof input.serializedTemplate === "string"
        ? JSON.parse(input.serializedTemplate)
        : structuredClone(input.serializedTemplate);
    const { createHash } = await import("node:crypto");
    if (
      !validSnapshot(review.before.binding) ||
      review.serializedTemplateSha256 !== approvedTemplate ||
      createHash("sha256").update(JSON.stringify(template)).digest("hex") !==
        approvedTemplate ||
      ![
        review.writerMaintenanceReceipt,
        review.operationReceipt,
        review.before.preservedConfigSha256,
      ].every((v) => SHA.test(v)) ||
      !Number.isFinite(review.expiresAtMs) ||
      !Number.isFinite(now()) ||
      now() >= review.expiresAtMs
    )
      return result("refused_before_stage");
    const before = await input.transport.snapshot();
    const binding = before.binding;
    if (
      pitrPatchReceipt({
        ...before,
        binding: { ...before.binding, observedAtMs: 0 },
      } as unknown as Json) !==
        pitrPatchReceipt({
          ...review.before,
          binding: { ...review.before.binding, observedAtMs: 0 },
        } as unknown as Json) ||
      !binding.authorityMatches ||
      binding.postgresMajor !== "18" ||
      !binding.standalone ||
      !binding.healthy ||
      !binding.backupCompleted ||
      !binding.backupRetained ||
      !Number.isFinite(binding.observedAtMs) ||
      binding.observedAtMs > now() ||
      now() - binding.observedAtMs > 60000 ||
      !Object.values(record(before.stagedPatch)).every(
        (value) => Object.keys(record(value)).length === 0,
      )
    )
      return result("refused_before_stage");
    await input.transport.persistIntent(review);
    if (now() >= review.expiresAtMs) return result("refused_before_stage");
    submitted = true;
    const operation = await input.transport.stage(template, binding);
    if (
      !operation.workflowId ||
      !(await input.transport.awaitComplete(operation.workflowId))
    )
      return result("creation_unconfirmed");
    const readStart = now();
    const after = await input.transport.snapshot();
    const owned = after.bucketIds.filter(
      (id) => !before.bucketIds.includes(id),
    );
    await input.transport.persistObservation(after, owned);
    const bucketBound =
      owned.length === 1 &&
      (await input.transport.verifyBucketBinding(before, after, owned[0]));
    const preservedBinding = (value: PitrSnapshot) => ({
      projectId: value.projectId,
      environmentId: value.environmentId,
      serviceId: value.serviceId,
      volumeId: value.volumeId,
      imageSha256: value.imageSha256,
      sourceHead: value.sourceHead,
      configSha256: value.configSha256,
    });
    if (
      !validSnapshot(after.binding) ||
      !after.binding.authorityMatches ||
      !after.binding.healthy ||
      after.binding.postgresMajor !== "18" ||
      !after.binding.backupCompleted ||
      !after.binding.backupRetained ||
      !Number.isFinite(readStart) ||
      !Number.isFinite(after.binding.observedAtMs) ||
      after.binding.observedAtMs < readStart ||
      after.binding.observedAtMs > now() ||
      now() - after.binding.observedAtMs > 60000 ||
      pitrPatchReceipt(preservedBinding(binding)) !==
        pitrPatchReceipt(preservedBinding(after.binding)) ||
      before.preservedConfigSha256 !== after.preservedConfigSha256 ||
      before.bucketIds.some((id) => !after.bucketIds.includes(id)) ||
      owned.length !== 1 ||
      !bucketBound ||
      !inspectPitrStagePatch(
        after.stagedPatch,
        binding.serviceId,
        review.allowedVariableNames,
        owned,
      )
    )
      return result("staged_prohibited_change");
    return result("staged_requires_review");
  } catch {
    // error-policy:J1 provider errors may contain credentials and customer identifiers.
    return result(submitted ? "creation_unconfirmed" : "refused_before_stage");
  }
}
