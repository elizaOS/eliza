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

/**
 * Read one storage environment variable with surrounding whitespace removed.
 * Unset, empty, and whitespace-only all become `undefined`, so every rule below
 * treats them the same way. `??` alone is not enough: an empty string is not
 * nullish, so `STORAGE_ACCESS_KEY_ID=""` would suppress the `R2_*` fallback.
 */
function nonEmptyEnv(name: string): string | undefined {
  return process.env[name]?.trim() || undefined;
}

function resolveProvider(): ObjectStorageProvider | null {
  const raw = nonEmptyEnv("STORAGE_PROVIDER")?.toLowerCase();
  if (raw === "r2" || raw === "supabase" || raw === "s3") return raw;
  if (raw) {
    throw new Error(`STORAGE_PROVIDER="${raw}" is invalid. Expected one of: r2, supabase, s3.`);
  }
  if (nonEmptyEnv("R2_ACCOUNT_ID")) return "r2";
  if (nonEmptyEnv("STORAGE_ENDPOINT")) return "s3";
  return null;
}

function resolveEndpoint(provider: ObjectStorageProvider): string {
  const explicit = nonEmptyEnv("STORAGE_ENDPOINT");
  if (explicit) return explicit;
  if (provider === "r2") {
    const accountId = nonEmptyEnv("R2_ACCOUNT_ID");
    if (!accountId) {
      throw new Error("STORAGE_PROVIDER=r2 requires either STORAGE_ENDPOINT or R2_ACCOUNT_ID.");
    }
    return `https://${accountId}.r2.cloudflarestorage.com`;
  }
  throw new Error(`STORAGE_PROVIDER=${provider} requires STORAGE_ENDPOINT to be set explicitly.`);
}

function resolveRegion(provider: ObjectStorageProvider): string {
  const explicit = nonEmptyEnv("STORAGE_REGION");
  if (explicit) return explicit;
  if (provider === "r2") return "auto";
  if (provider === "supabase") return "local";
  throw new Error("STORAGE_PROVIDER=s3 requires STORAGE_REGION to be set.");
}

/**
 * The credential pair the given provider would use, or `undefined` entries when
 * it is incomplete. Shared so readiness and construction cannot disagree.
 */
function credentialsFromEnv(provider: ObjectStorageProvider): {
  accessKeyId: string | undefined;
  secretAccessKey: string | undefined;
} {
  return {
    accessKeyId:
      nonEmptyEnv("STORAGE_ACCESS_KEY_ID") ??
      (provider === "r2" ? nonEmptyEnv("R2_ACCESS_KEY_ID") : undefined),
    secretAccessKey:
      nonEmptyEnv("STORAGE_SECRET_ACCESS_KEY") ??
      (provider === "r2" ? nonEmptyEnv("R2_SECRET_ACCESS_KEY") : undefined),
  };
}

function resolveCredentials(provider: ObjectStorageProvider): {
  accessKeyId: string;
  secretAccessKey: string;
} {
  const { accessKeyId, secretAccessKey } = credentialsFromEnv(provider);
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

/**
 * Whether the current environment can build an object storage client.
 *
 * Callers use this as the guard in front of {@link getObjectStorageClient}, so
 * it must read the environment through the same rules construction does. A
 * truthiness test on the raw value is not enough: `STORAGE_ENDPOINT="   "` is
 * truthy, but construction trims it, finds no endpoint, and throws.
 */
export function objectStorageConfigured(): boolean {
  const provider = resolveProvider();
  if (!provider) return false;
  const { accessKeyId, secretAccessKey } = credentialsFromEnv(provider);
  if (!accessKeyId || !secretAccessKey) return false;
  if (provider === "r2") {
    return Boolean(nonEmptyEnv("STORAGE_ENDPOINT") || nonEmptyEnv("R2_ACCOUNT_ID"));
  }
  // `resolveRegion` requires an explicit region for s3 and supplies a default
  // for the other providers, so readiness has to ask the same question.
  if (provider === "s3" && !nonEmptyEnv("STORAGE_REGION")) return false;
  return Boolean(nonEmptyEnv("STORAGE_ENDPOINT"));
}

export function resetObjectStorageClientForTests(): void {
  cached = undefined;
  singleAttemptCached = undefined;
}
