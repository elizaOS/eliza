/** Private observed-resource proof. Returns no names, references or credential values. */
import { pitrPatchReceipt } from "./pitr-reviewed-patch";

type Json = Parameters<typeof pitrPatchReceipt>[0];
function object(value: Json | undefined): Record<string, Json> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("bucket_evidence_invalid");
  return value;
}
const REFERENCES = {
  WAL_ARCHIVE_BUCKET: "BUCKET",
  WAL_ARCHIVE_ENDPOINT: "ENDPOINT",
  WAL_ARCHIVE_KEY: "ACCESS_KEY_ID",
  WAL_ARCHIVE_SECRET: "SECRET_ACCESS_KEY",
  WAL_ARCHIVE_REGION: "REGION",
} as const;
/** Provider variable reference names: https://docs.railway.com/storage-buckets#railway-provided-variables */
export function observedStageBucketBinding(input: {
  beforeBuckets: Json;
  afterBuckets: Json;
  stagedPatch: Json;
  newBucketId: string;
  serviceId: string;
  projectId: string;
}) {
  try {
    const before = object(input.beforeBuckets),
      after = object(input.afterBuckets);
    const added = Object.keys(after).filter((id) => !Object.hasOwn(before, id));
    if (
      added.length !== 1 ||
      added[0] !== input.newBucketId ||
      Object.entries(before).some(
        ([id, value]) =>
          !Object.hasOwn(after, id) ||
          pitrPatchReceipt(value) !== pitrPatchReceipt(after[id]),
      )
    )
      return false;
    const bucket = object(after[input.newBucketId]);
    if (
      bucket.id !== input.newBucketId ||
      bucket.projectId !== input.projectId ||
      typeof bucket.name !== "string" ||
      !bucket.name ||
      /[{}\r\n]/.test(bucket.name)
    )
      return false;
    if (
      Object.values(after).filter((value) => object(value).name === bucket.name)
        .length !== 1
    )
      return false;
    const patch = object(input.stagedPatch),
      buckets = object(patch.buckets);
    if (
      Object.keys(buckets).length !== 1 ||
      !Object.hasOwn(buckets, input.newBucketId) ||
      object(buckets[input.newBucketId]).isDeleted === true
    )
      return false;
    const variables = object(
      object(object(patch.services)[input.serviceId]).variables,
    );
    for (const [name, field] of Object.entries(REFERENCES)) {
      const variable = object(variables[name]);
      if (
        variable.isDeleted === true ||
        variable.value !== `\${{${bucket.name}.${field}}}`
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}
