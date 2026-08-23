import { describe, expect, test } from "bun:test";
import type { AgentBackupGcClaim } from "../../db/repositories/agent-backup-gc";
import type { AgentBackupObject } from "../../db/schemas/agent-backup-catalog";
import type {
  AgentBackupObjectStore,
  AgentBackupObjectStoreRegistry,
  AgentBackupStorageAuthority,
} from "../storage/agent-backup-object-store";
import {
  type ExactObjectRead,
  ObjectLocatorReceipt,
  ObjectStorageLifecycleError,
} from "../storage/object-store";
import {
  type AgentBackupObjectUploadRepository,
  executeAgentBackupGcClaims,
  executeAgentBackupObjectUpload,
  executeAgentBackupSecondaryObjectReplication,
} from "./agent-backup-catalog-worker";

const ORGANIZATION_ID = "a0000000-0000-4000-8000-000000000001";
const BACKUP_ID = "b0000000-0000-4000-8000-000000000002";
const OPERATION_ID = "c0000000-0000-4000-8000-000000000003";
const EXECUTION = {
  ownerId: "publication-worker-1",
  generation: "d0000000-0000-4000-8000-000000000004",
} as const;
const PRIMARY_KEY = `agent-sandbox-backups/v2/${ORGANIZATION_ID}/${BACKUP_ID}/primary/database/00000003.bin`;
const SECONDARY_KEY = `agent-sandbox-backups/v2/${ORGANIZATION_ID}/${BACKUP_ID}/secondary/database/00000003.bin`;
const FINGERPRINT = `sha256:${"1".repeat(64)}`;
const CONTENT_HMAC = "b".repeat(64);

function ownedBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const output = new Uint8Array(new ArrayBuffer(input.byteLength));
  output.set(input);
  return output;
}

async function sha256(input: Uint8Array | string): Promise<{ hex: string; base64: string }> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", ownedBytes(bytes)));
  return {
    hex: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    base64: Buffer.from(digest).toString("base64"),
  };
}

function locator(params: {
  authority: AgentBackupStorageAuthority;
  keyFingerprint: string;
  version: string;
  transport?: "worker-r2-binding" | "s3-compatible";
  provider?: "r2" | "s3";
}): ObjectLocatorReceipt {
  return new ObjectLocatorReceipt({
    transport:
      params.transport ??
      (params.authority.transport === "worker-r2" ? "worker-r2-binding" : "s3-compatible"),
    provider: params.provider ?? (params.authority.provider === "cloudflare-r2" ? "r2" : "s3"),
    endpointAlias: params.authority.endpointAlias,
    backendIdentityFingerprint: params.authority.endpointIdentityFingerprint,
    bucket: params.authority.bucket,
    region: params.authority.region,
    keyFingerprint: params.keyFingerprint,
    version: params.version,
    versionSource: "provider",
  });
}

function objectRow(params: {
  id: string;
  role: "primary" | "secondary";
  provider: AgentBackupObject["provider"];
  transport: AgentBackupObject["transport"];
  authority: AgentBackupStorageAuthority;
  objectKey: string;
  keyFingerprint: string;
  ciphertextSha256: string;
  sizeBytes: number;
  state?: AgentBackupObject["state"];
  providerWriteStarted?: boolean;
}): AgentBackupObject {
  const now = new Date("2026-08-16T00:00:00.000Z");
  const verified = params.state === "verified";
  return {
    id: params.id,
    organization_id: ORGANIZATION_ID,
    backup_id: BACKUP_ID,
    copy_role: params.role,
    component: "database",
    chunk_index: 3,
    state: params.state ?? "reserved",
    transport: params.transport,
    provider: params.provider,
    endpoint_alias: params.authority.endpointAlias,
    endpoint_identity_fingerprint: params.authority.endpointIdentityFingerprint,
    bucket: params.authority.bucket,
    region: params.authority.region,
    object_key: params.objectKey,
    key_fingerprint: params.keyFingerprint,
    provider_write_started: params.providerWriteStarted ?? verified,
    provider_version_id: verified ? "primary-version-1" : null,
    content_hmac_sha256: CONTENT_HMAC,
    ciphertext_sha256: params.ciphertextSha256,
    size_bytes: params.sizeBytes,
    provider_etag: null,
    provider_checksum: verified
      ? "sha256:base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
      : null,
    upload_receipt_digest: verified ? "c".repeat(64) : null,
    delete_receipt_digest: null,
    verified_at: verified ? now : null,
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
}

async function fixture(
  options: {
    readFailure?: Error;
    bodyFailure?: Error;
    putFailures?: number;
    markerFailure?: Error;
    receiptTransport?: "worker-r2-binding" | "s3-compatible";
    receiptProvider?: "r2" | "s3";
  } = {},
) {
  const body = ownedBytes(new TextEncoder().encode("encrypted-backup-chunk"));
  const bodyDigest = await sha256(body);
  const primaryKeyDigest = await sha256(PRIMARY_KEY);
  const events: string[] = [];
  const rows = new Map<"primary" | "secondary", AgentBackupObject>();
  const uploadedBodies: Uint8Array[] = [];
  let eof = false;
  let remainingPutFailures = options.putFailures ?? 0;

  const primaryAuthority: AgentBackupStorageAuthority = {
    provider: "cloudflare-r2",
    transport: "worker-r2",
    endpointAlias: "primary-r2",
    endpointIdentityFingerprint: FINGERPRINT,
    bucket: "primary-bucket",
    region: "auto",
  };
  const secondaryAuthority: AgentBackupStorageAuthority = {
    provider: "hetzner-object-storage",
    transport: "s3-compatible",
    endpointAlias: "secondary-hetzner",
    endpointIdentityFingerprint: `sha256:${"2".repeat(64)}`,
    bucket: "secondary-bucket",
    region: "fsn1",
  };
  const primary = objectRow({
    id: "e0000000-0000-4000-8000-000000000005",
    role: "primary",
    provider: "cloudflare-r2",
    transport: "worker-r2",
    authority: primaryAuthority,
    objectKey: PRIMARY_KEY,
    keyFingerprint: primaryKeyDigest.hex,
    ciphertextSha256: bodyDigest.hex,
    sizeBytes: body.byteLength,
    state: "verified",
  });

  function uploadStore(
    authority: AgentBackupStorageAuthority,
    role: "primary" | "secondary",
  ): AgentBackupObjectStore {
    return {
      authority,
      async getExactObject() {
        throw new Error("unexpected upload-store GET");
      },
      async head() {
        throw new Error("unexpected upload-store HEAD");
      },
      async putImmutable(input) {
        await input.beforeWriteAttempt?.();
        events.push(`put-${role}`);
        uploadedBodies.push(
          input.body instanceof ArrayBuffer
            ? new Uint8Array(input.body)
            : new Uint8Array(input.body.buffer, input.body.byteOffset, input.body.byteLength),
        );
        if (remainingPutFailures > 0) {
          remainingPutFailures -= 1;
          throw new TypeError("provider response lost");
        }
        const digest = await sha256(uploadedBodies.at(-1) ?? new Uint8Array());
        const keyDigest = await sha256(input.key);
        return {
          locator: locator({
            authority,
            keyFingerprint: `sha256:${keyDigest.hex}`,
            version: `${role}-version-1`,
            ...(options.receiptTransport ? { transport: options.receiptTransport } : {}),
            ...(options.receiptProvider ? { provider: options.receiptProvider } : {}),
          }),
          metadata: {
            sizeBytes: body.byteLength,
            checksum: { algorithm: "sha256", encoding: "base64", value: digest.base64 },
          },
          verifiedPresent: true,
        };
      },
      async delete() {
        throw new Error("unexpected upload-store delete");
      },
    };
  }

  const primaryReadStore: AgentBackupObjectStore = {
    authority: primaryAuthority,
    async getExactObject(input): Promise<ExactObjectRead> {
      events.push("primary-get");
      if (
        input.locator.key !== PRIMARY_KEY ||
        input.locator.receipt.keyFingerprint !== `sha256:${primaryKeyDigest.hex}`
      ) {
        throw new ObjectStorageLifecycleError(
          "OBJECT_STORAGE_LOCATOR_MISMATCH",
          "Exact object key does not match persisted authority",
        );
      }
      let delivered = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!delivered) {
            delivered = true;
            controller.enqueue(body.slice(0, 5));
            controller.enqueue(body.slice(5));
            return;
          }
          if (options.bodyFailure) {
            events.push("primary-body-error");
            controller.error(options.bodyFailure);
            return;
          }
          eof = true;
          events.push("primary-eof");
          controller.close();
        },
      });
      return {
        body: stream,
        declaredMetadata: {
          sizeBytes: body.byteLength,
          checksum: { algorithm: "sha256", encoding: "base64", value: bodyDigest.base64 },
        },
        completion: options.readFailure
          ? Promise.reject(options.readFailure)
          : Promise.resolve({
              locator: input.locator.receipt,
              metadata: {
                sizeBytes: body.byteLength,
                checksum: { algorithm: "sha256", encoding: "base64", value: bodyDigest.base64 },
              },
              verifiedComplete: true,
            }),
      };
    },
    async head() {
      throw new Error("unexpected primary HEAD");
    },
    async putImmutable() {
      throw new Error("unexpected primary PUT");
    },
    async delete() {
      throw new Error("unexpected primary delete");
    },
  };

  const primaryUploadStore = uploadStore(primaryAuthority, "primary");
  const secondaryStore = uploadStore(secondaryAuthority, "secondary");
  const registry: AgentBackupObjectStoreRegistry = {
    forNewObject(endpointAlias) {
      if (endpointAlias === primaryAuthority.endpointAlias) return primaryUploadStore;
      if (endpointAlias === secondaryAuthority.endpointAlias) return secondaryStore;
      throw new Error("unknown endpoint alias");
    },
    forStoredObject(authority) {
      if (JSON.stringify(authority) !== JSON.stringify(primaryAuthority)) {
        throw new ObjectStorageLifecycleError(
          "OBJECT_STORAGE_LOCATOR_MISMATCH",
          "Stored primary authority no longer matches configuration",
        );
      }
      return primaryReadStore;
    },
  };

  const repository: AgentBackupObjectUploadRepository = {
    async reserveObject(input) {
      events.push(`reserve-${input.copyRole}`);
      const existing = rows.get(input.copyRole);
      if (existing) return existing;
      const objectKey = input.copyRole === "primary" ? PRIMARY_KEY : SECONDARY_KEY;
      const keyDigest = await sha256(objectKey);
      const row = objectRow({
        id:
          input.copyRole === "primary"
            ? "f0000000-0000-4000-8000-000000000006"
            : "f0000000-0000-4000-8000-000000000007",
        role: input.copyRole,
        provider: input.provider,
        transport: input.transport,
        authority: {
          provider: input.provider,
          transport: input.transport,
          endpointAlias: input.endpointAlias,
          endpointIdentityFingerprint: input.endpointIdentityFingerprint,
          bucket: input.bucket,
          region: input.region,
        },
        objectKey,
        keyFingerprint: keyDigest.hex,
        ciphertextSha256: input.ciphertextSha256,
        sizeBytes: input.sizeBytes,
      });
      rows.set(input.copyRole, row);
      return row;
    },
    async markUploading(input) {
      const role = [...rows.entries()].find(([, row]) => row.id === input.objectId)?.[0];
      if (!role) throw new Error("reservation missing");
      events.push(`marker-${role}`);
      if (options.markerFailure) throw options.markerFailure;
      const row = rows.get(role);
      if (!row) throw new Error("reservation disappeared");
      const updated = { ...row, state: "uploading" as const, provider_write_started: true };
      rows.set(role, updated);
      return updated;
    },
    async recordPresent(input) {
      const entry = [...rows.entries()].find(([, row]) => row.id === input.objectId);
      if (!entry) throw new Error("upload marker missing");
      const [role, row] = entry;
      events.push(`present-${role}`);
      const updated = {
        ...row,
        state: "present" as const,
        provider_version_id: input.providerVersionId ?? null,
        provider_etag: input.providerEtag ?? null,
        provider_checksum: input.providerChecksum ?? null,
        upload_receipt_digest: input.uploadReceiptDigest,
      };
      rows.set(role, updated);
      return updated;
    },
    async markVerified(input) {
      const entry = [...rows.entries()].find(([, row]) => row.id === input.objectId);
      if (!entry) throw new Error("present object missing");
      const [role, row] = entry;
      events.push(`verified-${role}`);
      const updated = { ...row, state: "verified" as const, verified_at: new Date() };
      rows.set(role, updated);
      return updated;
    },
  };

  return {
    body,
    bodyDigest,
    events,
    primary,
    registry,
    repository,
    rows,
    uploadedBodies,
    reachedPrimaryEof: () => eof,
  };
}

describe("immutable backup upload authority", () => {
  test("uses the repository-owned key and marks write intent before every lease-gated PUT", async () => {
    const prepared = await fixture();
    const deadline = new Date(Date.now() + 30_000);
    const result = await executeAgentBackupObjectUpload({
      organizationId: ORGANIZATION_ID,
      backupId: BACKUP_ID,
      copyRole: "primary",
      component: "database",
      chunkIndex: 3,
      endpointAlias: "primary-r2",
      contentHmacSha256: CONTENT_HMAC,
      ciphertextSha256: prepared.bodyDigest.hex,
      execution: EXECUTION,
      registry: prepared.registry,
      repository: prepared.repository,
      body: prepared.body,
      deadline,
      revalidateLease: async () => {
        prepared.events.push("lease-primary");
      },
    });

    expect(result).toMatchObject({ state: "verified", object_key: PRIMARY_KEY });
    expect(prepared.events).toEqual([
      "reserve-primary",
      "marker-primary",
      "lease-primary",
      "put-primary",
      "present-primary",
      "verified-primary",
    ]);
    expect(prepared.uploadedBodies).toHaveLength(1);
    expect(prepared.uploadedBodies[0]?.buffer).toBe(prepared.body.buffer);
    expect(prepared.uploadedBodies[0]?.every((byte) => byte === 0)).toBe(true);
  });

  test("cannot adopt provider state when the post-marker lease fence fails", async () => {
    const prepared = await fixture();
    await expect(
      executeAgentBackupObjectUpload({
        organizationId: ORGANIZATION_ID,
        backupId: BACKUP_ID,
        copyRole: "primary",
        component: "database",
        chunkIndex: 3,
        endpointAlias: "primary-r2",
        contentHmacSha256: CONTENT_HMAC,
        ciphertextSha256: prepared.bodyDigest.hex,
        execution: EXECUTION,
        registry: prepared.registry,
        repository: prepared.repository,
        body: ownedBytes(new TextEncoder().encode("encrypted-backup-chunk")),
        revalidateLease: async () => {
          prepared.events.push("lease-primary");
          throw new Error("lease expired");
        },
      }),
    ).rejects.toThrow("lease expired");

    expect(prepared.events).toEqual(["reserve-primary", "marker-primary", "lease-primary"]);
    expect(prepared.rows.get("primary")).toMatchObject({
      state: "uploading",
      provider_write_started: true,
      upload_receipt_digest: null,
    });
    expect(prepared.uploadedBodies).toHaveLength(0);
  });

  test("never starts provider I/O when durable write-start publication fails", async () => {
    const prepared = await fixture({ markerFailure: new Error("marker unavailable") });
    await expect(
      executeAgentBackupObjectUpload({
        organizationId: ORGANIZATION_ID,
        backupId: BACKUP_ID,
        copyRole: "primary",
        component: "database",
        chunkIndex: 3,
        endpointAlias: "primary-r2",
        contentHmacSha256: CONTENT_HMAC,
        ciphertextSha256: prepared.bodyDigest.hex,
        execution: EXECUTION,
        registry: prepared.registry,
        repository: prepared.repository,
        body: prepared.body,
        revalidateLease: async () => {
          prepared.events.push("lease-primary");
        },
      }),
    ).rejects.toThrow("marker unavailable");
    expect(prepared.events).toEqual(["reserve-primary", "marker-primary"]);
    expect(prepared.uploadedBodies).toHaveLength(0);
  });

  test("fails closed when the durable marker response does not prove write authority", async () => {
    const prepared = await fixture();
    const regressedRepository: AgentBackupObjectUploadRepository = {
      ...prepared.repository,
      async markUploading(input) {
        const marked = await prepared.repository.markUploading(input);
        return { ...marked, state: "reserved", provider_write_started: false };
      },
    };
    await expect(
      executeAgentBackupObjectUpload({
        organizationId: ORGANIZATION_ID,
        backupId: BACKUP_ID,
        copyRole: "primary",
        component: "database",
        chunkIndex: 3,
        endpointAlias: "primary-r2",
        contentHmacSha256: CONTENT_HMAC,
        ciphertextSha256: prepared.bodyDigest.hex,
        execution: EXECUTION,
        registry: prepared.registry,
        repository: regressedRepository,
        body: prepared.body,
        revalidateLease: async () => {
          prepared.events.push("lease-primary");
        },
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_LOCATOR_MISMATCH" });
    expect(prepared.events).toEqual(["reserve-primary", "marker-primary"]);
    expect(prepared.uploadedBodies).toHaveLength(0);
  });

  test("rejects provider and transport receipt confusion before durable settlement", async () => {
    for (const override of [
      { receiptProvider: "s3" as const },
      { receiptTransport: "s3-compatible" as const },
    ]) {
      const prepared = await fixture(override);
      await expect(
        executeAgentBackupObjectUpload({
          organizationId: ORGANIZATION_ID,
          backupId: BACKUP_ID,
          copyRole: "primary",
          component: "database",
          chunkIndex: 3,
          endpointAlias: "primary-r2",
          contentHmacSha256: CONTENT_HMAC,
          ciphertextSha256: prepared.bodyDigest.hex,
          execution: EXECUTION,
          registry: prepared.registry,
          repository: prepared.repository,
          body: prepared.body,
          revalidateLease: async () => {
            prepared.events.push("lease-primary");
          },
        }),
      ).rejects.toMatchObject({ code: "OBJECT_STORAGE_LOCATOR_MISMATCH" });
      expect(prepared.events).not.toContain("present-primary");
    }
  });

  test("replays an uploading reservation after response loss without caller-owned keys", async () => {
    const prepared = await fixture({ putFailures: 1 });
    const freshBody = () => ownedBytes(new TextEncoder().encode("encrypted-backup-chunk"));
    const upload = () =>
      executeAgentBackupObjectUpload({
        organizationId: ORGANIZATION_ID,
        backupId: BACKUP_ID,
        copyRole: "primary",
        component: "database",
        chunkIndex: 3,
        endpointAlias: "primary-r2",
        contentHmacSha256: CONTENT_HMAC,
        ciphertextSha256: prepared.bodyDigest.hex,
        execution: EXECUTION,
        registry: prepared.registry,
        repository: prepared.repository,
        body: freshBody(),
        revalidateLease: async () => {
          prepared.events.push("lease-primary");
        },
      });

    await expect(upload()).rejects.toThrow("provider response lost");
    await expect(upload()).resolves.toMatchObject({ state: "verified", object_key: PRIMARY_KEY });
    expect(prepared.uploadedBodies).toHaveLength(2);
    expect(prepared.uploadedBodies.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  });
});

describe("secondary backup replication", () => {
  test("drains and verifies the exact primary before repository-owned secondary publication", async () => {
    const prepared = await fixture();
    const deadline = new Date(Date.now() + 30_000);
    const result = await executeAgentBackupSecondaryObjectReplication({
      organizationId: ORGANIZATION_ID,
      backupId: BACKUP_ID,
      primaryObject: prepared.primary,
      secondaryEndpointAlias: "secondary-hetzner",
      scope: "production-eu",
      operationId: OPERATION_ID,
      manifestDigest: "a".repeat(64),
      registry: prepared.registry,
      execution: EXECUTION,
      deadline,
      revalidateLease: async () => {
        prepared.events.push("lease-secondary");
      },
      uploadRepository: prepared.repository,
    });

    expect(result).toMatchObject({
      state: "verified",
      copy_role: "secondary",
      object_key: SECONDARY_KEY,
    });
    expect(prepared.reachedPrimaryEof()).toBe(true);
    expect(prepared.events).toEqual([
      "primary-get",
      "primary-eof",
      "reserve-secondary",
      "marker-secondary",
      "lease-secondary",
      "put-secondary",
      "present-secondary",
      "verified-secondary",
    ]);
    expect(prepared.uploadedBodies[0]?.every((byte) => byte === 0)).toBe(true);
  });

  test("does not reserve or mutate secondary storage after exact-read response loss", async () => {
    const prepared = await fixture({
      readFailure: new ObjectStorageLifecycleError(
        "OBJECT_STORAGE_READ_HASH_MISMATCH",
        "Exact primary read failed ciphertext verification",
      ),
    });
    await expect(
      executeAgentBackupSecondaryObjectReplication({
        organizationId: ORGANIZATION_ID,
        backupId: BACKUP_ID,
        primaryObject: prepared.primary,
        secondaryEndpointAlias: "secondary-hetzner",
        scope: "production-eu",
        operationId: OPERATION_ID,
        manifestDigest: "a".repeat(64),
        registry: prepared.registry,
        execution: EXECUTION,
        revalidateLease: async () => undefined,
        uploadRepository: prepared.repository,
      }),
    ).rejects.toMatchObject({ code: "OBJECT_STORAGE_READ_HASH_MISMATCH" });
    expect(prepared.events).toEqual(["primary-get", "primary-eof"]);
    expect(prepared.rows.has("secondary")).toBe(false);
    expect(prepared.uploadedBodies).toHaveLength(0);
  });

  test("observes completion rejection when the provider body fails first", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const prepared = await fixture({
        bodyFailure: new Error("provider body failed"),
        readFailure: new Error("completion also failed"),
      });
      await expect(
        executeAgentBackupSecondaryObjectReplication({
          organizationId: ORGANIZATION_ID,
          backupId: BACKUP_ID,
          primaryObject: prepared.primary,
          secondaryEndpointAlias: "secondary-hetzner",
          scope: "production-eu",
          operationId: OPERATION_ID,
          manifestDigest: "a".repeat(64),
          registry: prepared.registry,
          execution: EXECUTION,
          revalidateLease: async () => undefined,
          uploadRepository: prepared.repository,
        }),
      ).rejects.toThrow("provider body failed");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expect(prepared.events).toEqual(["primary-get", "primary-body-error"]);
      expect(prepared.rows.has("secondary")).toBe(false);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("backup GC provider cancellation", () => {
  test("propagates abort and the lease deadline to delete without settling or starting the next claim", async () => {
    const keyFingerprint = (await sha256(PRIMARY_KEY)).hex;
    const authority: AgentBackupStorageAuthority = {
      provider: "cloudflare-r2",
      transport: "worker-r2",
      endpointAlias: "primary-r2",
      endpointIdentityFingerprint: FINGERPRINT,
      bucket: "primary-bucket",
      region: "auto",
    };
    const object = objectRow({
      id: "e0000000-0000-4000-8000-000000000005",
      role: "primary",
      provider: "cloudflare-r2",
      transport: "worker-r2",
      authority,
      objectKey: PRIMARY_KEY,
      keyFingerprint,
      ciphertextSha256: "a".repeat(64),
      sizeBytes: 32,
      state: "verified",
    });
    const leaseExpiresAt = new Date(Date.now() + 60_000);
    const claim = (index: number) =>
      ({
        outbox: {
          id: `f0000000-0000-4000-8000-00000000000${index}`,
          organization_id: ORGANIZATION_ID,
          object_id: object.id,
          action: "delete_object",
          state: "leased",
          claim_owner: "gc-worker-1",
          claim_generation: EXECUTION.generation,
          lease_expires_at: leaseExpiresAt,
          attempts: 0,
        },
        object: { ...object, id: `e0000000-0000-4000-8000-00000000000${index}` },
      }) as AgentBackupGcClaim;
    const controller = new AbortController();
    let deleteCalls = 0;
    const store = {
      authority,
      async delete(_target, control) {
        deleteCalls += 1;
        expect(control?.signal).toBe(controller.signal);
        expect(control?.deadline?.getTime()).toBe(leaseExpiresAt.getTime() - 1_000);
        controller.abort(new Error("shutdown during provider delete"));
        control?.signal?.throwIfAborted();
        throw new Error("unreachable delete continuation");
      },
    } as AgentBackupObjectStore;
    const registry = {
      forStoredObject() {
        return store;
      },
    } as AgentBackupObjectStoreRegistry;

    await expect(
      executeAgentBackupGcClaims({
        claims: [claim(1), claim(2)],
        registry,
        retryDelayMs: 1_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("shutdown during provider delete");
    expect(deleteCalls).toBe(1);
  });
});
