import { promises as fsp } from "node:fs";
import path from "node:path";
import { Storage } from "@brighter/storage-adapter-local";
import { type IAgentRuntime, logger, resolveStateDir, Service, ServiceType } from "@elizaos/core";

import type { JsonUploadResult, JsonValue, UploadResult } from "../types";

/**
 * Subset of the @brighter/storage-adapter-local interface that this service
 * actually exercises. Typed locally to avoid leaking the upstream package's
 * loose `string | Buffer` return types into our public API.
 */
interface LocalStorage {
  write(path: string, data: Buffer | string, opts?: { encoding?: string }): Promise<void>;
  read(path: string, opts?: { encoding?: string }): Promise<Buffer | string | undefined>;
  exists(path: string): Promise<boolean>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
}

/**
 * Resolves the storage root directory. Order of precedence:
 *
 *   1. `runtime.getSetting("LOCAL_STORAGE_PATH")`
 *   2. `process.env.LOCAL_STORAGE_PATH`
 *   3. `<resolveStateDir()>/attachments`
 */
function resolveStorageRoot(runtime: IAgentRuntime): string {
  const fromRuntime = runtime.getSetting("LOCAL_STORAGE_PATH");
  if (typeof fromRuntime === "string" && fromRuntime.length > 0) {
    return path.resolve(fromRuntime);
  }
  const fromEnv = process.env.LOCAL_STORAGE_PATH;
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }
  return path.join(resolveStateDir(), "attachments");
}

function joinKey(...segments: Array<string | undefined>): string {
  const joined = segments
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("/");
  return joined.replace(/\/+/g, "/").replace(/^\/+/, "");
}

/**
 * Local filesystem implementation of `ServiceType.REMOTE_FILES`. Backed by
 * `@brighter/storage-adapter-local`. Method names mirror the surface that
 * the removed `@elizaos/plugin-s3-storage` `AwsS3Service` exposed so call
 * sites can be retargeted with no refactor.
 */
export class LocalFileStorageService extends Service {
  static override serviceType = ServiceType.REMOTE_FILES;
  capabilityDescription = "Local filesystem attachment storage";

  private storage: LocalStorage | null = null;
  private storageRoot = "";

  static override async start(runtime: IAgentRuntime): Promise<LocalFileStorageService> {
    logger.log("Initializing LocalFileStorageService");
    const service = new LocalFileStorageService(runtime);
    await service.initialize(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(ServiceType.REMOTE_FILES);
    if (service) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {
    this.storage = null;
  }

  /**
   * Filesystem path to the storage root. Useful for tests and tooling.
   */
  get root(): string {
    return this.storageRoot;
  }

  private async initialize(runtime: IAgentRuntime): Promise<void> {
    this.storageRoot = resolveStorageRoot(runtime);
    await fsp.mkdir(this.storageRoot, { recursive: true });
    this.storage = Storage({ path: this.storageRoot });
  }

  private getStorage(): LocalStorage {
    if (!this.storage) {
      throw new Error("LocalFileStorageService not initialized");
    }
    return this.storage;
  }

  private absolutePath(key: string): string {
    return path.join(this.storageRoot, key);
  }

  private fileUrl(key: string): string {
    return `file://${this.absolutePath(key)}`;
  }

  /**
   * Copy a file from the filesystem into the storage root.
   *
   * @param filePath Source path on the local filesystem.
   * @param subDirectory Optional subdirectory under the storage root.
   */
  async uploadFile(filePath: string, subDirectory?: string): Promise<UploadResult> {
    const storage = this.getStorage();
    const baseFileName = `${Date.now()}-${path.basename(filePath)}`;
    const key = joinKey(subDirectory, baseFileName);
    const buffer = await fsp.readFile(filePath);
    await storage.write(key, buffer, { encoding: "binary" });
    return { success: true, url: this.fileUrl(key) };
  }

  /**
   * Write raw bytes under a fixed key.
   *
   * @param data         Bytes to write.
   * @param fileName     Final segment of the storage key.
   * @param contentType  Reserved for API parity with the previous S3
   *                     service. Local storage does not record per-object
   *                     content types beyond what the OS infers, so this
   *                     value is currently unused.
   * @param subDirectory Optional subdirectory under the storage root.
   */
  async uploadBytes(
    data: Buffer | Uint8Array,
    fileName: string,
    contentType: string,
    subDirectory?: string
  ): Promise<UploadResult> {
    const storage = this.getStorage();
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const key = joinKey(subDirectory, fileName);
    await storage.write(key, buffer, { encoding: "binary" });
    void contentType;
    return { success: true, url: this.fileUrl(key) };
  }

  /**
   * Serialize a JSON-shaped value and write it under a fixed key.
   *
   * @param jsonData     The object to serialize.
   * @param fileName     Optional filename. Defaults to `${Date.now()}.json`.
   * @param subDirectory Optional subdirectory under the storage root.
   */
  async uploadJson(
    jsonData: Record<string, JsonValue>,
    fileName?: string,
    subDirectory?: string
  ): Promise<JsonUploadResult> {
    if (!jsonData) {
      return { success: false, error: "JSON data is required" };
    }
    const storage = this.getStorage();
    const actualFileName = fileName ?? `${Date.now()}.json`;
    const key = joinKey(subDirectory, actualFileName);
    const body = JSON.stringify(jsonData, null, 2);
    await storage.write(key, body, { encoding: "utf8" });
    return { success: true, key, url: this.fileUrl(key) };
  }

  /**
   * Read bytes for a previously-stored key.
   *
   * @param _unusedBucket Kept for API parity with the previous S3 service.
   *                      Local storage has no bucket concept; the value is
   *                      ignored and the key resolves under the storage
   *                      root.
   * @param key           Storage key (relative path under the root).
   */
  async downloadBytes(_unusedBucket: string, key: string): Promise<Buffer> {
    const storage = this.getStorage();
    const result = await storage.read(key, { encoding: "binary" });
    if (result === undefined) {
      throw new Error(`Object not found: ${key}`);
    }
    if (typeof result === "string") {
      // Defensive: brighter local always returns Buffer when encoding is
      // 'binary', but the upstream type signature allows string. Keep the
      // public API a strict Buffer.
      return Buffer.from(result, "binary");
    }
    return result;
  }

  /**
   * Read bytes and write them to a local filesystem path.
   */
  async downloadFile(_unusedBucket: string, key: string, localPath: string): Promise<void> {
    const buffer = await this.downloadBytes(_unusedBucket, key);
    await fsp.writeFile(localPath, buffer);
  }

  /**
   * Remove a stored object. Idempotent: removing a missing key throws.
   */
  async delete(_unusedBucket: string, key: string): Promise<void> {
    const storage = this.getStorage();
    await storage.remove(key);
  }

  /**
   * Whether a stored object exists.
   */
  async exists(_unusedBucket: string, key: string): Promise<boolean> {
    const storage = this.getStorage();
    return storage.exists(key);
  }

  /**
   * Returns a `file://` absolute URL for the stored object.
   *
   * Local storage cannot mint short-lived signed URLs the way S3 can — the
   * URL is permanent and exposes the absolute filesystem path. Callers that
   * need a public, expiring URL should route attachment storage through
   * Eliza Cloud instead.
   *
   * @param fileName    Storage key (relative path under the root).
   * @param _expiresIn  Reserved for API parity with the previous S3 service.
   */
  async generateSignedUrl(fileName: string, _expiresIn?: number): Promise<string> {
    return this.fileUrl(fileName);
  }
}

export default LocalFileStorageService;
