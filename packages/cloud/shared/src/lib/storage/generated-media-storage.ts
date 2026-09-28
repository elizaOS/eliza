/**
 * Generated media (images, music, sound effects) stored in Cloud R2 counts
 * toward the organization's single storage quota (#20956). There is no
 * separate media quota: the same `org_storage_quota` row, plan ceiling and
 * usage figure cover attachments, avatars and generated media.
 *
 * Policy at each boundary:
 * - Before paid provider work: a full quota is refused with 413 and no charge.
 * - After generation: the exact output bytes are reserved before the R2 write.
 *   If they no longer fit, nothing is written and the request fails with 413;
 *   provider work that already ran is settled like any other post-dispatch
 *   failure.
 * - Cleanup and deletion release the reservation only once the object is
 *   confirmed gone, so usage is never undercounted.
 */

import { orgStorageQuotaRepository } from "../../db/repositories/org-storage-quota";
import { ApiError } from "../api/cloud-worker-errors";
import { logger } from "../utils/logger";
import { type PublicObjectBindings, putPublicObject } from "./r2-public-object";

/** Storage-quota boundary used by generated media; the default is the org quota repository. */
export interface GeneratedMediaStorageQuota {
  hasHeadroom(organizationId: string): Promise<boolean>;
  tryReserveBytes(organizationId: string, bytes: bigint): Promise<bigint | null>;
  releaseBytes(organizationId: string, bytes: bigint): Promise<void>;
}

export const organizationStorageQuota: GeneratedMediaStorageQuota = orgStorageQuotaRepository;

/** Typed 413 raised when generated media does not fit the storage quota. */
export class GeneratedMediaStorageQuotaError extends ApiError {
  constructor(organizationId: string, bytes?: bigint) {
    super({
      status: 413,
      code: "storage_quota_exceeded",
      message:
        "Storage quota exceeded for this organization. Delete stored files or generated media, or upgrade your plan.",
      details: { organizationId, ...(bytes === undefined ? {} : { bytes: bytes.toString() }) },
    });
    this.name = "GeneratedMediaStorageQuotaError";
  }
}

/** Refuses paid generation up front when the organization's storage is already full. */
export async function assertGeneratedMediaStorageHeadroom(
  organizationId: string,
  quota: GeneratedMediaStorageQuota = organizationStorageQuota,
): Promise<void> {
  if (!(await quota.hasHeadroom(organizationId))) {
    throw new GeneratedMediaStorageQuotaError(organizationId);
  }
}

export interface StoredGeneratedMedia {
  url: string;
  key: string;
  sizeBytes: number;
  /** Bytes reserved against the storage quota; recorded on the generation row. */
  storageQuotaBytes: string;
}

/** Reserves the exact bytes, then writes the object; nothing is written if they do not fit. */
export async function putGeneratedMediaObject(
  bindings: PublicObjectBindings,
  input: {
    organizationId: string;
    key: string;
    body: ArrayBuffer | ArrayBufferView;
    contentType: string;
    customMetadata?: Record<string, string>;
  },
  quota: GeneratedMediaStorageQuota = organizationStorageQuota,
  put: typeof putPublicObject = putPublicObject,
): Promise<StoredGeneratedMedia> {
  const bytes = BigInt(input.body.byteLength);
  const reserved = await quota.tryReserveBytes(input.organizationId, bytes);
  if (reserved === null) {
    throw new GeneratedMediaStorageQuotaError(input.organizationId, bytes);
  }
  try {
    const stored = await put(bindings, {
      key: input.key,
      body: input.body,
      contentType: input.contentType,
      customMetadata: input.customMetadata,
    });
    return {
      url: stored.url,
      key: stored.key,
      sizeBytes: input.body.byteLength,
      storageQuotaBytes: bytes.toString(),
    };
  } catch (error) {
    // error-policy:J6 a rejected write is ambiguous: release the reservation
    // only after the object is confirmed gone, then rethrow the put failure.
    await discardGeneratedMediaObject(bindings, {
      organizationId: input.organizationId,
      key: input.key,
      storageQuotaBytes: bytes.toString(),
    });
    throw error;
  }
}

/**
 * Deletes a generated object and releases its reservation. Returns false when
 * the object could not be confirmed deleted; the reservation is then kept so
 * the object is still counted. Never throws, so callers keep their causal error.
 */
export async function discardGeneratedMediaObject(
  bindings: PublicObjectBindings,
  input: { organizationId: string; key: string; storageQuotaBytes: string | null | undefined },
  quota: GeneratedMediaStorageQuota = organizationStorageQuota,
): Promise<boolean> {
  try {
    await bindings.BLOB.delete(input.key);
  } catch (error) {
    // error-policy:J6 keep the reservation while the object may still exist.
    logger.warn("[GeneratedMediaStorage] Failed to delete generated object", {
      organizationId: logger.redact.orgId(input.organizationId),
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  await releaseGeneratedMediaStorage(input.organizationId, input.storageQuotaBytes, quota);
  return true;
}

/** Releases a recorded reservation after its object is confirmed deleted. Never throws. */
export async function releaseGeneratedMediaStorage(
  organizationId: string,
  storageQuotaBytes: string | null | undefined,
  quota: GeneratedMediaStorageQuota = organizationStorageQuota,
): Promise<void> {
  if (typeof storageQuotaBytes !== "string" || !/^\d+$/.test(storageQuotaBytes)) return;
  try {
    await quota.releaseBytes(organizationId, BigInt(storageQuotaBytes));
  } catch (error) {
    // error-policy:J6 a failed release over-counts usage (never under-counts)
    // and must not replace the caller's result.
    logger.warn("[GeneratedMediaStorage] Failed to release storage reservation", {
      organizationId: logger.redact.orgId(organizationId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
