/** Workers R2 and S3-compatible multipart provider adapters. */

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type { ExactObjectStorageBackend } from "./object-store";
import {
  lateAbortCreatedUpload,
  type ProviderRequestContext,
} from "./object-store-multipart-control";
import {
  isNoSuchUpload,
  lifecycle,
  MAX_MULTIPART_OBJECT_PARTS,
  MULTIPART_SHA256_METADATA_KEY,
  type MultipartObjectPartReceipt,
  type MultipartObjectUploadHandle,
  normalizedEtag,
  type ProviderMultipartHandle,
  requireUploadId,
  sha256HexToBase64,
  type ValidatedMultipartObjectUploadPlan,
} from "./object-store-multipart-types";
import type {
  RuntimeR2MultipartOptions,
  RuntimeR2MultipartUpload,
  RuntimeR2UploadedPart,
} from "./r2-runtime-binding";

export type S3MultipartBackend = Extract<ExactObjectStorageBackend, { s3Client: unknown }>;

export function providerHandleForS3(
  backend: S3MultipartBackend,
  key: string,
  uploadId: string,
): ProviderMultipartHandle {
  return {
    key,
    uploadId,
    async uploadPart(partNumber, body, checksumBase64, signal) {
      const output = await backend.s3Client.send(
        new UploadPartCommand({
          Bucket: backend.locator.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
          Body: body,
          ContentLength: body.byteLength,
          ChecksumSHA256: checksumBase64,
        }),
        { abortSignal: signal },
      );
      return {
        partNumber,
        etag: normalizedEtag(output.ETag),
        ...(output.ChecksumSHA256 ? { checksumBase64: output.ChecksumSHA256 } : {}),
      };
    },
    async complete(parts, signal) {
      return backend.s3Client.send(
        new CompleteMultipartUploadCommand({
          Bucket: backend.locator.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              PartNumber: part.partNumber,
              ETag: part.etag,
              ChecksumSHA256: sha256HexToBase64(part.bodySha256),
            })),
          },
        }),
        { abortSignal: signal },
      );
    },
    async abort(signal) {
      await backend.s3Client.send(
        new AbortMultipartUploadCommand({
          Bucket: backend.locator.bucket,
          Key: key,
          UploadId: uploadId,
        }),
        { abortSignal: signal },
      );
    },
  };
}

export function providerHandleForRuntime(
  upload: RuntimeR2MultipartUpload,
): ProviderMultipartHandle {
  return {
    key: upload.key,
    uploadId: upload.uploadId,
    async uploadPart(partNumber, body) {
      const part = await upload.uploadPart(partNumber, body);
      return { partNumber: part.partNumber, etag: normalizedEtag(part.etag) };
    },
    async complete(parts) {
      const runtimeParts: RuntimeR2UploadedPart[] = parts.map((part) => ({
        partNumber: part.partNumber,
        etag: part.etag,
      }));
      return upload.complete(runtimeParts);
    },
    abort: () => upload.abort(),
  };
}

export function requireRuntimeMultipart(backend: ExactObjectStorageBackend): {
  createMultipartUpload: (
    key: string,
    options?: RuntimeR2MultipartOptions,
  ) => Promise<RuntimeR2MultipartUpload>;
  resumeMultipartUpload: (key: string, uploadId: string) => RuntimeR2MultipartUpload;
} {
  const bucket = backend.runtimeBucket;
  if (
    !bucket ||
    typeof bucket.createMultipartUpload !== "function" ||
    typeof bucket.resumeMultipartUpload !== "function"
  ) {
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_UNSUPPORTED",
      "Worker R2 binding does not expose multipart upload operations",
    );
  }
  return {
    createMultipartUpload: bucket.createMultipartUpload.bind(bucket),
    resumeMultipartUpload: bucket.resumeMultipartUpload.bind(bucket),
  };
}

export async function createProviderHandle(input: {
  backend: ExactObjectStorageBackend;
  plan: ValidatedMultipartObjectUploadPlan;
  context: ProviderRequestContext;
}): Promise<ProviderMultipartHandle> {
  const expectedBase64 = sha256HexToBase64(input.plan.expectedSha256);
  if (input.backend.runtimeBucket) {
    const multipart = requireRuntimeMultipart(input.backend);
    const request = Promise.resolve().then(() =>
      multipart.createMultipartUpload(input.plan.key, {
        httpMetadata: { contentType: input.plan.contentType },
        customMetadata: { [MULTIPART_SHA256_METADATA_KEY]: expectedBase64 },
      }),
    );
    const upload = await input.context.race(request, async (lateUpload) => {
      const lateHandle = providerHandleForRuntime(lateUpload);
      requireUploadId(lateHandle.uploadId);
      await lateAbortCreatedUpload(lateHandle);
    });
    return providerHandleForRuntime(upload);
  }

  const s3Backend = input.backend as S3MultipartBackend;
  const output = await input.context.race(
    s3Backend.s3Client.send(
      new CreateMultipartUploadCommand({
        Bucket: s3Backend.locator.bucket,
        Key: input.plan.key,
        ContentType: input.plan.contentType,
        Metadata: { [MULTIPART_SHA256_METADATA_KEY]: expectedBase64 },
        ChecksumAlgorithm: "SHA256",
      }),
      { abortSignal: input.context.signal },
    ),
    async (lateOutput) => {
      if (!lateOutput.UploadId) return;
      await lateAbortCreatedUpload(
        providerHandleForS3(s3Backend, input.plan.key, requireUploadId(lateOutput.UploadId)),
      );
    },
  );
  const uploadId = requireUploadId(output.UploadId);
  const provider = providerHandleForS3(s3Backend, input.plan.key, uploadId);
  if (
    (output.Key !== undefined && output.Key !== input.plan.key) ||
    (output.Bucket !== undefined && output.Bucket !== s3Backend.locator.bucket)
  ) {
    // The returned upload id is ours, but provider-echoed locator metadata is
    // inconsistent. Abort using the exact requested bucket/key before failing.
    input.context.registerCleanup(lateAbortCreatedUpload(provider));
    throw lifecycle(
      "OBJECT_STORAGE_MULTIPART_CREATE_INDETERMINATE",
      "Multipart storage returned a handle for another exact locator",
    );
  }
  return provider;
}

export async function verifyS3Resume(input: {
  backend: S3MultipartBackend;
  handle: MultipartObjectUploadHandle;
  acknowledgedParts: readonly MultipartObjectPartReceipt[];
  context: ProviderRequestContext;
}): Promise<"active" | "missing"> {
  const observed = new Map<number, { etag: string; size: number; checksum?: string }>();
  let marker: string | undefined;
  do {
    let page;
    try {
      page = await input.context.race(
        input.backend.s3Client.send(
          new ListPartsCommand({
            Bucket: input.backend.locator.bucket,
            Key: input.handle.key,
            UploadId: input.handle.uploadId,
            PartNumberMarker: marker,
            MaxParts: MAX_MULTIPART_OBJECT_PARTS,
          }),
          { abortSignal: input.context.signal },
        ),
      );
    } catch (error) {
      if (isNoSuchUpload(error)) return "missing";
      throw error;
    }
    if (
      (page.Key !== undefined && page.Key !== input.handle.key) ||
      (page.Bucket !== undefined && page.Bucket !== input.backend.locator.bucket) ||
      (page.UploadId !== undefined && page.UploadId !== input.handle.uploadId)
    ) {
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_HANDLE_MISMATCH",
        "Multipart provider listed parts for another exact handle",
      );
    }
    for (const part of page.Parts ?? []) {
      if (
        !Number.isSafeInteger(part.PartNumber) ||
        part.PartNumber === undefined ||
        part.PartNumber < 1 ||
        part.PartNumber > input.handle.partCount ||
        !Number.isSafeInteger(part.Size) ||
        part.Size === undefined ||
        part.Size < 1 ||
        observed.has(part.PartNumber)
      ) {
        throw lifecycle(
          "OBJECT_STORAGE_MULTIPART_HANDLE_MISMATCH",
          "Multipart provider returned invalid part inventory",
        );
      }
      observed.set(part.PartNumber, {
        etag: normalizedEtag(part.ETag),
        size: part.Size,
        ...(part.ChecksumSHA256 ? { checksum: part.ChecksumSHA256 } : {}),
      });
    }
    if (page.IsTruncated === true) {
      if (!page.NextPartNumberMarker || page.NextPartNumberMarker === marker) {
        throw lifecycle(
          "OBJECT_STORAGE_MULTIPART_HANDLE_MISMATCH",
          "Multipart provider returned an invalid part cursor",
        );
      }
      marker = page.NextPartNumberMarker;
    } else {
      marker = undefined;
    }
  } while (marker !== undefined);

  for (const receipt of input.acknowledgedParts) {
    const part = observed.get(receipt.partNumber);
    if (
      !part ||
      part.etag !== receipt.etag ||
      part.size !== receipt.sizeBytes ||
      (part.checksum !== undefined && part.checksum !== sha256HexToBase64(receipt.bodySha256))
    ) {
      throw lifecycle(
        "OBJECT_STORAGE_MULTIPART_PART_CONFLICT",
        "Multipart persisted part receipt no longer matches provider inventory",
      );
    }
  }
  return "active";
}
