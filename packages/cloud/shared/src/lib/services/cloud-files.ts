// Coordinates cloud service cloud files behavior behind route handlers.
import { createHash, randomUUID } from "node:crypto";
import { extname } from "node:path";
import {
  type CloudFile,
  type CloudFilesRepository,
  cloudFilesRepository,
} from "../../db/repositories/cloud-files";
import { orgStorageQuotaRepository } from "../../db/repositories/org-storage-quota";
import type { Bindings } from "../../types/cloud-worker-env";
import { publicUrlForR2Key } from "../storage/r2-public-object";
import { logger } from "../utils/logger";

export type CloudFileKind = "image" | "video" | "audio" | "document" | "other";
export type CloudFileSource = "upload" | "generated";

export interface CloudFileStorage {
  put(
    key: string,
    body: ArrayBuffer | ArrayBufferView,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

export interface CloudFileQuotaRepository {
  tryReserveBytes(organizationId: string, bytes: bigint): Promise<bigint | null>;
  releaseBytes(organizationId: string, bytes: bigint): Promise<void>;
}

export class CloudFileQuotaExceededError extends Error {
  constructor() {
    super("Storage quota exceeded for this organization");
    this.name = "CloudFileQuotaExceededError";
  }
}

export interface UploadCloudFileInput {
  organizationId: string;
  userId?: string | null;
  apiKeyId?: string | null;
  file: File;
  metadata?: Record<string, unknown>;
}

export interface RecordGeneratedCloudFileInput {
  organizationId: string;
  userId?: string | null;
  apiKeyId?: string | null;
  generationId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  storageUrl: string;
  metadata?: Record<string, unknown>;
}

export interface CloudFileListInput {
  organizationId: string;
  limit?: number;
  offset?: number;
  source?: string;
  kind?: string;
  mimeType?: string;
  search?: string;
}

export class CloudFilesService {
  constructor(
    private readonly repository: CloudFilesRepository = cloudFilesRepository,
    private readonly quotaRepository: CloudFileQuotaRepository = orgStorageQuotaRepository,
  ) {}

  async list(input: CloudFileListInput) {
    return await this.repository.listByOrganization(input.organizationId, {
      limit: input.limit,
      offset: input.offset,
      source: input.source,
      kind: input.kind,
      mimeType: input.mimeType,
      search: input.search,
    });
  }

  async get(organizationId: string, id: string): Promise<CloudFile | undefined> {
    return await this.repository.findActiveByOrgAndId(organizationId, id);
  }

  async upload(env: Bindings, input: UploadCloudFileInput): Promise<CloudFile> {
    if (!env.BLOB) {
      throw new Error("R2 storage is not configured");
    }

    const bytes = new Uint8Array(await input.file.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const mimeType = input.file.type || "application/octet-stream";
    const filename = sanitizeFilename(input.file.name || "upload");
    const extension = extensionForFile(filename, mimeType);
    const objectId = randomUUID();
    const key = [
      "cloud-files",
      input.organizationId,
      new Date().toISOString().slice(0, 10),
      `${objectId}-${sha256.slice(0, 16)}${extension}`,
    ].join("/");

    const sizeBytes = BigInt(bytes.byteLength);
    const reserved = await this.quotaRepository.tryReserveBytes(input.organizationId, sizeBytes);
    if (reserved === null) {
      throw new CloudFileQuotaExceededError();
    }

    let wroteObject = false;
    try {
      await env.BLOB.put(key, bytes, {
        httpMetadata: { contentType: mimeType },
        customMetadata: {
          organizationId: input.organizationId,
          userId: input.userId ?? "",
          sha256,
          source: "upload",
        },
      });
      wroteObject = true;
      return await this.repository.create({
        id: objectId,
        organization_id: input.organizationId,
        user_id: input.userId ?? null,
        api_key_id: input.apiKeyId ?? null,
        source: "upload",
        kind: kindFromMime(mimeType),
        filename,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        sha256,
        storage_key: key,
        storage_url: publicUrlForR2Key(env, key),
        metadata: input.metadata ?? {},
      });
    } catch (error) {
      if (wroteObject) {
        await env.BLOB.delete(key).catch((deleteError) => {
          logger.warn("[CloudFiles] Failed to clean up object after metadata insert failure", {
            storageKey: key,
            error: deleteError instanceof Error ? deleteError.message : String(deleteError),
          });
        });
      }
      await this.quotaRepository.releaseBytes(input.organizationId, sizeBytes);
      throw error;
    }
  }

  async recordGenerated(input: RecordGeneratedCloudFileInput): Promise<CloudFile> {
    return await this.repository.create({
      organization_id: input.organizationId,
      user_id: input.userId ?? null,
      api_key_id: input.apiKeyId ?? null,
      generation_id: input.generationId,
      source: "generated",
      kind: kindFromMime(input.mimeType),
      filename: sanitizeFilename(input.filename),
      mime_type: input.mimeType,
      size_bytes: BigInt(input.sizeBytes),
      sha256: input.sha256,
      storage_key: input.storageKey,
      storage_url: input.storageUrl,
      metadata: input.metadata ?? {},
    });
  }

  async delete(env: Bindings, organizationId: string, id: string): Promise<CloudFile | undefined> {
    const deleted = await this.repository.softDeleteByOrgAndId(organizationId, id);
    if (!deleted || !env.BLOB) return deleted;

    const activeReferences = await this.repository.activeStorageKeyReferences(
      organizationId,
      deleted.storage_key,
    );
    if (activeReferences > 0) return deleted;

    try {
      await env.BLOB.delete(deleted.storage_key);
      if (deleted.source === "upload") {
        await this.quotaRepository.releaseBytes(organizationId, deleted.size_bytes);
      }
    } catch (error) {
      logger.warn("[CloudFiles] Failed to delete object after file deletion", {
        id,
        storageKey: deleted.storage_key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return deleted;
  }
}

export function kindFromMime(mimeType: string): CloudFileKind {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/pdf" ||
    mimeType.includes("document") ||
    mimeType.includes("json")
  ) {
    return "document";
  }
  return "other";
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^\w .+=@()-]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 180) : "upload";
}

function extensionForFile(filename: string, mimeType: string): string {
  const existing = extname(filename).toLowerCase();
  if (existing && existing.length <= 12) return existing;
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "video/mp4") return ".mp4";
  if (mimeType === "audio/mpeg") return ".mp3";
  if (mimeType === "application/pdf") return ".pdf";
  return ".bin";
}

export const cloudFilesService = new CloudFilesService();
