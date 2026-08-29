/**
 * Exact, bounded multipart object upload facade.
 *
 * Provider multipart creation is not a portable create-only operation. The
 * durable caller must therefore own a globally unique key behind a writer
 * fence; this primitive deliberately does not discover or adopt unknown
 * uploads.
 */

import { ObjectStorageLifecycleError } from "./object-store";
import { createRequestContext, lateAbortCreatedUpload } from "./object-store-multipart-control";
import {
  createProviderHandle,
  providerHandleForRuntime,
  providerHandleForS3,
  requireRuntimeMultipart,
  type S3MultipartBackend,
  verifyS3Resume,
} from "./object-store-multipart-providers";
import { createMultipartSession } from "./object-store-multipart-session";
import {
  assertHandleMatchesBackend,
  buildHandle,
  type CreateMultipartObjectUploadInput,
  hasEveryExactPart,
  isAuthoritativeCreateFailure,
  lifecycle,
  type MultipartObjectUploadSession,
  type ProviderMultipartHandle,
  type ResumeMultipartObjectUploadInput,
  requireBackend,
  requirePlan,
  validateReceiptForHandle,
} from "./object-store-multipart-types";
import { reconcileCompletedObject } from "./object-store-multipart-verification";

export type {
  CreateMultipartObjectUploadInput,
  MultipartObjectRequestControl,
  MultipartObjectUploadPlan,
  MultipartObjectUploadSession,
  RehydrateMultipartObjectUploadHandleInput,
  ResumeMultipartObjectUploadInput,
  SerializedMultipartObjectUploadHandle,
  UploadMultipartObjectPartInput,
} from "./object-store-multipart-types";
export {
  DEFAULT_MULTIPART_REQUEST_DURATION_MS,
  MAX_MULTIPART_OBJECT_BYTES,
  MAX_MULTIPART_OBJECT_PARTS,
  MAX_MULTIPART_REQUEST_DURATION_MS,
  MULTIPART_OBJECT_PART_BYTES,
  MultipartObjectPartReceipt,
  MultipartObjectUploadHandle,
  rehydrateMultipartObjectUploadHandle,
} from "./object-store-multipart-types";

/** Create exactly one provider multipart upload; this operation never retries. */
export async function createMultipartObjectUpload(
  input: CreateMultipartObjectUploadInput,
): Promise<MultipartObjectUploadSession> {
  const backend = requireBackend(input.backend);
  const plan = requirePlan(input);
  const context = createRequestContext(input.control);
  try {
    context.ensureActive();
    let provider: ProviderMultipartHandle;
    try {
      provider = await createProviderHandle({ backend, plan, context });
    } catch (error) {
      if (
        error instanceof ObjectStorageLifecycleError &&
        (error.code === "OBJECT_STORAGE_MULTIPART_UNSUPPORTED" ||
          error.code === "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE")
      ) {
        throw error;
      }
      if (isAuthoritativeCreateFailure(error)) {
        throw lifecycle(
          "OBJECT_STORAGE_MULTIPART_CREATE_FAILED",
          "Multipart provider authoritatively rejected upload creation",
          error,
        );
      }
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE",
        "Multipart upload creation outcome is indeterminate and must not be retried",
        error,
      );
    }
    if (provider.key !== plan.key) {
      context.registerCleanup(lateAbortCreatedUpload(provider));
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE",
        "Multipart provider returned a handle for another exact key",
      );
    }
    try {
      context.ensureActive();
      const handle = await buildHandle({ backend, plan, uploadId: provider.uploadId });
      context.ensureActive();
      return createMultipartSession({ backend, provider, handle });
    } catch (error) {
      context.registerCleanup(lateAbortCreatedUpload(provider));
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE",
        "Multipart handle could not be returned safely after provider creation",
        error,
      );
    }
  } finally {
    context.dispose();
  }
}

/**
 * Resume an exact handle. Native Workers R2 cannot validate upload existence;
 * it trusts only caller-supplied provider-acknowledged receipts. S3-compatible
 * transports verify the upload and those receipts with ListParts first. A
 * missing S3 upload is adopted only when every exact receipt exists and the
 * completed generation passes HEAD plus a fully drained GET.
 */
export async function resumeMultipartObjectUpload(
  input: ResumeMultipartObjectUploadInput,
): Promise<MultipartObjectUploadSession> {
  const backend = requireBackend(input.backend);
  await assertHandleMatchesBackend(backend, input.handle);
  const acknowledgedParts = Object.freeze([...(input.acknowledgedParts ?? [])]);
  const partNumbers = new Set<number>();
  for (const receipt of acknowledgedParts) {
    validateReceiptForHandle(input.handle, receipt);
    if (partNumbers.has(receipt.partNumber)) {
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_HANDLE_MISMATCH",
        "Multipart resume received duplicate part receipts",
      );
    }
    partNumbers.add(receipt.partNumber);
  }

  const context = createRequestContext(input.control);
  try {
    context.ensureActive();
    if (backend.runtimeBucket) {
      const multipart = requireRuntimeMultipart(backend);
      const resumed = multipart.resumeMultipartUpload(input.handle.key, input.handle.uploadId);
      const provider = providerHandleForRuntime(resumed);
      if (provider.key !== input.handle.key || provider.uploadId !== input.handle.uploadId) {
        throw lifecycle(
          "OBJECT_STORAGE_MULTIPART_HANDLE_MISMATCH",
          "Worker R2 resumed another exact multipart handle",
        );
      }
      return createMultipartSession({
        backend,
        provider,
        handle: input.handle,
        acknowledgedParts,
      });
    }

    const s3Backend = backend as S3MultipartBackend;
    let resumeState: "active" | "missing";
    try {
      resumeState = await verifyS3Resume({
        backend: s3Backend,
        handle: input.handle,
        acknowledgedParts,
        context,
      });
    } catch (error) {
      if (error instanceof ObjectStorageLifecycleError) throw error;
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_PART_FAILED",
        "Multipart S3 handle could not be verified before resume",
        error,
      );
    }
    const provider = providerHandleForS3(s3Backend, input.handle.key, input.handle.uploadId);
    if (resumeState === "active") {
      return createMultipartSession({
        backend,
        provider,
        handle: input.handle,
        acknowledgedParts,
      });
    }
    if (!hasEveryExactPart(input.handle, acknowledgedParts)) {
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_NO_SUCH_UPLOAD",
        "Multipart upload disappeared without every exact durable part receipt",
      );
    }
    const completedReceipt = await reconcileCompletedObject({
      backend,
      handle: input.handle,
      context,
    });
    if (!completedReceipt) {
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_NO_SUCH_UPLOAD",
        "Multipart upload and exact completed object are both absent",
      );
    }
    return createMultipartSession({
      backend,
      provider,
      handle: input.handle,
      acknowledgedParts,
      completedReceipt,
    });
  } finally {
    await context.waitForSettlements();
    context.dispose();
  }
}
