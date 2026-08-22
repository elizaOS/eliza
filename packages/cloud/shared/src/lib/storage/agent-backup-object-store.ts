/**
 * Resolves durable sandbox-backup endpoint aliases into exact object stores.
 *
 * Every endpoint has explicit account/binding authority. Receipts carry only a
 * SHA-256 fingerprint of that authority, so retries fail closed after an
 * account, endpoint, or binding repoint without disclosing infrastructure data.
 */

import {
  createExactRuntimeR2Backend,
  createExactS3Backend,
  deleteObjectAtBackend,
  type ExactObjectRead,
  type GetExactObjectInput,
  getExactObjectAtBackend,
  headObjectAtBackend,
  type ImmutableObjectUploadReceipt,
  type ObjectDeleteReceipt,
  type ObjectDeleteTarget,
  type ObjectHeadReceipt,
  type ObjectRequestControl,
  ObjectStorageLifecycleError,
  type PutImmutableObjectInput,
  putImmutableObjectAtBackend,
} from "./object-store";
import type { RuntimeR2Bucket } from "./r2-runtime-binding";
import { createS3CompatibleClient } from "./s3-compatible-client";

export type AgentBackupStorageProvider = "cloudflare-r2" | "hetzner-object-storage";
export type AgentBackupStorageTransport = "worker-r2" | "s3-compatible";

interface AgentBackupEndpointBase {
  /** Stable selector persisted in `agent_backup_objects.endpoint_alias`. */
  endpointAlias: string;
  bucket: string;
  region: string;
  /** Stable, non-secret tenant/account reference assigned by infrastructure. */
  accountIdentity: string;
}

export interface AgentBackupWorkerR2Endpoint extends AgentBackupEndpointBase {
  provider: "cloudflare-r2";
  transport: "worker-r2";
  /** Stable binding/deployment reference, not the binding's secret material. */
  bindingIdentity: string;
  bucketBinding: RuntimeR2Bucket;
}

export interface AgentBackupS3Endpoint extends AgentBackupEndpointBase {
  provider: AgentBackupStorageProvider;
  transport: "s3-compatible";
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

export type AgentBackupStorageEndpoint = AgentBackupWorkerR2Endpoint | AgentBackupS3Endpoint;

/** Persistable catalogue authority; it contains no endpoint URL or credential. */
export interface AgentBackupStorageAuthority {
  provider: AgentBackupStorageProvider;
  transport: AgentBackupStorageTransport;
  endpointAlias: string;
  endpointIdentityFingerprint: string;
  bucket: string;
  region: string;
}

export interface AgentBackupObjectStore {
  readonly authority: AgentBackupStorageAuthority;
  head(key: string, control?: ObjectRequestControl): Promise<ObjectHeadReceipt>;
  /** Stream one exact catalogued generation; await `completion` before commit. */
  getExactObject(input: GetExactObjectInput): Promise<ExactObjectRead>;
  putImmutable(params: PutImmutableObjectInput): Promise<ImmutableObjectUploadReceipt>;
  delete(target: ObjectDeleteTarget, control?: ObjectRequestControl): Promise<ObjectDeleteReceipt>;
}

/** Explicit alias registry used by catalogue workers and GC replayers. */
export interface AgentBackupObjectStoreRegistry {
  /** Select an endpoint for a new object; persist the returned authority. */
  forNewObject(endpointAlias: string): AgentBackupObjectStore;
  /** Resolve a previously persisted authority and fail on any repoint. */
  forStoredObject(authority: AgentBackupStorageAuthority): AgentBackupObjectStore;
}

function requirePublicIdentity(value: string, field: string): string {
  if (value.length === 0 || value.trim() !== value || value.length > 256 || value.includes("\0")) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_UNAVAILABLE",
      `Agent backup storage requires a canonical ${field}`,
    );
  }
  return value;
}

function normalizeEndpoint(endpoint: string): string {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    // error-policy:J1 config input is translated to a static storage error.
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_UNAVAILABLE",
      "Agent backup S3 storage requires a canonical endpoint URL",
    );
  }
  const loopbackHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" ||
      /^127(?:\.[0-9]{1,3}){3}$/.test(parsed.hostname) ||
      parsed.hostname === "[::1]");
  if (
    (parsed.protocol !== "https:" && !loopbackHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_UNAVAILABLE",
      "Agent backup S3 storage requires a credential-free endpoint URL",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, "");
}

async function sha256Fingerprint(value: string): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

/**
 * Resolve one immutable endpoint configuration once for an upload/HEAD/GC
 * operation. No method reads a global binding, bucket, endpoint, or credential.
 */
export async function createAgentBackupObjectStore(
  endpoint: AgentBackupStorageEndpoint,
): Promise<AgentBackupObjectStore> {
  const endpointAlias = requirePublicIdentity(endpoint.endpointAlias, "endpoint alias");
  const accountIdentity = requirePublicIdentity(endpoint.accountIdentity, "account identity");
  const bucket = requirePublicIdentity(endpoint.bucket, "bucket");
  const region = requirePublicIdentity(endpoint.region, "region");

  const transportIdentity =
    endpoint.transport === "worker-r2"
      ? {
          bindingIdentity: requirePublicIdentity(endpoint.bindingIdentity, "binding identity"),
        }
      : {
          endpoint: normalizeEndpoint(endpoint.endpoint),
        };
  if (endpoint.transport === "worker-r2" && region !== "auto") {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_LOCATOR_UNAVAILABLE",
      "Native Worker R2 backup storage requires the canonical auto region",
    );
  }
  if (endpoint.transport === "s3-compatible") {
    requirePublicIdentity(endpoint.accessKeyId, "access-key identity");
  }
  if (
    endpoint.transport === "s3-compatible" &&
    (endpoint.secretAccessKey.length === 0 || endpoint.secretAccessKey.includes("\0"))
  ) {
    throw new ObjectStorageLifecycleError(
      "OBJECT_STORAGE_UNCONFIGURED",
      "Agent backup S3 storage credentials are not configured",
    );
  }
  const endpointIdentityFingerprint = await sha256Fingerprint(
    JSON.stringify({
      version: 1,
      provider: endpoint.provider,
      transport: endpoint.transport,
      endpointAlias,
      accountIdentity,
      bucket,
      region,
      ...transportIdentity,
    }),
  );

  const authority: AgentBackupStorageAuthority = Object.freeze({
    provider: endpoint.provider,
    transport: endpoint.transport,
    endpointAlias,
    endpointIdentityFingerprint,
    bucket,
    region,
  });
  const locator = {
    provider: endpoint.provider === "cloudflare-r2" ? ("r2" as const) : ("s3" as const),
    transport:
      endpoint.transport === "worker-r2"
        ? ("worker-r2-binding" as const)
        : ("s3-compatible" as const),
    endpointAlias,
    backendIdentityFingerprint: endpointIdentityFingerprint,
    bucket,
    region,
  };
  const backend =
    endpoint.transport === "worker-r2"
      ? createExactRuntimeR2Backend({ locator, bucket: endpoint.bucketBinding })
      : createExactS3Backend({
          locator,
          client: createS3CompatibleClient({
            endpoint: endpoint.endpoint,
            region,
            accessKeyId: endpoint.accessKeyId,
            secretAccessKey: endpoint.secretAccessKey,
            forcePathStyle: endpoint.forcePathStyle,
            maxAttempts: 1,
            // Backup GETs verify immutable metadata and stream SHA themselves.
            // Do not opt S3-compatible providers into an undocumented header.
            responseChecksumValidation: "WHEN_REQUIRED",
          }),
        });

  return Object.freeze({
    authority,
    head: (key: string, control?: ObjectRequestControl) =>
      headObjectAtBackend(backend, key, control),
    getExactObject: (input: GetExactObjectInput) => getExactObjectAtBackend({ backend, input }),
    putImmutable: (params: Parameters<AgentBackupObjectStore["putImmutable"]>[0]) =>
      putImmutableObjectAtBackend({ backend, ...params }),
    delete: (target: ObjectDeleteTarget, control?: ObjectRequestControl) =>
      deleteObjectAtBackend({ backend, target, control }),
  });
}

/** Build an immutable, process-local registry without consulting global env. */
export async function createAgentBackupObjectStoreRegistry(
  endpoints: readonly AgentBackupStorageEndpoint[],
): Promise<AgentBackupObjectStoreRegistry> {
  const stores = new Map<string, AgentBackupObjectStore>();
  for (const endpoint of endpoints) {
    const store = await createAgentBackupObjectStore(endpoint);
    if (stores.has(store.authority.endpointAlias)) {
      throw new ObjectStorageLifecycleError(
        "OBJECT_STORAGE_LOCATOR_UNAVAILABLE",
        "Agent backup storage endpoint aliases must be unique",
      );
    }
    stores.set(store.authority.endpointAlias, store);
  }

  function requireStore(endpointAlias: string): AgentBackupObjectStore {
    const store = stores.get(endpointAlias);
    if (!store) {
      throw new ObjectStorageLifecycleError(
        "OBJECT_STORAGE_UNCONFIGURED",
        "Agent backup storage endpoint alias is not configured",
      );
    }
    return store;
  }

  return Object.freeze({
    forNewObject(endpointAlias: string): AgentBackupObjectStore {
      return requireStore(endpointAlias);
    },
    forStoredObject(authority: AgentBackupStorageAuthority): AgentBackupObjectStore {
      const store = requireStore(authority.endpointAlias);
      const configured = store.authority;
      if (
        authority.provider !== configured.provider ||
        authority.transport !== configured.transport ||
        authority.bucket !== configured.bucket ||
        authority.region !== configured.region ||
        authority.endpointIdentityFingerprint !== configured.endpointIdentityFingerprint
      ) {
        throw new ObjectStorageLifecycleError(
          "OBJECT_STORAGE_LOCATOR_MISMATCH",
          "Agent backup storage authority no longer matches the configured endpoint",
        );
      }
      return store;
    },
  });
}
