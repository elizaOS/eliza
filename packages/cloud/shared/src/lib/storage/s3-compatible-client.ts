/**
 * Provider-agnostic S3 client for object storage.
 *
 * Production: Cloudflare R2.
 * Local dev: self-hosted Supabase Storage (S3 protocol at /storage/v1/s3).
 * Other providers: AWS-S3-compatible endpoints.
 *
 * Selection rules (see docs/object-storage.md):
 *   STORAGE_PROVIDER  r2 | supabase | s3       explicit; otherwise inferred:
 *                       - "r2" when R2_ACCOUNT_ID is set,
 *                       - "s3" when STORAGE_ENDPOINT is set,
 *                       - unconfigured otherwise.
 *   STORAGE_ENDPOINT  full URL                 required for supabase/s3, derived for r2.
 *   STORAGE_REGION    string                   default: auto (r2), local (supabase).
 *   STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY
 *                                              required; fall back to R2_* when provider is r2.
 *   STORAGE_FORCE_PATH_STYLE  bool             default: true for supabase, false otherwise.
 */

import { S3Client } from "@aws-sdk/client-s3";

export type ObjectStorageProvider = "r2" | "supabase" | "s3";

/** Explicit S3-compatible transport configuration for durable storage domains. */
export interface S3CompatibleClientConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  maxAttempts?: number;
  responseChecksumValidation?: "WHEN_SUPPORTED" | "WHEN_REQUIRED";
}

let cached: S3Client | null | undefined;
let singleAttemptCached: S3Client | null | undefined;
const singleAttemptClients = new WeakSet<S3Client>();

/**
 * Construct a client without consulting process-global storage configuration.
 * Durable backup callers use this so an endpoint alias resolves to one exact
 * backend for the entire operation.
 */
export function createS3CompatibleClient(config: S3CompatibleClientConfig): S3Client {
  const maxAttempts = config.maxAttempts;
  const client = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: config.forcePathStyle ?? false,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    maxAttempts,
    responseChecksumValidation: config.responseChecksumValidation,
  });
  if (maxAttempts === 1) singleAttemptClients.add(client);
  return client;
}

/** True only for clients whose retry policy was fixed by this module at construction. */
export function isSingleAttemptObjectStorageClient(client: S3Client): boolean {
  return singleAttemptClients.has(client);
}

function readBool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes") return true;
  if (normalized === "0" || normalized === "false" || normalized === "no") return false;
  return undefined;
}

function resolveProvider(): ObjectStorageProvider | null {
  const raw = process.env.STORAGE_PROVIDER?.trim().toLowerCase();
  if (raw === "r2" || raw === "supabase" || raw === "s3") return raw;
  if (raw && raw.length > 0) {
    throw new Error(`STORAGE_PROVIDER="${raw}" is invalid. Expected one of: r2, supabase, s3.`);
  }
  if (process.env.R2_ACCOUNT_ID) return "r2";
  if (process.env.STORAGE_ENDPOINT) return "s3";
  return null;
}

function resolveEndpoint(provider: ObjectStorageProvider): string {
  const explicit = process.env.STORAGE_ENDPOINT?.trim();
  if (explicit) return explicit;
  if (provider === "r2") {
    const accountId = process.env.R2_ACCOUNT_ID?.trim();
    if (!accountId) {
      throw new Error("STORAGE_PROVIDER=r2 requires either STORAGE_ENDPOINT or R2_ACCOUNT_ID.");
    }
    return `https://${accountId}.r2.cloudflarestorage.com`;
  }
  throw new Error(`STORAGE_PROVIDER=${provider} requires STORAGE_ENDPOINT to be set explicitly.`);
}

function resolveRegion(provider: ObjectStorageProvider): string {
  const explicit = process.env.STORAGE_REGION?.trim();
  if (explicit) return explicit;
  if (provider === "r2") return "auto";
  if (provider === "supabase") return "local";
  throw new Error("STORAGE_PROVIDER=s3 requires STORAGE_REGION to be set.");
}

function resolveCredentials(provider: ObjectStorageProvider): {
  accessKeyId: string;
  secretAccessKey: string;
} {
  const accessKeyId =
    process.env.STORAGE_ACCESS_KEY_ID ??
    (provider === "r2" ? process.env.R2_ACCESS_KEY_ID : undefined);
  const secretAccessKey =
    process.env.STORAGE_SECRET_ACCESS_KEY ??
    (provider === "r2" ? process.env.R2_SECRET_ACCESS_KEY : undefined);
  if (!accessKeyId || !secretAccessKey) {
    const hint =
      provider === "r2"
        ? "Set STORAGE_ACCESS_KEY_ID/STORAGE_SECRET_ACCESS_KEY (or R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY)."
        : "Set STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY.";
    throw new Error(`Object storage credentials are not configured. ${hint}`);
  }
  return { accessKeyId, secretAccessKey };
}

function resolveForcePathStyle(provider: ObjectStorageProvider): boolean {
  const explicit = readBool(process.env.STORAGE_FORCE_PATH_STYLE);
  if (explicit !== undefined) return explicit;
  return provider === "supabase";
}

export function getObjectStorageProvider(): ObjectStorageProvider | null {
  return resolveProvider();
}

export function getObjectStorageClient(): S3Client | null {
  if (cached !== undefined) return cached;
  const provider = resolveProvider();
  if (!provider) {
    cached = null;
    return null;
  }
  const credentials = resolveCredentials(provider);
  cached = new S3Client({
    region: resolveRegion(provider),
    endpoint: resolveEndpoint(provider),
    forcePathStyle: resolveForcePathStyle(provider),
    credentials,
  });
  return cached;
}

/**
 * Dedicated transport for operations that own their retry budget.
 *
 * The AWS SDK retries throttles and 5xx responses by default. Immutable backup
 * uploads reconcile every ambiguous write with HEAD before retrying, so hidden
 * transport retries would multiply the bounded operation budget.
 */
export function getSingleAttemptObjectStorageClient(): S3Client | null {
  if (singleAttemptCached !== undefined) return singleAttemptCached;
  const provider = resolveProvider();
  if (!provider) {
    singleAttemptCached = null;
    return null;
  }
  const credentials = resolveCredentials(provider);
  singleAttemptCached = new S3Client({
    region: resolveRegion(provider),
    endpoint: resolveEndpoint(provider),
    forcePathStyle: resolveForcePathStyle(provider),
    credentials,
    maxAttempts: 1,
  });
  singleAttemptClients.add(singleAttemptCached);
  return singleAttemptCached;
}

export function objectStorageConfigured(): boolean {
  const provider = resolveProvider();
  if (!provider) return false;
  const accessKeyId =
    process.env.STORAGE_ACCESS_KEY_ID ??
    (provider === "r2" ? process.env.R2_ACCESS_KEY_ID : undefined);
  const secretAccessKey =
    process.env.STORAGE_SECRET_ACCESS_KEY ??
    (provider === "r2" ? process.env.R2_SECRET_ACCESS_KEY : undefined);
  if (!accessKeyId || !secretAccessKey) return false;
  if (provider === "r2") {
    return Boolean(process.env.STORAGE_ENDPOINT || process.env.R2_ACCOUNT_ID);
  }
  return Boolean(process.env.STORAGE_ENDPOINT);
}

export function resetObjectStorageClientForTests(): void {
  cached = undefined;
  singleAttemptCached = undefined;
}
