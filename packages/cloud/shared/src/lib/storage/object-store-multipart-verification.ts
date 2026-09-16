/** Exact HEAD plus fully drained GET verification for multipart completion. */

import { createHash } from "node:crypto";
import { GetObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import {
  type ExactObjectStorageBackend,
  type ImmutableObjectUploadReceipt,
  ObjectLocatorReceipt,
  ObjectStorageLifecycleError,
} from "./object-store";
import {
  type ProviderRequestContext,
  reportMultipartCleanupFailure,
} from "./object-store-multipart-control";
import {
  isNotFound,
  lifecycle,
  MULTIPART_SHA256_METADATA_KEY,
  type MultipartObjectUploadHandle,
  providerCode,
  providerStatus,
  sha256HexToBase64,
} from "./object-store-multipart-types";
import type { RuntimeR2Object, RuntimeR2ObjectMetadata } from "./r2-runtime-binding";

function streamFromS3Body(body: unknown): ReadableStream<Uint8Array> {
  if (
    body &&
    typeof body === "object" &&
    "getReader" in body &&
    typeof body.getReader === "function"
  ) {
    return body as ReadableStream<Uint8Array>;
  }
  if (
    body &&
    typeof body === "object" &&
    "transformToWebStream" in body &&
    typeof body.transformToWebStream === "function"
  ) {
    const stream = body.transformToWebStream();
    if (stream && typeof stream.getReader === "function") return stream;
  }
  throw lifecycle(
    "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
    "Multipart verification GET did not expose a byte stream",
  );
}

function normalizedObjectEtag(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 4_096 ||
    /[\r\n\0]/.test(value)
  ) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function normalizedObjectVersion(value: unknown): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4_096 &&
    !/[\r\n\0]/.test(value)
    ? value
    : null;
}

interface CompletedHead {
  readonly size: number;
  readonly etag: string;
  readonly version: string | null;
  readonly declaredSha256: string | null;
}

function registerStreamCancellation(
  body: ReadableStream<Uint8Array>,
  context: ProviderRequestContext,
): void {
  let cleanup: Promise<void>;
  try {
    cleanup = Promise.resolve(body.cancel()).then(() => undefined);
  } catch (error) {
    // error-policy:J5 the rejected cleanup Promise is observed by the durable
    // registerCleanup hook immediately below.
    cleanup = Promise.reject(error);
  }
  context.registerCleanup(cleanup);
}

async function headCompletedObject(input: {
  backend: ExactObjectStorageBackend;
  handle: MultipartObjectUploadHandle;
  context: ProviderRequestContext;
}): Promise<CompletedHead | null> {
  if (input.backend.runtimeBucket) {
    const object = await input.context.race(
      Promise.resolve().then(() => input.backend.runtimeBucket!.head(input.handle.key)),
    );
    if (!object) return null;
    const etag = normalizedObjectEtag(object.etag);
    const version = normalizedObjectVersion(object.version);
    if (
      !etag ||
      !Number.isSafeInteger(object.size) ||
      object.size < 0 ||
      (object.version !== undefined && version === null)
    ) {
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
        "Multipart verification HEAD returned invalid object metadata",
      );
    }
    return {
      size: object.size,
      etag,
      version,
      declaredSha256: object.customMetadata?.[MULTIPART_SHA256_METADATA_KEY] ?? null,
    };
  }

  try {
    const object = await input.context.race(
      input.backend.s3Client.send(
        new HeadObjectCommand({
          Bucket: input.backend.locator.bucket,
          Key: input.handle.key,
        }),
        { abortSignal: input.context.signal },
      ),
    );
    const etag = normalizedObjectEtag(object.ETag);
    const version = normalizedObjectVersion(object.VersionId);
    if (
      !etag ||
      !Number.isSafeInteger(object.ContentLength) ||
      object.ContentLength === undefined ||
      (object.VersionId !== undefined && version === null)
    ) {
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
        "Multipart verification HEAD returned invalid object metadata",
      );
    }
    return {
      size: object.ContentLength,
      etag,
      version,
      declaredSha256: object.Metadata?.[MULTIPART_SHA256_METADATA_KEY] ?? null,
    };
  } catch (error) {
    // error-policy:J3 only the provider's authoritative not-found shape is
    // normalized to absence; every other HEAD failure is preserved.
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function openCompletedBody(input: {
  backend: ExactObjectStorageBackend;
  handle: MultipartObjectUploadHandle;
  head: CompletedHead;
  context: ProviderRequestContext;
}): Promise<ReadableStream<Uint8Array>> {
  if (input.backend.runtimeBucket) {
    const object = await input.context.race(
      Promise.resolve().then(() =>
        input.backend.runtimeBucket!.get(input.handle.key, {
          onlyIf: { etagMatches: input.head.etag },
        }),
      ),
      async (lateObject) => {
        await lateObject?.body?.cancel();
      },
    );
    if (!object) {
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
        "Multipart verification object disappeared after HEAD",
      );
    }
    const metadata = object as RuntimeR2Object & RuntimeR2ObjectMetadata;
    const version = normalizedObjectVersion(metadata.version);
    if (
      normalizedObjectEtag(metadata.etag) !== input.head.etag ||
      version !== input.head.version ||
      (metadata.version !== undefined && version === null) ||
      metadata.size !== input.head.size ||
      metadata.customMetadata?.[MULTIPART_SHA256_METADATA_KEY] !== input.head.declaredSha256 ||
      !metadata.body
    ) {
      if (metadata.body) {
        try {
          registerStreamCancellation(metadata.body, input.context);
        } catch (error) {
          // error-policy:J6 exact generation conflict remains authoritative
          // while failed R2 body-cleanup registration is reported separately.
          reportMultipartCleanupFailure("conflicting-r2-response-body", error);
        }
      }
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
        "Multipart verification GET changed exact object generation",
      );
    }
    return metadata.body;
  }

  let output;
  try {
    output = await input.context.race(
      input.backend.s3Client.send(
        new GetObjectCommand({
          Bucket: input.backend.locator.bucket,
          Key: input.handle.key,
          VersionId: input.head.version ?? undefined,
          IfMatch: input.head.version ? undefined : `"${input.head.etag}"`,
        }),
        { abortSignal: input.context.signal },
      ),
      async (lateOutput) => {
        await streamFromS3Body(lateOutput.Body).cancel();
      },
    );
  } catch (error) {
    // error-policy:J2 authoritative conditional mismatch/disappearance proves
    // generation drift; transient/foreign GET failures remain unconfirmed.
    if (error instanceof ObjectStorageLifecycleError) throw error;
    if (
      isNotFound(error) ||
      providerStatus(error) === 412 ||
      providerCode(error) === "PreconditionFailed"
    ) {
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
        "Multipart verification GET could not retain the HEAD object generation",
        error,
      );
    }
    throw error;
  }
  const version = normalizedObjectVersion(output.VersionId);
  if (
    normalizedObjectEtag(output.ETag) !== input.head.etag ||
    version !== input.head.version ||
    (output.VersionId !== undefined && version === null) ||
    output.ContentLength !== input.head.size ||
    output.Metadata?.[MULTIPART_SHA256_METADATA_KEY] !== input.head.declaredSha256
  ) {
    try {
      registerStreamCancellation(streamFromS3Body(output.Body), input.context);
    } catch (error) {
      // error-policy:J6 exact generation conflict remains authoritative while
      // teardown failure is reported without provider locator details.
      reportMultipartCleanupFailure("conflicting-s3-response-body", error);
    }
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
      "Multipart verification GET changed exact object generation",
    );
  }
  return streamFromS3Body(output.Body);
}

async function drainCompletedBody(input: {
  body: ReadableStream<Uint8Array>;
  expectedSize: number;
  expectedSha256: string;
  context: ProviderRequestContext;
}): Promise<void> {
  const reader = input.body.getReader();
  const hash = createHash("sha256");
  let size = 0;
  try {
    while (true) {
      const next = await input.context.race(Promise.resolve(reader.read()));
      input.context.ensureActive();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        throw lifecycle(
          "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
          "Multipart verification GET returned a non-byte chunk",
        );
      }
      size += next.value.byteLength;
      if (size > input.expectedSize) {
        throw lifecycle(
          "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
          "Multipart verification GET exceeded the exact object size",
        );
      }
      hash.update(next.value);
    }
    if (size !== input.expectedSize || hash.digest("hex") !== input.expectedSha256) {
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
        "Multipart completed object failed exact byte verification",
      );
    }
  } catch (error) {
    // error-policy:J2 retain the exact verification failure after arranging
    // best-effort reader cancellation under durable settlement ownership.
    let cleanup: Promise<void> | null = null;
    try {
      cleanup = Promise.resolve(reader.cancel()).then(() => undefined);
    } catch (cleanupError) {
      // error-policy:J5 the rejected cleanup Promise is observed by the
      // registerCleanup hook immediately below.
      cleanup = Promise.reject(cleanupError);
    }
    if (cleanup) {
      try {
        input.context.registerCleanup(cleanup);
      } catch (registrationError) {
        // error-policy:J6 exact body verification remains authoritative while
        // failed cleanup registration is reported separately.
        reportMultipartCleanupFailure("verification-reader-cancellation", registrationError);
      }
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch (error) {
      // error-policy:J6 a cancelled read can settle after this call; releasing
      // its local lock is best effort and must not replace verification.
      reportMultipartCleanupFailure("verification-reader-release", error);
    }
  }
}

export async function reconcileCompletedObject(input: {
  backend: ExactObjectStorageBackend;
  handle: MultipartObjectUploadHandle;
  context: ProviderRequestContext;
}): Promise<ImmutableObjectUploadReceipt | null> {
  try {
    const head = await headCompletedObject(input);
    if (!head) return null;
    const expectedBase64 = sha256HexToBase64(input.handle.expectedSha256);
    if (head.size !== input.handle.expectedSize || head.declaredSha256 !== expectedBase64) {
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_COMPLETE_CONFLICT",
        "Multipart completed object metadata differs from the exact upload plan",
      );
    }
    const body = await openCompletedBody({ ...input, head });
    await drainCompletedBody({
      body,
      expectedSize: input.handle.expectedSize,
      expectedSha256: input.handle.expectedSha256,
      context: input.context,
    });
    return Object.freeze({
      locator: new ObjectLocatorReceipt({
        ...input.backend.locator,
        keyFingerprint: input.handle.keyFingerprint,
        version: head.version ?? head.etag,
        versionSource: head.version ? "provider" : "etag",
      }),
      metadata: Object.freeze({
        sizeBytes: input.handle.expectedSize,
        checksum: Object.freeze({
          algorithm: "sha256" as const,
          encoding: "base64" as const,
          value: expectedBase64,
        }),
      }),
      verifiedPresent: true as const,
    });
  } catch (error) {
    // error-policy:J2 translate foreign provider/stream failures into the
    // stable unconfirmed code while retaining their cause.
    if (error instanceof ObjectStorageLifecycleError) throw error;
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_COMPLETE_UNCONFIRMED",
      "Multipart completed object could not be verified at the exact provider boundary",
      error,
    );
  }
}
