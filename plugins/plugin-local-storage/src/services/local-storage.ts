import { promises as fsp } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

function normalizeStorageKey(...segments: Array<string | undefined>): string {
  for (const segment of segments) {
    if (typeof segment === "string" && (path.isAbsolute(segment) || /^[A-Za-z]:/.test(segment))) {
      throw new Error(`Invalid local storage key: ${segment}`);
    }
  }
  const raw = joinKey(...segments).replace(/\\/g, "/");
  const rawParts = raw.split("/").filter((part) => part.length > 0);
  const normalized = path.posix.normalize(raw);
  if (
    !raw ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    rawParts.some((part) => part === "." || part === "..") ||
    /^[A-Za-z]:/.test(raw)
  ) {
    throw new Error(`Invalid local storage key: ${raw || "<empty>"}`);
  }
  return normalized;
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
    // POSIX absolute paths produce `file:///foo/bar`; Windows absolute paths
    // need `file:///C:/foo/bar` (three slashes + drive letter + forward
    // slashes). `pathToFileURL` handles both correctly, including spaces
    // and other characters that need percent-encoding.
    return pathToFileURL(this.absolutePath(key)).href;
  }

  /**
   * Ensure every parent directory under the storage root exists before the
   * adapter writes to the leaf. `@brighter/storage-adapter-local` does
   * `fs.writeFile` directly — on Windows the intermediate dirs aren't
   * auto-created, so writes to `nested/dir/sample.bin` fail with ENOENT.
   */
  private async ensureKeyDir(key: string): Promise<void> {
    const target = this.absolutePath(key);
    await fsp.mkdir(path.dirname(target), { recursive: true });
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
    const key = normalizeStorageKey(subDirectory, baseFileName);
    const buffer = await fsp.readFile(filePath);
    await this.ensureKeyDir(key);
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
    const key = normalizeStorageKey(subDirectory, fileName);
    await this.ensureKeyDir(key);
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
    const key = normalizeStorageKey(subDirectory, actualFileName);
    const body = JSON.stringify(jsonData, null, 2);
    await this.ensureKeyDir(key);
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
    const safeKey = normalizeStorageKey(key);
    const result = await storage.read(safeKey, { encoding: "binary" });
    if (result === undefined) {
      throw new Error(`Object not found: ${safeKey}`);
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
    await storage.remove(normalizeStorageKey(key));
  }

  /**
   * Whether a stored object exists.
   */
  async exists(_unusedBucket: string, key: string): Promise<boolean> {
    const storage = this.getStorage();
    try {
      return await storage.exists(normalizeStorageKey(key));
    } catch (err: unknown) {
      // `@brighter/storage-adapter-local`'s `exists()` calls `fs.access`,
      // which throws ENOENT on Windows when the file is missing instead
      // of returning false. Coerce the absence case to `false` so the
      // public method behaves identically on every platform.
      const e = err as NodeJS.ErrnoException;
      if (e?.code === "ENOENT") return false;
      throw err;
    }
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
    return this.fileUrl(normalizeStorageKey(fileName));
  }
}

export default LocalFileStorageService;
