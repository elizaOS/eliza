/**
 * Exercises explicit sandbox-backup stores against native R2 test doubles and
 * a real local S3 HTTP boundary, including backend-repoint refusal.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AgentBackupS3Endpoint,
  type AgentBackupWorkerR2Endpoint,
  createAgentBackupObjectStore,
  createAgentBackupObjectStoreRegistry,
} from "./agent-backup-object-store";
import { ObjectStorageLifecycleError } from "./object-store";
import type {
  RuntimeR2Bucket,
  RuntimeR2ObjectMetadata,
  RuntimeR2PutOptions,
} from "./r2-runtime-binding";

interface StoredObject {
  body: Uint8Array;
  sha256: string;
  etag: string;
  version: string;
}

const s3Objects = new Map<string, StoredObject>();
let s3Server: ReturnType<typeof Bun.serve>;

function parseS3Key(request: Request): string {
  const path = new URL(request.url).pathname.slice(1);
  const separator = path.indexOf("/");
  return separator < 0 ? "" : decodeURIComponent(path.slice(separator + 1));
}

function s3NotFound(): Response {
  return new Response("<Error><Code>NoSuchKey</Code></Error>", {
    status: 404,
    headers: { "content-type": "application/xml" },
  });
}

function makeRuntimeBucket(): {
  bucket: RuntimeR2Bucket;
  deleteCalls: string[];
} {
  const objects = new Map<string, RuntimeR2ObjectMetadata>();
  const deleteCalls: string[] = [];
  return {
    deleteCalls,
    bucket: {
      async head(key) {
        return objects.get(key) ?? null;
      },
      async get() {
        return null;
      },
      async put(key, body, options?: RuntimeR2PutOptions) {
        if (objects.has(key)) return null;
        const sha256 = options?.sha256;
        if (!(sha256 instanceof ArrayBuffer)) throw new Error("Expected SHA-256 bytes");
        const size = body instanceof Uint8Array ? body.byteLength : 0;
        const object = {
          size,
          etag: `etag-${key.length}`,
          version: `version-${key.length}`,
          checksums: { sha256 },
          customMetadata: options.customMetadata,
        };
        objects.set(key, object);
        return object;
      },
      async delete(key) {
        deleteCalls.push(key);
        objects.delete(key);
      },
    },
  };
}

function workerEndpoint(
  bucketBinding: RuntimeR2Bucket,
  overrides: Partial<AgentBackupWorkerR2Endpoint> = {},
): AgentBackupWorkerR2Endpoint {
  return {
    provider: "cloudflare-r2",
    transport: "worker-r2",
    endpointAlias: "r2-primary-eu",
    accountIdentity: "cloudflare-account-a",
    bindingIdentity: "BACKUP_PRIMARY",
    bucket: "sandbox-backup-primary",
    region: "auto",
    bucketBinding,
    ...overrides,
  };
}

function s3Endpoint(
  provider: AgentBackupS3Endpoint["provider"],
  overrides: Partial<AgentBackupS3Endpoint> = {},
): AgentBackupS3Endpoint {
  return {
    provider,
    transport: "s3-compatible",
    endpointAlias: provider === "cloudflare-r2" ? "r2-primary-s3-eu" : "hetzner-secondary-fsn1",
    accountIdentity: provider === "cloudflare-r2" ? "cloudflare-account-a" : "hetzner-project-a",
    endpoint: `http://127.0.0.1:${s3Server.port}`,
    accessKeyId: provider === "cloudflare-r2" ? "r2-access-a" : "hetzner-access-a",
    secretAccessKey: "test-secret",
    bucket: provider === "cloudflare-r2" ? "sandbox-backup-primary" : "sandbox-backup-secondary",
    region: provider === "cloudflare-r2" ? "auto" : "fsn1",
    forcePathStyle: true,
    ...overrides,
  };
}

beforeAll(() => {
  s3Server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const key = parseS3Key(request);
      if (request.method === "HEAD") {
        const object = s3Objects.get(key);
        if (!object) return s3NotFound();
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": String(object.body.byteLength),
            etag: `"${object.etag}"`,
            "x-amz-checksum-sha256": object.sha256,
            "x-amz-meta-eliza-content-sha256": object.sha256,
            "x-amz-version-id": object.version,
          },
        });
      }
      if (request.method === "PUT") {
        if (request.headers.get("if-none-match") !== "*") {
          return new Response("<Error><Code>NotImplemented</Code></Error>", { status: 501 });
        }
        if (s3Objects.has(key)) {
          return new Response("<Error><Code>PreconditionFailed</Code></Error>", { status: 412 });
        }
        const body = new Uint8Array(await request.arrayBuffer());
        const sha256 =
          request.headers.get("x-amz-checksum-sha256") ??
          request.headers.get("x-amz-meta-eliza-content-sha256") ??
          "";
        s3Objects.set(key, {
          body,
          sha256,
          etag: `etag-${key.length}`,
          version: `v-${key.length}`,
        });
        return new Response(null, { status: 200 });
      }
      if (request.method === "DELETE") {
        s3Objects.delete(key);
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 405 });
    },
  });
});

afterAll(() => {
  s3Server.stop(true);
});

describe("agent backup explicit object storage", () => {
  test("maps Worker R2 primary authority and keeps receipts privacy-safe", async () => {
    const runtime = makeRuntimeBucket();
    const endpoint = workerEndpoint(runtime.bucket);
    const store = await createAgentBackupObjectStore(endpoint);
    const key = "agent-sandbox-backups/org-a/backup-a/chunk-0000";

    expect(store.authority).toMatchObject({
      provider: "cloudflare-r2",
      transport: "worker-r2",
      endpointAlias: "r2-primary-eu",
      bucket: "sandbox-backup-primary",
      region: "auto",
    });
    expect(store.authority.endpointIdentityFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);

    const uploaded = await store.putImmutable({ key, body: new Uint8Array([1, 2, 3]) });
    const serialized = JSON.stringify(uploaded);
    for (const privateValue of [
      key,
      endpoint.accountIdentity,
      endpoint.bindingIdentity,
      endpoint.endpointAlias,
      endpoint.bucket,
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(uploaded.locator.backendIdentityFingerprint).toBe(
      store.authority.endpointIdentityFingerprint,
    );

    const deleted = await store.delete({ key, locator: uploaded.locator });
    expect(deleted).toMatchObject({ status: "deleted", verifiedAbsent: true });
    expect(runtime.deleteCalls).toEqual([key]);
  });

  test("supports Cloudflare R2 and Hetzner through explicit S3 transports", async () => {
    s3Objects.clear();
    const r2 = await createAgentBackupObjectStore(s3Endpoint("cloudflare-r2"));
    const hetzner = await createAgentBackupObjectStore(s3Endpoint("hetzner-object-storage"));

    expect(r2.authority).toMatchObject({
      provider: "cloudflare-r2",
      transport: "s3-compatible",
    });
    expect(hetzner.authority).toMatchObject({
      provider: "hetzner-object-storage",
      transport: "s3-compatible",
    });

    const r2Key = "agent-sandbox-backups/org-b/backup-b/r2-chunk";
    const hetznerKey = "agent-sandbox-backups/org-b/backup-b/hetzner-chunk";
    const [r2Receipt, hetznerReceipt] = await Promise.all([
      r2.putImmutable({ key: r2Key, body: new Uint8Array([4, 5]) }),
      hetzner.putImmutable({ key: hetznerKey, body: new Uint8Array([6, 7, 8]) }),
    ]);
    expect(r2Receipt.locator).toMatchObject({ provider: "r2", transport: "s3-compatible" });
    expect(hetznerReceipt.locator).toMatchObject({
      provider: "s3",
      transport: "s3-compatible",
    });
    await expect(r2.head(r2Key)).resolves.toMatchObject({ status: "present" });
    await expect(hetzner.head(hetznerKey)).resolves.toMatchObject({ status: "present" });
  });

  test("refuses same-bucket deletion after account, binding, or credential repoint", async () => {
    const runtime = makeRuntimeBucket();
    const original = await createAgentBackupObjectStore(workerEndpoint(runtime.bucket));
    const key = "agent-sandbox-backups/org-c/backup-c/chunk";
    const receipt = await original.putImmutable({ key, body: new Uint8Array([9]) });

    const accountRepoint = await createAgentBackupObjectStore(
      workerEndpoint(runtime.bucket, { accountIdentity: "cloudflare-account-b" }),
    );
    const bindingRepoint = await createAgentBackupObjectStore(
      workerEndpoint(runtime.bucket, { bindingIdentity: "BACKUP_PRIMARY_REPOINTED" }),
    );
    for (const repointed of [accountRepoint, bindingRepoint]) {
      await expect(repointed.delete({ key, locator: receipt.locator })).rejects.toMatchObject({
        code: "OBJECT_STORAGE_LOCATOR_MISMATCH",
      });
    }
    expect(runtime.deleteCalls).toEqual([]);

    const s3Original = await createAgentBackupObjectStore(s3Endpoint("hetzner-object-storage"));
    const s3Key = "agent-sandbox-backups/org-c/backup-c/secondary";
    const s3Receipt = await s3Original.putImmutable({
      key: s3Key,
      body: new Uint8Array([10]),
    });
    const credentialRotation = await createAgentBackupObjectStore(
      s3Endpoint("hetzner-object-storage", { accessKeyId: "hetzner-access-rotated" }),
    );
    expect(credentialRotation.authority.endpointIdentityFingerprint).toBe(
      s3Original.authority.endpointIdentityFingerprint,
    );
    const accountRepointedCredential = await createAgentBackupObjectStore(
      s3Endpoint("hetzner-object-storage", {
        accessKeyId: "hetzner-access-other-account",
        accountIdentity: "hetzner-project-other-account",
      }),
    );
    await expect(
      accountRepointedCredential.delete({ key: s3Key, locator: s3Receipt.locator }),
    ).rejects.toBeInstanceOf(ObjectStorageLifecycleError);
    await expect(accountRepointedCredential.head(s3Key)).resolves.toMatchObject({
      status: "present",
    });
  });

  test("resolves persisted catalogue authority by alias and rejects registry repoints", async () => {
    const runtime = makeRuntimeBucket();
    const originalRegistry = await createAgentBackupObjectStoreRegistry([
      workerEndpoint(runtime.bucket),
    ]);
    const original = originalRegistry.forNewObject("r2-primary-eu");
    expect(originalRegistry.forStoredObject(original.authority)).toBe(original);

    const repointedRegistry = await createAgentBackupObjectStoreRegistry([
      workerEndpoint(runtime.bucket, { accountIdentity: "cloudflare-account-repointed" }),
    ]);
    expect(() => repointedRegistry.forStoredObject(original.authority)).toThrow(
      ObjectStorageLifecycleError,
    );
    expect(() => repointedRegistry.forNewObject("missing-alias")).toThrow(
      ObjectStorageLifecycleError,
    );
  });
});
