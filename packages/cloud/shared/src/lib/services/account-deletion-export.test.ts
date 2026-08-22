/** Proves encrypted export integrity and lost-response reconciliation. */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
  RuntimeR2Bucket,
  RuntimeR2ObjectMetadata,
  RuntimeR2PutOptions,
} from "../storage/r2-runtime-binding";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const RECOVERY_CREDENTIAL = "r".repeat(43);
const REQUEST_DIGEST = "request-digest";
const PLAINTEXT = new TextEncoder().encode('{"format":"eliza-account-export-v1"}');

function requestRecord(exportStatus = "pending", contentDigest: string | null = null) {
  return {
    request: {
      id: REQUEST_ID,
      user_id: USER_ID,
      organization_id: ORGANIZATION_ID,
      request_digest: REQUEST_DIGEST,
      recovery_token_expires_at: new Date("2026-09-21T12:00:00.000Z"),
      status: "reserved",
    },
    exportReceipt: {
      status: exportStatus,
      content_digest: contentDigest,
    },
  };
}

const findByRecoveryTokenHash = mock(async () => requestRecord());
const leasePhase = mock(async () => ({
  receipt: {
    id: "44444444-4444-4444-8444-444444444444",
    status: "leased",
  },
  generation: 1,
}));
const markExportBuilding = mock(async () => true);
const markPhaseProviderCallStarted = mock(async () => true);
const completeExportPhase = mock(async () => true);
const markPhaseForReconciliation = mock(async () => true);
const markPhaseRetryable = mock(async () => true);
const findExpiredExportCandidates = mock(
  async () =>
    [] as Array<{
      requestId: string;
      requestDigest: string;
    }>,
);
const ensureExportRevocationPhase = mock(async () => undefined);
const findExportRevocationsDue = mock(
  async () =>
    [] as Array<{
      requestId: string;
      requestDigest: string;
    }>,
);
const completeExportRevocation = mock(async () => true);
const execute = mock(async () => ({ rows: [] as unknown[] }));
const transaction = mock(
  async (operation: (tx: { execute: typeof execute }) => Promise<unknown>, _config?: unknown) =>
    await operation({ execute }),
);

mock.module("../../db/repositories/account-deletion-requests", () => ({
  accountDeletionRequestsRepository: {
    findByRecoveryTokenHash,
    leasePhase,
    markExportBuilding,
    markPhaseProviderCallStarted,
    completeExportPhase,
    markPhaseForReconciliation,
    markPhaseRetryable,
    findExpiredExportCandidates,
    ensureExportRevocationPhase,
    findExportRevocationsDue,
    completeExportRevocation,
  },
}));
mock.module("../../db/helpers", () => ({
  dbWrite: { execute, transaction },
}));
mock.module("../../db/account-deletion-foreign-key-policy", () => ({
  ACCOUNT_DELETION_FOREIGN_KEY_SNAPSHOT_SHA256: "f".repeat(64),
  listAccountDeletionForeignKeys: () => [
    {
      sourceTable: "profiles",
      sourceColumns: "user_id",
      targetTable: "users",
      targetColumns: "id",
      onDelete: "restrict",
    },
  ],
}));

class MemoryBucket implements RuntimeR2Bucket {
  readonly objects = new Map<string, { bytes: Uint8Array; metadata: RuntimeR2ObjectMetadata }>();
  readonly putOptions: RuntimeR2PutOptions[] = [];
  throwAfterPut = false;
  throwAfterDelete = false;

  async head(key: string): Promise<RuntimeR2ObjectMetadata | null> {
    return this.objects.get(key)?.metadata ?? null;
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      text: async () => new TextDecoder().decode(object.bytes),
      arrayBuffer: async () =>
        object.bytes.buffer.slice(
          object.bytes.byteOffset,
          object.bytes.byteOffset + object.bytes.byteLength,
        ) as ArrayBuffer,
    };
  }

  async put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream<Uint8Array> | null,
    options?: RuntimeR2PutOptions,
  ): Promise<void> {
    if (!ArrayBuffer.isView(value)) throw new Error("test bucket requires bytes");
    if (options) this.putOptions.push(options);
    const bytes = new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
    this.objects.set(key, {
      bytes,
      metadata: {
        key,
        version: "version-1",
        etag: "etag-1",
        size: bytes.byteLength,
        customMetadata: options?.customMetadata,
      },
    });
    if (this.throwAfterPut) {
      this.throwAfterPut = false;
      throw new Error("object store response lost");
    }
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
    if (this.throwAfterDelete) {
      this.throwAfterDelete = false;
      throw new Error("object delete response lost");
    }
  }
}

const {
  collectPortableAccountDeletionExport,
  decryptAccountDeletionExport,
  encryptAccountDeletionExport,
  getAccountDeletionExport,
  reconcileAccountDeletionExportRevocations,
  serializePortableAccountDeletionExport,
} = await import("./account-deletion-export");

beforeEach(() => {
  findByRecoveryTokenHash.mockReset();
  findByRecoveryTokenHash.mockResolvedValue(requestRecord());
  leasePhase.mockReset();
  leasePhase.mockResolvedValue({
    receipt: {
      id: "44444444-4444-4444-8444-444444444444",
      status: "leased",
    },
    generation: 1,
  });
  for (const fn of [
    markExportBuilding,
    markPhaseProviderCallStarted,
    completeExportPhase,
    markPhaseForReconciliation,
    markPhaseRetryable,
  ]) {
    fn.mockReset();
    fn.mockResolvedValue(true);
  }
  execute.mockReset();
  execute.mockResolvedValue({ rows: [] });
  transaction.mockClear();
  findExpiredExportCandidates.mockReset();
  findExpiredExportCandidates.mockResolvedValue([]);
  ensureExportRevocationPhase.mockReset();
  ensureExportRevocationPhase.mockResolvedValue(undefined);
  findExportRevocationsDue.mockReset();
  findExportRevocationsDue.mockResolvedValue([]);
  completeExportRevocation.mockReset();
  completeExportRevocation.mockResolvedValue(true);
});

describe("account deletion export", () => {
  test("collects one bounded repeatable-read snapshot and rejects oversized source rows", async () => {
    let call = 0;
    execute.mockImplementation(async () => {
      call += 1;
      return call % 2 === 1
        ? { rows: [{ row_count: "1", byte_count: "100" }] }
        : { rows: [{ id: `row-${call}` }] };
    });

    const bytes = await collectPortableAccountDeletionExport({
      requestId: REQUEST_ID,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      generatedAt: NOW,
    });

    expect(JSON.parse(new TextDecoder().decode(bytes)).tables).toHaveLength(3);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read",
      accessMode: "read only",
    });
    expect(execute).toHaveBeenCalledTimes(6);

    execute.mockReset();
    execute.mockResolvedValueOnce({
      rows: [{ row_count: "1", byte_count: String(32 * 1024 * 1024 + 1) }],
    });
    await expect(
      collectPortableAccountDeletionExport({
        requestId: REQUEST_ID,
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        generatedAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "EXPORT_TOO_LARGE" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  test("serializes deterministically, redacts credentials, and fails closed on size", () => {
    const input = {
      requestId: REQUEST_ID,
      userId: USER_ID,
      organizationId: ORGANIZATION_ID,
      generatedAt: NOW,
      tables: [
        {
          table: "users",
          rowCount: 1,
          rows: [
            {
              id: USER_ID,
              email: "fixture@example.test",
              access_token: "must-not-export",
              providerConfig: {
                refreshToken: "nested-must-not-export",
                apiKey: "camel-case-must-not-export",
              },
              avatar_bytes: new Uint8Array([1, 2, 3]),
            },
          ],
        },
        {
          table: "organizations",
          rowCount: 1,
          rows: [{ id: ORGANIZATION_ID, name: "Fixture" }],
        },
      ],
    };
    const first = serializePortableAccountDeletionExport(input);
    const second = serializePortableAccountDeletionExport({
      ...input,
      tables: [
        input.tables[1]!,
        {
          ...input.tables[0]!,
          rows: [
            {
              avatar_bytes: new Uint8Array([1, 2, 3]),
              access_token: "must-not-export",
              email: "fixture@example.test",
              id: USER_ID,
              providerConfig: {
                apiKey: "camel-case-must-not-export",
                refreshToken: "nested-must-not-export",
              },
            },
          ],
        },
      ],
    });
    expect(first).toEqual(second);
    const decoded = new TextDecoder().decode(first);
    expect(decoded).toContain("fixture@example.test");
    expect(decoded).toContain("[REDACTED_SECURITY_MATERIAL]");
    expect(decoded).not.toContain("must-not-export");
    expect(decoded).not.toContain("nested-must-not-export");
    expect(decoded).not.toContain("camel-case-must-not-export");
    expect(decoded).toContain('"byteCount":3');
    expect(() => serializePortableAccountDeletionExport({ ...input, maxBytes: 10 })).toThrow(
      "streamed support export",
    );
  });

  test("AES-GCM binds ciphertext to the recovery capability and request digest", () => {
    const encrypted = encryptAccountDeletionExport(
      PLAINTEXT,
      RECOVERY_CREDENTIAL,
      REQUEST_DIGEST,
      Buffer.alloc(12, 7),
    );
    expect(encrypted).not.toEqual(PLAINTEXT);
    expect(decryptAccountDeletionExport(encrypted, RECOVERY_CREDENTIAL, REQUEST_DIGEST)).toEqual(
      PLAINTEXT,
    );
    expect(() => decryptAccountDeletionExport(encrypted, "x".repeat(43), REQUEST_DIGEST)).toThrow(
      "integrity",
    );
  });

  test("writes encrypted bytes, verifies read-back, and commits the fenced receipt", async () => {
    const bucket = new MemoryBucket();
    const result = await getAccountDeletionExport(RECOVERY_CREDENTIAL, {
      bucket,
      now: () => NOW,
      collect: async () => PLAINTEXT,
    });

    expect(result.bytes).toEqual(PLAINTEXT);
    expect(result.contentDigest).toBe(createHash("sha256").update(PLAINTEXT).digest("hex"));
    expect(bucket.objects.size).toBe(1);
    expect([...bucket.objects.values()][0]?.bytes).not.toEqual(PLAINTEXT);
    expect(bucket.putOptions[0]).toMatchObject({
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      customMetadata: {
        format: "eliza-account-export-v1",
        contentDigest: result.contentDigest,
      },
    });
    expect(completeExportPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: REQUEST_ID,
        generation: 1,
        contentDigest: result.contentDigest,
        byteCount: PLAINTEXT.byteLength,
      }),
    );
  });

  test("reconciles an object-store success whose response was lost without repeating put", async () => {
    const bucket = new MemoryBucket();
    bucket.throwAfterPut = true;
    await expect(
      getAccountDeletionExport(RECOVERY_CREDENTIAL, {
        bucket,
        now: () => NOW,
        collect: async () => PLAINTEXT,
      }),
    ).rejects.toThrow("response lost");
    expect(markPhaseForReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "EXPORT_OBJECT_OUTCOME_AMBIGUOUS",
      }),
    );
    expect(bucket.objects.size).toBe(1);

    leasePhase.mockResolvedValueOnce({
      receipt: {
        id: "44444444-4444-4444-8444-444444444444",
        status: "reconciling",
      },
      generation: 2,
    });
    const put = mock(bucket.put.bind(bucket));
    bucket.put = put;
    const result = await getAccountDeletionExport(RECOVERY_CREDENTIAL, {
      bucket,
      now: () => new Date(NOW.getTime() + 6 * 60_000),
      collect: async () => {
        throw new Error("must not rebuild");
      },
    });

    expect(result.bytes).toEqual(PLAINTEXT);
    expect(put).not.toHaveBeenCalled();
    expect(completeExportPhase).toHaveBeenLastCalledWith(
      expect.objectContaining({ generation: 2 }),
    );
  });

  test("confirms provider absence before making a later rebuild retryable", async () => {
    const bucket = new MemoryBucket();
    leasePhase.mockResolvedValueOnce({
      receipt: {
        id: "44444444-4444-4444-8444-444444444444",
        status: "reconciling",
      },
      generation: 3,
    });

    await expect(
      getAccountDeletionExport(RECOVERY_CREDENTIAL, {
        bucket,
        now: () => NOW,
        collect: async () => PLAINTEXT,
      }),
    ).rejects.toMatchObject({ code: "EXPORT_UNAVAILABLE" });
    expect(markPhaseRetryable).toHaveBeenCalledWith(
      expect.objectContaining({
        generation: 3,
        retryClass: "provider_absence_confirmed",
      }),
    );
  });

  test("reconciles an expired export delete with a lost response without repeating delete", async () => {
    const candidate = { requestId: REQUEST_ID, requestDigest: REQUEST_DIGEST };
    findExpiredExportCandidates.mockResolvedValueOnce([candidate]);
    findExportRevocationsDue.mockResolvedValue([candidate]);
    const bucket = new MemoryBucket();
    bucket.objects.set(
      `account-deletion-exports/v1/${createHash("sha256")
        .update(`object:${REQUEST_DIGEST}`)
        .digest("hex")}.bin`,
      {
        bytes: new Uint8Array([1]),
        metadata: { etag: "etag", size: 1 },
      },
    );
    bucket.throwAfterDelete = true;

    await expect(
      reconcileAccountDeletionExportRevocations(1, {
        bucket,
        now: () => NOW,
      }),
    ).resolves.toEqual({ scheduled: 1, completed: 0, pending: 1 });
    expect(ensureExportRevocationPhase).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: REQUEST_ID }),
    );
    expect(markPhaseForReconciliation).toHaveBeenLastCalledWith(
      expect.objectContaining({ errorCode: "EXPORT_REVOCATION_OUTCOME_AMBIGUOUS" }),
    );

    leasePhase.mockResolvedValueOnce({
      receipt: {
        id: "44444444-4444-4444-8444-444444444444",
        status: "reconciling",
      },
      generation: 2,
    });
    const remove = mock(bucket.delete.bind(bucket));
    bucket.delete = remove;
    await expect(
      reconcileAccountDeletionExportRevocations(1, {
        bucket,
        now: () => new Date(NOW.getTime() + 60_001),
      }),
    ).resolves.toEqual({ scheduled: 0, completed: 1, pending: 0 });
    expect(remove).not.toHaveBeenCalled();
    expect(completeExportRevocation).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: REQUEST_ID, generation: 2 }),
    );
  });
});
