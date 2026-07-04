/**
 * Default backend for `ServiceType.REMOTE_FILES` — the file-storage contract
 * the rest of the runtime resolves via `runtime.getService(REMOTE_FILES)`
 * (`api/files-routes.ts` and the `actions/files.ts` FILES tool both go through
 * it). Persists bytes into the single content-addressed agent media store and
 * returns served `/api/media/<sha256>.<ext>` handles, so a cloud-backed
 * implementation can fill the same slot later without changing callers.
 */

import { Buffer } from "node:buffer";
import {
  type IAgentRuntime,
  IFileStorageService,
  type StoredFile,
  type StoredFileListItem,
} from "@elizaos/core";
import {
  deleteMediaFile,
  listMediaFiles,
  mediaFileNameFromUrl,
  persistMediaBytes,
} from "../api/media-store.ts";

const DATA_URL_RE = /^data:([^;,]*)(;base64)?,([\s\S]*)$/;

/**
 * Local-disk, content-addressed implementation of {@link IFileStorageService},
 * wrapping the agent media store (`${STATE_DIR}/media/<sha256>.<ext>`). This is
 * the default file-storage backend; a cloud-backed implementation can fill the
 * same `ServiceType.REMOTE_FILES` slot later without callers changing.
 */
export class LocalFileStorageService extends IFileStorageService {
  override readonly capabilityDescription =
    "Local content-addressed file storage (store, serve, list, delete) backed by the agent media store.";

  static async start(runtime: IAgentRuntime): Promise<LocalFileStorageService> {
    return new LocalFileStorageService(runtime);
  }

  async stop(): Promise<void> {}

  async store(
    bytes: Buffer | Uint8Array,
    mimeType: string,
  ): Promise<StoredFile> {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const persisted = persistMediaBytes(buffer, mimeType);
    return {
      url: persisted.url,
      hash: persisted.hash,
      fileName: persisted.fileName,
      mimeType,
      size: buffer.length,
    };
  }

  async storeDataUrl(dataUrl: string): Promise<StoredFile | null> {
    const match = DATA_URL_RE.exec(dataUrl.trim());
    if (!match) return null;
    const mimeType = match[1] || "application/octet-stream";
    const isBase64 = Boolean(match[2]);
    const payload = match[3] ?? "";
    let buffer: Buffer;
    try {
      buffer = isBase64
        ? Buffer.from(payload, "base64")
        : Buffer.from(decodeURIComponent(payload), "utf8");
    } catch {
      return null;
    }
    if (buffer.length === 0) return null;
    return this.store(buffer, mimeType);
  }

  getUrl(fileName: string): string | null {
    const url = `/api/media/${fileName}`;
    return mediaFileNameFromUrl(url) ? url : null;
  }

  async exists(fileName: string): Promise<boolean> {
    if (!this.getUrl(fileName)) return false;
    return listMediaFiles().some((file) => file.fileName === fileName);
  }

  async list(): Promise<StoredFileListItem[]> {
    return listMediaFiles().map((file) => ({
      url: file.url,
      hash: file.hash,
      fileName: file.fileName,
      mimeType: file.mimeType,
      size: file.size,
      createdAt: file.createdAt,
    }));
  }

  async delete(fileName: string): Promise<boolean> {
    return deleteMediaFile(fileName);
  }
}
