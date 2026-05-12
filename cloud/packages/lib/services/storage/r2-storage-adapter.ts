/**
 * R2-over-S3 storage adapter for the `/v1/apis/storage/*` proxy.
 *
 * Wraps `@brighter/storage-adapter-s3` with a strictly-typed surface so the
 * route handler never touches the loose `string | Buffer` / `any` shapes the
 * upstream package uses. The adapter is instantiated lazily (per Worker
 * isolate) from R2 env vars so cold-start cost is paid only when the route
 * is actually called.
 *
 * The adapter is bucket-scoped at construction time. Per-org key scoping
 * (`org/${organization_id}/${userKey}`) is the route handler's responsibility,
 * not the adapter's.
 */

import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { Storage } from "@brighter/storage-adapter-s3";
import type { Bindings } from "@/types/cloud-worker-env";

type BrighterS3StorageInstance = ReturnType<typeof Storage>;

/** Stat output for a single stored object. */
export interface StorageObjectStat {
  /** Storage key (bucket-relative). */
  file: string;
  /** MIME type. Always set; defaults to `application/octet-stream`. */
  contentType: string;
  /** Server-assigned entity tag. */
  etag: string;
  /** Object size in bytes. */
  size: number;
  /** Last-modified timestamp. */
  modified: Date;
  /** Public S3 URL (NOT signed; useful for diagnostics). */
  url: string;
}

/**
 * Strictly-typed R2 storage adapter. Instances are bucket-scoped; the
 * route handler prepends per-org prefixes when it constructs storage keys.
 */
export class R2StorageAdapter {
  constructor(private readonly storage: BrighterS3StorageInstance) {}

  async write(key: string, data: Buffer): Promise<void> {
    await this.storage.write(key, data, { encoding: "binary" });
  }

  async read(key: string): Promise<Buffer> {
    const result = await this.storage.read(key, { encoding: "binary" });
    if (typeof result === "string") {
      return Buffer.from(result, "binary");
    }
    return result;
  }

  async stat(key: string): Promise<StorageObjectStat> {
    const result = await this.storage.stat(key);
    return {
      file: String(result.file),
      contentType: String(result.contentType),
      etag: String(result.etag),
      size: Number(result.size),
      modified: result.modified instanceof Date ? result.modified : new Date(result.modified),
      url: String(result.url),
    };
  }

  async exists(key: string): Promise<boolean> {
    return this.storage.exists(key);
  }

  async remove(key: string): Promise<void> {
    await this.storage.remove(key);
  }

  async list(prefix: string, options: { recursive?: boolean } = {}): Promise<Array<string>> {
    return this.storage.list(prefix, {
      recursive: options.recursive ?? true,
      absolute: false,
    });
  }

  async presign(key: string, expiresIn: number): Promise<string> {
    return this.storage.presign(key, { expiresIn });
  }
}

interface R2Config {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region: string;
}

function readR2Config(env: Bindings): R2Config | null {
  const endpoint = typeof env.R2_ENDPOINT === "string" ? env.R2_ENDPOINT : undefined;
  const accessKeyId = typeof env.R2_ACCESS_KEY_ID === "string" ? env.R2_ACCESS_KEY_ID : undefined;
  const secretAccessKey =
    typeof env.R2_SECRET_ACCESS_KEY === "string" ? env.R2_SECRET_ACCESS_KEY : undefined;
  const bucket = typeof env.R2_BUCKET === "string" ? env.R2_BUCKET : undefined;
  const region = typeof env.R2_REGION === "string" ? env.R2_REGION : "auto";

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    return null;
  }
  return { endpoint, accessKeyId, secretAccessKey, bucket, region };
}

let cachedAdapter: R2StorageAdapter | null = null;
let cachedAdapterFingerprint = "";

/**
 * Returns a memoized R2 adapter, or `null` if any of the required env vars
 * are missing. The route handler treats `null` as a 503 (R2 not configured).
 *
 * Callers must NOT reuse the returned adapter across env-var rotations;
 * the cache is keyed by a fingerprint of the resolved config so a Wrangler
 * secret rotation will rebuild on the next request.
 */
export function getR2StorageAdapter(env: Bindings): R2StorageAdapter | null {
  const config = readR2Config(env);
  if (!config) {
    return null;
  }
  const fingerprint = `${config.endpoint}|${config.bucket}|${config.accessKeyId}|${config.region}`;
  if (cachedAdapter && cachedAdapterFingerprint === fingerprint) {
    return cachedAdapter;
  }
  const clientOptions: S3ClientConfig = {
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  };
  const storage = Storage({ path: config.bucket }, clientOptions);
  cachedAdapter = new R2StorageAdapter(storage);
  cachedAdapterFingerprint = fingerprint;
  return cachedAdapter;
}

/**
 * Test-only injection point. Allows unit tests to install a fake adapter
 * without going through `getR2StorageAdapter` and without requiring R2
 * env vars. Pass `null` to clear.
 */
export function __setTestR2StorageAdapter(adapter: R2StorageAdapter | null): void {
  cachedAdapter = adapter;
  cachedAdapterFingerprint = adapter ? "__test__" : "";
}
