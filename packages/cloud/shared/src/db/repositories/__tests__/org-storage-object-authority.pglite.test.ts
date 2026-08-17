/**
 * Exercises the immutable-key organization storage state machine against real PGlite transactions.
 * The suite uses the production DDL and primary repository paths without mocks.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { OrgStorageObject } from "../../schemas/org-storage-objects";
import type { OrgStorageOperation } from "../../schemas/org-storage-operations";
import type {
  AbortOperationInput,
  ClaimOperationInput,
  CommitDeleteInput,
  CommitPutInput,
  OrgStorageOperationClaim,
  PrepareOperationInput,
  PrepareOperationResult,
  RegisterObservedAuthorityInput,
  ResolveObjectReadByKeyResult,
  SourceAbsenceProof,
} from "../org-storage-object-authority";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const LEASE_MS = 60_000;
const TEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 2_147_483_647;

let sequence = 1;
let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | null = null;
let dbWrite: typeof import("../../client").dbWrite;
let getPgliteClientForTests: typeof import("../../client").getPgliteClientForTests;
let orgStorageObjects: typeof import("../../schemas/org-storage-objects").orgStorageObjects;
let orgStorageOperations: typeof import("../../schemas/org-storage-operations").orgStorageOperations;
let orgStorageQuota: typeof import("../../schemas/org-storage-quota").orgStorageQuota;
let reader: typeof import("../org-storage-object-authority").orgStorageObjectAuthorityReader;
let writer: typeof import("../org-storage-object-authority").orgStorageObjectAuthorityWriter;
let orgStorageProviderKey: typeof import("../org-storage-object-authority").orgStorageProviderKey;

type PresentOrgStorageObject = OrgStorageObject & {
  provider_version: string;
  provider_etag: string;
  content_type: string;
  provider_uploaded_at: Date;
};

function assertPresentOrgStorageObject(
  authority: OrgStorageObject,
): asserts authority is PresentOrgStorageObject {
  if (
    authority.provider_version === null ||
    authority.provider_etag === null ||
    authority.content_type === null ||
    authority.provider_uploaded_at === null
  ) {
    throw new Error("Registered present authority is missing provider evidence");
  }
}

function uuid(): string {
  const suffix = sequence.toString(16).padStart(12, "0");
  sequence += 1;
  return `10000000-0000-4000-8000-${suffix}`;
}

function digest(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

function prefixedDigest(seed: number): string {
  return `sha256:${digest(seed)}`;
}

function logicalKey(organizationId: string, suffix: string): string {
  return `org/${organizationId}/attachments/${suffix}`;
}

function expected(object: OrgStorageObject) {
  return {
    presence: object.presence,
    committedGeneration: object.committed_generation,
    sizeBytes: object.size_bytes,
    providerVersion: object.provider_version,
    providerEtag: object.provider_etag,
  };
}

async function seedQuota(
  organizationId: string,
  bytesUsed: bigint,
  bytesLimit: bigint,
): Promise<void> {
  await dbWrite.insert(orgStorageQuota).values({
    organization_id: organizationId,
    bytes_used: bytesUsed,
    bytes_limit: bytesLimit,
  });
}

async function quotaBytes(organizationId: string): Promise<bigint | undefined> {
  const [quota] = await dbWrite
    .select()
    .from(orgStorageQuota)
    .where(eq(orgStorageQuota.organization_id, organizationId));
  return quota?.bytes_used;
}

async function registerAbsent(organizationId: string, suffix: string): Promise<OrgStorageObject> {
  const result = await writer.registerObservedAuthority({
    organizationId,
    objectKey: logicalKey(organizationId, suffix),
    observation: { presence: "absent" },
  });
  if (result.outcome === "conflict") throw new Error("Unexpected authority conflict");
  return result.authority;
}

async function registerPresent(
  organizationId: string,
  suffix: string,
  sizeBytes: bigint,
): Promise<PresentOrgStorageObject> {
  const result = await writer.registerObservedAuthority({
    organizationId,
    objectKey: logicalKey(organizationId, suffix),
    observation: {
      presence: "present",
      sizeBytes,
      providerVersion: `legacy-version-${suffix}`,
      providerEtag: `legacy-etag-${suffix}`,
      contentType: "application/octet-stream",
      checksumSha256: digest(10),
      providerUploadedAt: new Date(Date.now() - 10_000),
    },
  });
  if (result.outcome === "conflict") throw new Error("Unexpected authority conflict");
  const { authority } = result;
  assertPresentOrgStorageObject(authority);
  return authority;
}

function putInput(
  object: OrgStorageObject,
  options: {
    operationId?: string;
    idempotencyKey: string;
    requestDigest?: string;
    targetSizeBytes: bigint;
    checksumSeed?: number;
    expectedAuthority?: ReturnType<typeof expected>;
  },
): PrepareOperationInput {
  return {
    organizationId: object.organization_id,
    objectId: object.id,
    operationId: options.operationId ?? uuid(),
    idempotencyKey: options.idempotencyKey,
    requestDigest: options.requestDigest ?? prefixedDigest(20),
    expected: options.expectedAuthority ?? expected(object),
    operation: "put",
    targetSizeBytes: options.targetSizeBytes,
    targetContentType: "application/octet-stream",
    targetContentSha256: digest(options.checksumSeed ?? 21),
  };
}

function deleteInput(object: OrgStorageObject, idempotencyKey: string): PrepareOperationInput {
  return {
    organizationId: object.organization_id,
    objectId: object.id,
    operationId: uuid(),
    idempotencyKey,
    requestDigest: prefixedDigest(sequence + 100),
    expected: expected(object),
    operation: "delete",
  };
}

function prepared(result: PrepareOperationResult): OrgStorageOperation {
  if (result.outcome !== "prepared") {
    throw new Error(`Expected prepared, received ${result.outcome}`);
  }
  return result.operation;
}

function presentSnapshot(result: ResolveObjectReadByKeyResult) {
  if (result.outcome !== "present") {
    throw new Error(`Expected present read projection, received ${result.outcome}`);
  }
  return result.snapshot;
}

async function claim(
  operation: OrgStorageOperation,
  claimGeneration = uuid(),
  claimOwner = "storage-worker-a",
): Promise<OrgStorageOperationClaim> {
  const result = await writer.claimOperationById({
    organizationId: operation.organization_id,
    operationId: operation.id,
    claimOwner,
    claimGeneration,
    leaseMs: LEASE_MS,
  });
  if (result.outcome !== "claimed") {
    throw new Error(`Expected claimed, received ${result.reason}`);
  }
  return result.claim;
}

function fence(claimed: OrgStorageOperationClaim) {
  return {
    organizationId: claimed.operation.organization_id,
    operationId: claimed.operation.id,
    claimOwner: claimed.claimOwner,
    claimGeneration: claimed.claimGeneration,
  };
}

async function startProvider(claimed: OrgStorageOperationClaim): Promise<OrgStorageOperationClaim> {
  const transition = await writer.markProviderStarted({
    ...fence(claimed),
    nextAttemptAt: new Date(Date.now() + 5_000),
  });
  return { ...claimed, operation: transition.operation };
}

function sourceAbsence(operation: OrgStorageOperation): SourceAbsenceProof {
  return operation.source_provider_key === null
    ? { kind: "no_source", sourceProviderKey: null }
    : {
        kind: "source_provider_key_confirmed_absent",
        sourceProviderKey: operation.source_provider_key,
      };
}

function putCommitInput(
  claimed: OrgStorageOperationClaim,
  version = `provider-version-${sequence}`,
): CommitPutInput {
  const targetObservedAt = new Date();
  const operation = claimed.operation;
  if (operation.target_provider_key === null || operation.target_content_sha256 === null) {
    throw new Error("PUT operation is missing target evidence");
  }
  return {
    ...fence(claimed),
    receiptDigest: digest(sequence + 200),
    sourceAbsenceProof: sourceAbsence(operation),
    targetEvidence: {
      kind: "target_provider_object_observed",
      providerKey: operation.target_provider_key,
      providerVersion: version,
      providerEtag: `etag-${sequence}`,
      sizeBytes: operation.target_size_bytes,
      checksumSha256: operation.target_content_sha256,
      providerUploadedAt: new Date(targetObservedAt.getTime() - 1),
      contentType: operation.target_content_type ?? "application/octet-stream",
      customMetadata: {
        operationId: operation.id,
        targetGeneration: operation.target_generation.toString(10),
        requestDigest: operation.request_digest,
      },
    },
  };
}

async function commitPut(
  claimed: OrgStorageOperationClaim,
  version = `provider-version-${sequence}`,
) {
  return await writer.commitPut(putCommitInput(claimed, version));
}

function deleteCommitInput(claimed: OrgStorageOperationClaim): CommitDeleteInput {
  return {
    ...fence(claimed),
    receiptDigest: digest(sequence + 300),
    sourceAbsenceProof: sourceAbsence(claimed.operation),
  };
}

async function commitDelete(claimed: OrgStorageOperationClaim) {
  return await writer.commitDelete(deleteCommitInput(claimed));
}

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }
  if (!(rejection instanceof Error) || !("code" in rejection)) {
    throw rejection ?? new Error("Expected promise to reject");
  }
  expect(rejection.code).toBe(code);
}

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } = await import(
    "../../client"
  ));
  ({ orgStorageObjects } = await import("../../schemas/org-storage-objects"));
  ({ orgStorageOperations } = await import("../../schemas/org-storage-operations"));
  ({ orgStorageQuota } = await import("../../schemas/org-storage-quota"));
  ({
    orgStorageObjectAuthorityReader: reader,
    orgStorageObjectAuthorityWriter: writer,
    orgStorageProviderKey,
  } = await import("../org-storage-object-authority"));

  const database = getPgliteClientForTests();
  await database.exec("CREATE TABLE organizations (id uuid PRIMARY KEY);");
  const quotaMigration = readFileSync(
    join(import.meta.dir, "../../migrations/0102_add_org_storage_quota.sql"),
    "utf8",
  );
  const pricingMarker = quotaMigration.indexOf("-- Pricing entries for the storage proxy.");
  if (pricingMarker === -1) throw new Error("Quota migration marker is missing");
  await database.exec(quotaMigration.slice(0, pricingMarker));
  for (const tag of [
    "0236_org_storage_objects",
    "0237_org_storage_operations",
    "0238_org_storage_immutable_provider_keys",
  ]) {
    await database.exec(readFileSync(join(import.meta.dir, `../../migrations/${tag}.sql`), "utf8"));
  }
}, TEST_TIMEOUT_MS);

beforeEach(async () => {
  sequence = 1;
  await getPgliteClientForTests().exec(`
    DELETE FROM org_storage_operations;
    DELETE FROM org_storage_objects;
    DELETE FROM org_storage_quota;
    DELETE FROM organizations;
    INSERT INTO organizations (id) VALUES ('${ORG_A}'), ('${ORG_B}');
  `);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests?.();
});

describe("Org storage object authority repository", () => {
  test("registers exact NFC legacy authority and rejects ambiguous boundary inputs", async () => {
    const object = await registerPresent(ORG_A, "caf\u00e9", 7n);
    expect(object.current_provider_key).toBe(object.object_key);
    expect(object.key_fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await quotaBytes(ORG_A)).toBeUndefined();

    const replay = await writer.registerObservedAuthority({
      organizationId: ORG_A,
      objectKey: object.object_key,
      observation: {
        presence: "present",
        sizeBytes: 7n,
        providerVersion: "legacy-version-caf\u00e9",
        providerEtag: "legacy-etag-caf\u00e9",
        contentType: "application/octet-stream",
        checksumSha256: digest(10),
        providerUploadedAt: object.provider_uploaded_at ?? new Date(0),
      },
    });
    expect(replay.outcome).toBe("replayed");

    await expectErrorCode(
      writer.registerObservedAuthority({
        organizationId: ORG_A,
        objectKey: logicalKey(ORG_A, "cafe\u0301"),
        observation: { presence: "absent" },
      }),
      "ORG_STORAGE_AUTHORITY_INVALID_INPUT",
    );
    await expectErrorCode(
      writer.registerObservedAuthority({
        organizationId: ORG_A,
        objectKey: logicalKey(ORG_A, "bad\u0085key"),
        observation: { presence: "absent" },
      }),
      "ORG_STORAGE_AUTHORITY_INVALID_INPUT",
    );
    await expectErrorCode(
      writer.registerObservedAuthority({
        organizationId: ORG_A.toUpperCase(),
        objectKey: logicalKey(ORG_A, "uppercase"),
        observation: { presence: "absent" },
      }),
      "ORG_STORAGE_AUTHORITY_INVALID_INPUT",
    );
    await expectErrorCode(
      Promise.resolve().then(() => orgStorageProviderKey(ORG_A, object.id, 0n)),
      "ORG_STORAGE_AUTHORITY_INVALID_INPUT",
    );
    await expectErrorCode(
      writer.registerObservedAuthority({
        organizationId: ORG_A,
        objectKey: logicalKey(ORG_A, "lone-surrogate-\ud800"),
        observation: { presence: "absent" },
      }),
      "ORG_STORAGE_AUTHORITY_INVALID_INPUT",
    );
    const astral = await registerAbsent(ORG_A, "astral-\u{1f680}");
    const replacementCharacter = await registerAbsent(ORG_A, "replacement-\ufffd");
    const beforeRegistration = Date.now() - 1_000;
    const skewedRegistration: RegisterObservedAuthorityInput = {
      organizationId: ORG_A,
      objectKey: logicalKey(ORG_A, "db-clock"),
      observation: { presence: "absent" },
    };
    Object.assign(skewedRegistration, { observedAt: new Date("2999-01-01T00:00:00.000Z") });
    const dbClockRegistration = await writer.registerObservedAuthority(skewedRegistration);
    if (dbClockRegistration.outcome === "conflict") {
      throw new Error("Unexpected DB-clock authority conflict");
    }
    expect(astral.object_key).toEndWith("astral-\u{1f680}");
    expect(replacementCharacter.object_key).toEndWith("replacement-\ufffd");
    expect(dbClockRegistration.authority.verified_at.getTime()).toBeGreaterThanOrEqual(
      beforeRegistration,
    );
    expect(dbClockRegistration.authority.verified_at.getTime()).toBeLessThanOrEqual(
      Date.now() + 1_000,
    );
    expect(await dbWrite.select().from(orgStorageObjects)).toHaveLength(4);
  });

  test("resolves missing, tombstone, legacy, prepared, and tenant-scoped read windows", async () => {
    const missingKey = logicalKey(ORG_A, "missing-read");
    expect(await reader.resolveObjectReadByKey(ORG_A, missingKey)).toEqual({ outcome: "absent" });

    const tombstone = await registerAbsent(ORG_A, "tombstone-read");
    expect(await reader.resolveObjectReadByKey(ORG_A, tombstone.object_key)).toEqual({
      outcome: "absent",
    });

    const legacy = await registerPresent(ORG_A, "legacy-read", 7n);
    const deleteSource = await registerPresent(ORG_A, "prepared-delete-read", 5n);
    const creation = await registerAbsent(ORG_A, "prepared-create-read");
    const otherTenant = await registerPresent(ORG_B, "tenant-only-read", 3n);
    await seedQuota(ORG_A, 12n, 100n);

    expect(presentSnapshot(await reader.resolveObjectReadByKey(ORG_A, legacy.object_key))).toEqual({
      organizationId: ORG_A,
      objectId: legacy.id,
      objectKey: legacy.object_key,
      committedGeneration: 1n,
      sizeBytes: 7n,
      providerKey: legacy.object_key,
      providerVersion: legacy.provider_version,
      providerEtag: legacy.provider_etag,
      contentType: legacy.content_type,
      checksumSha256: legacy.checksum_sha256,
      providerUploadedAt: legacy.provider_uploaded_at,
    });

    prepared(
      await writer.prepareOperation(
        putInput(legacy, {
          idempotencyKey: "prepared-overwrite-read",
          targetSizeBytes: 9n,
          checksumSeed: 91,
        }),
      ),
    );
    prepared(await writer.prepareOperation(deleteInput(deleteSource, "prepared-delete-read")));
    prepared(
      await writer.prepareOperation(
        putInput(creation, {
          idempotencyKey: "prepared-create-read",
          targetSizeBytes: 2n,
          checksumSeed: 92,
        }),
      ),
    );

    expect(
      presentSnapshot(await reader.resolveObjectReadByKey(ORG_A, legacy.object_key))
        .providerVersion,
    ).toBe(legacy.provider_version);
    expect(
      presentSnapshot(await reader.resolveObjectReadByKey(ORG_A, deleteSource.object_key))
        .providerVersion,
    ).toBe(deleteSource.provider_version);
    expect(await reader.resolveObjectReadByKey(ORG_A, creation.object_key)).toEqual({
      outcome: "absent",
    });

    expect(
      presentSnapshot(await reader.resolveObjectReadByKey(ORG_B, otherTenant.object_key)),
    ).toMatchObject({
      organizationId: ORG_B,
      objectId: otherTenant.id,
      objectKey: otherTenant.object_key,
      providerVersion: otherTenant.provider_version,
    });
    expect(
      await reader.resolveObjectReadByKey(ORG_A, logicalKey(ORG_A, "tenant-only-read")),
    ).toEqual({ outcome: "absent" });
  });

  test("returns explicit provider-started and quarantined mutation fences", async () => {
    const present = await registerPresent(ORG_A, "started-read", 5n);
    const absent = await registerAbsent(ORG_A, "quarantined-read");
    await seedQuota(ORG_A, 5n, 100n);

    const presentOperation = prepared(
      await writer.prepareOperation(
        putInput(present, {
          idempotencyKey: "started-read",
          targetSizeBytes: 6n,
          checksumSeed: 93,
        }),
      ),
    );
    const presentStarted = await startProvider(await claim(presentOperation));
    expect(await reader.resolveObjectReadByKey(ORG_A, present.object_key)).toEqual({
      outcome: "in_progress",
      objectId: present.id,
      committedGeneration: 1n,
      targetGeneration: presentStarted.operation.target_generation,
      activeState: "provider_started",
    });

    const absentOperation = prepared(
      await writer.prepareOperation(
        putInput(absent, {
          idempotencyKey: "quarantined-read",
          targetSizeBytes: 2n,
          checksumSeed: 94,
        }),
      ),
    );
    const absentStarted = await startProvider(await claim(absentOperation));
    await writer.quarantineOperation({
      ...fence(absentStarted),
      errorCode: "READ_FENCE_QUARANTINE",
      errorDigest: digest(95),
    });
    expect(await reader.resolveObjectReadByKey(ORG_A, absent.object_key)).toEqual({
      outcome: "in_progress",
      objectId: absent.id,
      committedGeneration: 0n,
      targetGeneration: absentStarted.operation.target_generation,
      activeState: "quarantined",
    });
  });

  test("projects committed immutable PUT evidence and committed DELETE absence", async () => {
    const putTarget = await registerAbsent(ORG_A, "committed-put-read");
    const deleteTarget = await registerPresent(ORG_A, "committed-delete-read", 4n);
    await seedQuota(ORG_A, 4n, 100n);

    const putOperation = prepared(
      await writer.prepareOperation(
        putInput(putTarget, {
          idempotencyKey: "committed-put-read",
          targetSizeBytes: 3n,
          checksumSeed: 96,
        }),
      ),
    );
    const putClaim = await startProvider(await claim(putOperation));
    const putReceipt = putCommitInput(putClaim, "provider-version-committed-read");
    await writer.commitPut(putReceipt);

    if (putOperation.target_provider_key === null) {
      throw new Error("Prepared PUT operation is missing its target provider key");
    }

    const committedSnapshot = presentSnapshot(
      await reader.resolveObjectReadByKey(ORG_A, putTarget.object_key),
    );
    expect(committedSnapshot).toEqual({
      organizationId: ORG_A,
      objectId: putTarget.id,
      objectKey: putTarget.object_key,
      committedGeneration: putOperation.target_generation,
      sizeBytes: putReceipt.targetEvidence.sizeBytes,
      providerKey: putOperation.target_provider_key,
      providerVersion: putReceipt.targetEvidence.providerVersion,
      providerEtag: putReceipt.targetEvidence.providerEtag,
      contentType: putReceipt.targetEvidence.contentType,
      checksumSha256: putReceipt.targetEvidence.checksumSha256,
      providerUploadedAt: putReceipt.targetEvidence.providerUploadedAt,
    });
    expect(committedSnapshot.providerKey).toBe(
      orgStorageProviderKey(ORG_A, putTarget.id, putOperation.target_generation),
    );

    const deleteOperation = prepared(
      await writer.prepareOperation(deleteInput(deleteTarget, "committed-delete-read")),
    );
    await commitDelete(await startProvider(await claim(deleteOperation)));
    expect(await reader.resolveObjectReadByKey(ORG_A, deleteTarget.object_key)).toEqual({
      outcome: "absent",
    });
  });

  test("fails closed when a present read snapshot is malformed", async () => {
    const object = await registerPresent(ORG_A, "malformed-read", 1n);
    await dbWrite
      .update(orgStorageObjects)
      .set({ key_fingerprint: prefixedDigest(97) })
      .where(eq(orgStorageObjects.id, object.id));
    await expectErrorCode(
      reader.resolveObjectReadByKey(ORG_A, object.object_key),
      "ORG_STORAGE_AUTHORITY_INVARIANT",
    );

    await dbWrite
      .update(orgStorageObjects)
      .set({
        key_fingerprint: object.key_fingerprint,
        provider_version: "malformed\nversion",
      })
      .where(eq(orgStorageObjects.id, object.id));

    await expectErrorCode(
      reader.resolveObjectReadByKey(ORG_A, object.object_key),
      "ORG_STORAGE_AUTHORITY_INVARIANT",
    );
  });

  test("requires an explicitly reconciled quota baseline before admission", async () => {
    const object = await registerPresent(ORG_A, "quota-baseline", 10n);
    const missing = await writer.prepareOperation(
      putInput(object, { idempotencyKey: "quota-missing", targetSizeBytes: 3n }),
    );
    expect(missing).toEqual({ outcome: "quota_unreconciled", reason: "missing" });
    expect(await dbWrite.select().from(orgStorageOperations)).toHaveLength(0);

    await seedQuota(ORG_A, 9n, 100n);
    const belowSource = await writer.prepareOperation(
      putInput(object, { idempotencyKey: "quota-below-source", targetSizeBytes: 3n }),
    );
    expect(belowSource).toEqual({ outcome: "quota_unreconciled", reason: "below_source" });
    expect(await quotaBytes(ORG_A)).toBe(9n);
    expect(await dbWrite.select().from(orgStorageOperations)).toHaveLength(0);

    await dbWrite
      .update(orgStorageQuota)
      .set({ bytes_used: 10n })
      .where(eq(orgStorageQuota.organization_id, ORG_A));
    const admitted = prepared(
      await writer.prepareOperation(
        putInput(object, { idempotencyKey: "quota-reconciled", targetSizeBytes: 3n }),
      ),
    );
    expect(admitted.quota_reserved_bytes).toBe(3n);
    expect(admitted.quota_release_bytes).toBe(10n);
    expect(await quotaBytes(ORG_A)).toBe(13n);
  });

  test("admits over-limit DELETE but rejects copy-on-write shrink without temporary headroom", async () => {
    const object = await registerPresent(ORG_A, "over-limit", 10n);
    await seedQuota(ORG_A, 10n, 5n);

    const shrink = await writer.prepareOperation(
      putInput(object, { idempotencyKey: "over-limit-shrink", targetSizeBytes: 3n }),
    );
    expect(shrink).toEqual({
      outcome: "quota_exceeded",
      bytesUsed: 10n,
      bytesLimit: 5n,
      requiredBytes: 3n,
    });
    expect(await quotaBytes(ORG_A)).toBe(10n);

    const deletion = prepared(
      await writer.prepareOperation(deleteInput(object, "over-limit-delete")),
    );
    expect(deletion.quota_reserved_bytes).toBe(0n);
    expect(deletion.quota_release_bytes).toBe(10n);
    await commitDelete(await startProvider(await claim(deletion)));
    expect(await quotaBytes(ORG_A)).toBe(0n);
  });

  test("converges sixteen same-key admissions and replays after commit with fresh internal inputs", async () => {
    const object = await registerAbsent(ORG_A, "same-key");
    await seedQuota(ORG_A, 0n, 100n);
    const inputs = Array.from({ length: 16 }, () =>
      putInput(object, {
        operationId: uuid(),
        idempotencyKey: "same-client-key",
        requestDigest: prefixedDigest(30),
        targetSizeBytes: 10n,
      }),
    );
    const results = await Promise.all(inputs.map((input) => writer.prepareOperation(input)));
    expect(results.filter(({ outcome }) => outcome === "prepared")).toHaveLength(1);
    expect(results.filter(({ outcome }) => outcome === "replayed")).toHaveLength(15);
    const operationIds = new Set(
      results.flatMap((result) =>
        result.outcome === "prepared" || result.outcome === "replayed" ? [result.operation.id] : [],
      ),
    );
    expect(operationIds.size).toBe(1);
    expect(await quotaBytes(ORG_A)).toBe(10n);

    const operation = results.find(({ outcome }) => outcome === "prepared");
    if (!operation || operation.outcome !== "prepared") throw new Error("Prepared row missing");
    const commitInput = putCommitInput(await startProvider(await claim(operation.operation)));
    const committed = await writer.commitPut(commitInput);
    expect(committed.operation.state).toBe("committed");
    expect((await writer.commitPut(commitInput)).outcome).toBe("replayed");
    expect(await quotaBytes(ORG_A)).toBe(10n);
    await dbWrite.delete(orgStorageQuota).where(eq(orgStorageQuota.organization_id, ORG_A));
    expect((await writer.commitPut(commitInput)).outcome).toBe("replayed");
    const current = await reader.findObjectById(ORG_A, object.id);
    if (!current) throw new Error("Current object missing");
    const retry = await writer.prepareOperation({
      ...inputs[0],
      operationId: uuid(),
      expected: expected(current),
    });
    expect(retry.outcome).toBe("replayed");
    const conflict = await writer.prepareOperation({
      ...inputs[0],
      operationId: uuid(),
      requestDigest: prefixedDigest(31),
      expected: expected(current),
    });
    expect(conflict).toEqual({ outcome: "conflict", reason: "idempotency_mismatch" });
    const newAdmission = await writer.prepareOperation(
      putInput(current, { idempotencyKey: "new-client-key", targetSizeBytes: 1n }),
    );
    expect(newAdmission).toEqual({ outcome: "quota_unreconciled", reason: "missing" });
  });

  test("fences distinct same-object requests and admits only one cross-object quota reservation", async () => {
    const first = await registerAbsent(ORG_A, "fence-a");
    await seedQuota(ORG_A, 0n, 10n);
    const sameObject = await Promise.all([
      writer.prepareOperation(
        putInput(first, { idempotencyKey: "fence-one", targetSizeBytes: 3n }),
      ),
      writer.prepareOperation(
        putInput(first, { idempotencyKey: "fence-two", targetSizeBytes: 3n }),
      ),
    ]);
    expect(sameObject.map(({ outcome }) => outcome).sort()).toEqual(["busy", "prepared"]);

    await getPgliteClientForTests().exec(`
      DELETE FROM org_storage_operations;
      UPDATE org_storage_objects SET last_allocated_generation = committed_generation;
      UPDATE org_storage_quota SET bytes_used = 0;
    `);
    const second = await registerAbsent(ORG_A, "fence-b");
    const crossObject = await Promise.all([
      writer.prepareOperation(
        putInput(first, { idempotencyKey: "quota-one", targetSizeBytes: 6n }),
      ),
      writer.prepareOperation(
        putInput(second, { idempotencyKey: "quota-two", targetSizeBytes: 6n }),
      ),
    ]);
    expect(crossObject.map(({ outcome }) => outcome).sort()).toEqual([
      "prepared",
      "quota_exceeded",
    ]);
    expect(await quotaBytes(ORG_A)).toBe(6n);
  });

  test("settles two objects concurrently under the quota-object-operation lock order", async () => {
    const first = await registerPresent(ORG_A, "settle-a", 5n);
    const second = await registerPresent(ORG_A, "settle-b", 7n);
    await seedQuota(ORG_A, 12n, 100n);

    const admissions = await Promise.all([
      writer.prepareOperation(
        putInput(first, { idempotencyKey: "settle-a", targetSizeBytes: 3n, checksumSeed: 32 }),
      ),
      writer.prepareOperation(
        putInput(second, { idempotencyKey: "settle-b", targetSizeBytes: 4n, checksumSeed: 33 }),
      ),
    ]);
    const firstOperation = prepared(admissions[0]);
    const secondOperation = prepared(admissions[1]);
    expect(await quotaBytes(ORG_A)).toBe(19n);

    const [firstClaim, secondClaim] = await Promise.all([
      claim(firstOperation).then(startProvider),
      claim(secondOperation).then(startProvider),
    ]);
    await Promise.all([
      commitPut(firstClaim, "provider-version-settle-a"),
      commitPut(secondClaim, "provider-version-settle-b"),
    ]);

    expect(await quotaBytes(ORG_A)).toBe(7n);
    expect((await reader.findObjectById(ORG_A, first.id))?.size_bytes).toBe(3n);
    expect((await reader.findObjectById(ORG_A, second.id))?.size_bytes).toBe(4n);
  });

  test("settles copy-on-write shrink, delete, tombstone recreation, and generation holes exactly", async () => {
    const legacy = await registerPresent(ORG_A, "lifecycle", 10n);
    await seedQuota(ORG_A, 10n, 100n);

    const shrink = prepared(
      await writer.prepareOperation(
        putInput(legacy, { idempotencyKey: "shrink", targetSizeBytes: 4n, checksumSeed: 41 }),
      ),
    );
    expect(shrink.source_provider_key).toBe(legacy.object_key);
    expect(shrink.target_provider_key).toBe(
      orgStorageProviderKey(ORG_A, legacy.id, shrink.target_generation),
    );
    expect(await quotaBytes(ORG_A)).toBe(14n);
    const shrinkClaim = await startProvider(await claim(shrink));

    await expectErrorCode(
      commitPut(shrinkClaim, legacy.provider_version ?? "legacy-version"),
      "ORG_STORAGE_AUTHORITY_CONFLICT",
    );
    expect(await quotaBytes(ORG_A)).toBe(14n);
    await commitPut(shrinkClaim, "provider-version-shrink");
    expect(await quotaBytes(ORG_A)).toBe(4n);

    const afterShrink = await reader.findObjectById(ORG_A, legacy.id);
    if (!afterShrink) throw new Error("Shrunk object missing");
    const deletion = prepared(await writer.prepareOperation(deleteInput(afterShrink, "delete")));
    expect(deletion.source_provider_key).toBe(afterShrink.current_provider_key);
    expect(deletion.target_provider_key).toBeNull();
    const deleteClaim = await startProvider(await claim(deletion));
    const deleteCommit = deleteCommitInput(deleteClaim);
    const malformedDeleteProof = deleteCommitInput(deleteClaim);
    Reflect.set(malformedDeleteProof, "sourceAbsenceProof", undefined);
    await expectErrorCode(
      writer.commitDelete(malformedDeleteProof),
      "ORG_STORAGE_AUTHORITY_CONFLICT",
    );
    await writer.commitDelete(deleteCommit);
    expect(await quotaBytes(ORG_A)).toBe(0n);
    expect((await writer.commitDelete(deleteCommit)).outcome).toBe("replayed");
    expect(await quotaBytes(ORG_A)).toBe(0n);
    await dbWrite.delete(orgStorageQuota).where(eq(orgStorageQuota.organization_id, ORG_A));
    expect((await writer.commitDelete(deleteCommit)).outcome).toBe("replayed");
    await seedQuota(ORG_A, 0n, 100n);

    const tombstone = await reader.findObjectById(ORG_A, legacy.id);
    if (!tombstone) throw new Error("Tombstone missing");
    expect(tombstone.presence).toBe("absent");
    expect(tombstone.current_provider_key).toBeNull();
    const aborted = prepared(
      await writer.prepareOperation(
        putInput(tombstone, { idempotencyKey: "recreate-abort", targetSizeBytes: 2n }),
      ),
    );
    const abortClaim = await claim(aborted);
    const abortInput: AbortOperationInput = {
      ...fence(abortClaim),
      responseStatus: 409,
      receiptDigest: digest(50),
      errorCode: "CLIENT_ABORT",
      errorDigest: digest(51),
    };
    await writer.abortUnstarted(abortInput);
    expect(await quotaBytes(ORG_A)).toBe(0n);
    expect((await writer.abortUnstarted(abortInput)).outcome).toBe("replayed");
    expect(await quotaBytes(ORG_A)).toBe(0n);
    await dbWrite.delete(orgStorageQuota).where(eq(orgStorageQuota.organization_id, ORG_A));
    expect((await writer.abortUnstarted(abortInput)).outcome).toBe("replayed");
    await seedQuota(ORG_A, 0n, 100n);

    const afterAbort = await reader.findObjectById(ORG_A, legacy.id);
    if (!afterAbort) throw new Error("Object missing after abort");
    const recreated = prepared(
      await writer.prepareOperation(
        putInput(afterAbort, { idempotencyKey: "recreate", targetSizeBytes: 2n }),
      ),
    );
    expect(recreated.target_generation).toBe(aborted.target_generation + 1n);
    await commitPut(await startProvider(await claim(recreated)), "provider-version-recreated");
    const finalObject = await reader.findObjectById(ORG_A, legacy.id);
    expect(finalObject?.current_provider_key).toBe(recreated.target_provider_key);
    expect(
      new Set([
        legacy.current_provider_key,
        shrink.target_provider_key,
        aborted.target_provider_key,
        recreated.target_provider_key,
      ]).size,
    ).toBe(4);
    if (deletion.source_provider_key === null || recreated.target_provider_key === null) {
      throw new Error("Immutable provider key evidence missing");
    }
    const providerObjects = new Map([[recreated.target_provider_key, "recreated-generation"]]);
    providerObjects.delete(deletion.source_provider_key);
    expect(providerObjects.get(recreated.target_provider_key)).toBe("recreated-generation");
    expect(await quotaBytes(ORG_A)).toBe(2n);
  });

  test("keeps bigint quota arithmetic exact beyond Number.MAX_SAFE_INTEGER", async () => {
    const sourceBytes = 9_007_199_254_740_993n;
    const targetBytes = sourceBytes + 10n;
    const object = await registerPresent(ORG_A, "bigint", sourceBytes);
    await seedQuota(ORG_A, sourceBytes, sourceBytes + targetBytes + 1n);
    const operation = prepared(
      await writer.prepareOperation(
        putInput(object, { idempotencyKey: "bigint", targetSizeBytes: targetBytes }),
      ),
    );
    expect(operation.quota_reserved_bytes).toBe(targetBytes);
    expect(operation.quota_release_bytes).toBe(sourceBytes);
    expect(await quotaBytes(ORG_A)).toBe(sourceBytes + targetBytes);
    await commitPut(await startProvider(await claim(operation)), "provider-version-bigint");
    expect(await quotaBytes(ORG_A)).toBe(targetBytes);
  });

  test("uses caller claim generations with DB-clock leases and skips exhausted batch poison", async () => {
    const object = await registerAbsent(ORG_A, "claims");
    await seedQuota(ORG_A, 0n, 100n);
    const skewedAdmission = putInput(object, {
      idempotencyKey: "claims",
      targetSizeBytes: 1n,
    });
    Object.assign(skewedAdmission, { now: new Date("2999-01-01T00:00:00.000Z") });
    const operation = prepared(await writer.prepareOperation(skewedAdmission));
    const generationA = uuid();
    const generationB = uuid();
    const base: Omit<ClaimOperationInput, "claimGeneration"> = {
      organizationId: ORG_A,
      operationId: operation.id,
      claimOwner: "same-worker",
      leaseMs: LEASE_MS,
    };
    const concurrent = await Promise.all([
      writer.claimOperationById({ ...base, claimGeneration: generationA }),
      writer.claimOperationById({ ...base, claimGeneration: generationB }),
    ]);
    expect(concurrent.map(({ outcome }) => outcome).sort()).toEqual(["claimed", "not_claimed"]);
    const winner = concurrent.find((result) => result.outcome === "claimed");
    if (!winner || winner.outcome !== "claimed") throw new Error("Claim winner missing");
    const replay = await writer.claimOperationById({
      ...base,
      claimGeneration: winner.claim.claimGeneration,
    });
    expect(replay.outcome).toBe("claimed");
    expect(replay.outcome === "claimed" ? replay.claim.operation.attempts : 0).toBe(1);

    await dbWrite
      .update(orgStorageOperations)
      .set({ lease_expires_at: new Date(Date.now() - 1_000) })
      .where(eq(orgStorageOperations.id, operation.id));
    const reclaimed = await claim(operation, uuid(), "replacement-worker");
    await expectErrorCode(
      writer.markProviderStarted({
        ...fence(winner.claim),
        nextAttemptAt: new Date(Date.now() + 5_000),
      }),
      "ORG_STORAGE_AUTHORITY_STALE_FENCE",
    );
    const providerStarted = await startProvider(reclaimed);
    await dbWrite
      .update(orgStorageOperations)
      .set({ lease_expires_at: new Date(Date.now() - 1_000) })
      .where(eq(orgStorageOperations.id, operation.id));
    const markerReplay = await writer.markProviderStarted({
      ...fence(providerStarted),
      nextAttemptAt: new Date("2999-01-01T00:00:00.000Z"),
    });
    expect(markerReplay.outcome).toBe("replayed");
    expect(markerReplay.operation.next_attempt_at).toEqual(
      providerStarted.operation.next_attempt_at,
    );
    await expectErrorCode(
      writer.markProviderStarted({
        ...fence(providerStarted),
        claimGeneration: uuid(),
        nextAttemptAt: providerStarted.operation.next_attempt_at,
      }),
      "ORG_STORAGE_AUTHORITY_STALE_FENCE",
    );

    const exhaustedObject = await registerAbsent(ORG_A, "exhausted");
    const exhausted = prepared(
      await writer.prepareOperation(
        putInput(exhaustedObject, { idempotencyKey: "exhausted", targetSizeBytes: 1n }),
      ),
    );
    await dbWrite
      .update(orgStorageOperations)
      .set({ attempts: MAX_ATTEMPTS, next_attempt_at: new Date(0) })
      .where(eq(orgStorageOperations.id, exhausted.id));
    const otherTenant = await registerAbsent(ORG_B, "global");
    await seedQuota(ORG_B, 0n, 10n);
    const otherOperation = prepared(
      await writer.prepareOperation(
        putInput(otherTenant, { idempotencyKey: "global", targetSizeBytes: 1n }),
      ),
    );
    const batchInput = {
      claimOwner: "global-worker",
      claimGeneration: uuid(),
      leaseMs: LEASE_MS,
      limit: 1,
    };
    const globalClaims = await writer.claimDueOperationsGlobally(batchInput);
    expect(globalClaims.map(({ operation: row }) => row.id)).toEqual([otherOperation.id]);
    const batchReplay = await writer.claimDueOperationsGlobally(batchInput);
    expect(batchReplay.map(({ operation: row }) => [row.id, row.attempts])).toEqual([
      [otherOperation.id, 1],
    ]);
    const cannotSteal = await writer.claimDueOperationsGlobally({
      ...batchInput,
      claimGeneration: uuid(),
    });
    expect(cannotSteal).toEqual([]);
  });

  test("retains reservations through ambiguity and quarantine, then rearms without raw SQL", async () => {
    const object = await registerAbsent(ORG_A, "ambiguous");
    await seedQuota(ORG_A, 0n, 100n);
    const operation = prepared(
      await writer.prepareOperation(
        putInput(object, { idempotencyKey: "ambiguous", targetSizeBytes: 9n }),
      ),
    );
    const started = await startProvider(await claim(operation));
    await expectErrorCode(
      writer.abortUnstarted({
        ...fence(started),
        responseStatus: 502,
        receiptDigest: digest(60),
        errorCode: "AMBIGUOUS_PROVIDER",
        errorDigest: digest(61),
      }),
      "ORG_STORAGE_AUTHORITY_CONFLICT",
    );
    expect(await quotaBytes(ORG_A)).toBe(9n);

    const ambiguousInput = {
      ...fence(started),
      errorCode: "AMBIGUOUS_PROVIDER",
      errorDigest: digest(62),
      nextAttemptAt: new Date(Date.now() - 1),
    };
    expect((await writer.recordAmbiguousObservation(ambiguousInput)).outcome).toBe("applied");
    expect((await writer.recordAmbiguousObservation(ambiguousInput)).outcome).toBe("replayed");
    expect(await quotaBytes(ORG_A)).toBe(9n);

    const retry = await claim(operation, uuid(), "reconciler");
    await writer.quarantineOperation({
      ...fence(retry),
      errorCode: "FOREIGN_TARGET",
      errorDigest: digest(63),
    });
    expect(await quotaBytes(ORG_A)).toBe(9n);
    const ordinaryDue = await writer.claimDueOperations({
      organizationId: ORG_A,
      claimOwner: "ordinary-worker",
      claimGeneration: uuid(),
      leaseMs: LEASE_MS,
      limit: 10,
    });
    expect(ordinaryDue).toEqual([]);

    const rearmInput = {
      organizationId: ORG_A,
      operationId: operation.id,
      expectedErrorDigest: digest(63),
      claimOwner: "operator-recovery",
      claimGeneration: uuid(),
      leaseMs: LEASE_MS,
    };
    const rearmed = await writer.rearmQuarantinedOperation(rearmInput);
    const replayed = await writer.rearmQuarantinedOperation(rearmInput);
    expect(replayed.claimGeneration).toBe(rearmed.claimGeneration);
    expect(rearmed.operation.state).toBe("provider_started");
    expect(await quotaBytes(ORG_A)).toBe(9n);
  });

  test("fails closed on tenant, proof, metadata, provider identity, and aggregate drift", async () => {
    const object = await registerPresent(ORG_A, "fail-closed", 5n);
    await seedQuota(ORG_A, 5n, 100n);
    const operation = prepared(
      await writer.prepareOperation(
        putInput(object, { idempotencyKey: "fail-closed", targetSizeBytes: 6n }),
      ),
    );
    expect(await reader.findOperationById(ORG_B, operation.id)).toBeUndefined();
    expect(
      await writer.claimOperationById({
        organizationId: ORG_B,
        operationId: operation.id,
        claimOwner: "wrong-tenant",
        claimGeneration: uuid(),
        leaseMs: LEASE_MS,
      }),
    ).toEqual({ outcome: "not_claimed", reason: "not_found" });

    const otherTenant = await registerAbsent(ORG_B, "hash-privacy");
    await seedQuota(ORG_B, 0n, 100n);
    const otherTenantOperation = prepared(
      await writer.prepareOperation(
        putInput(otherTenant, { idempotencyKey: "fail-closed", targetSizeBytes: 1n }),
      ),
    );
    expect(otherTenantOperation.idempotency_key_hash).not.toBe(operation.idempotency_key_hash);

    const started = await startProvider(await claim(operation));
    if (started.operation.target_provider_key === null) throw new Error("Target key missing");
    const validCommit = putCommitInput(started, "provider-version-new");

    const malformedSourceProof = putCommitInput(started, "provider-version-new");
    Reflect.set(malformedSourceProof, "sourceAbsenceProof", undefined);
    await expectErrorCode(writer.commitPut(malformedSourceProof), "ORG_STORAGE_AUTHORITY_CONFLICT");

    const wrongProviderIdentity = putCommitInput(started, "provider-version-new");
    wrongProviderIdentity.targetEvidence.providerKey = orgStorageProviderKey(
      ORG_B,
      uuid(),
      started.operation.target_generation,
    );
    await expectErrorCode(
      writer.commitPut(wrongProviderIdentity),
      "ORG_STORAGE_AUTHORITY_CONFLICT",
    );

    await expectErrorCode(
      writer.commitPut({
        ...validCommit,
        sourceAbsenceProof: {
          kind: "source_provider_key_confirmed_absent",
          sourceProviderKey: `${started.operation.source_provider_key}-wrong`,
        },
      }),
      "ORG_STORAGE_AUTHORITY_CONFLICT",
    );
    await expectErrorCode(
      writer.commitPut({
        ...validCommit,
        sourceAbsenceProof: { kind: "no_source", sourceProviderKey: null },
      }),
      "ORG_STORAGE_AUTHORITY_CONFLICT",
    );

    const extraMetadata = putCommitInput(started, "provider-version-new");
    Object.assign(extraMetadata.targetEvidence.customMetadata, { unexpected: "foreign" });
    await expectErrorCode(writer.commitPut(extraMetadata), "ORG_STORAGE_AUTHORITY_CONFLICT");
    const wrongMetadataType = putCommitInput(started, "provider-version-new");
    Reflect.set(wrongMetadataType.targetEvidence.customMetadata, "operationId", 7);
    await expectErrorCode(writer.commitPut(wrongMetadataType), "ORG_STORAGE_AUTHORITY_CONFLICT");
    const noncanonicalGeneration = putCommitInput(started, "provider-version-new");
    noncanonicalGeneration.targetEvidence.customMetadata.targetGeneration = `0${started.operation.target_generation.toString(10)}`;
    await expectErrorCode(
      writer.commitPut(noncanonicalGeneration),
      "ORG_STORAGE_AUTHORITY_CONFLICT",
    );

    for (const field of ["providerVersion", "providerEtag", "contentType"]) {
      const malformedProviderEvidence = putCommitInput(started, "provider-version-new");
      Reflect.set(malformedProviderEvidence.targetEvidence, field, 7);
      await expectErrorCode(
        writer.commitPut(malformedProviderEvidence),
        "ORG_STORAGE_AUTHORITY_INVALID_INPUT",
      );
    }

    await dbWrite
      .update(orgStorageQuota)
      .set({ bytes_used: 10n })
      .where(eq(orgStorageQuota.organization_id, ORG_A));
    await expectErrorCode(writer.commitPut(validCommit), "ORG_STORAGE_AUTHORITY_INVARIANT");
    expect(await quotaBytes(ORG_A)).toBe(10n);
    expect((await reader.findObjectById(ORG_A, object.id))?.current_provider_key).toBe(
      object.current_provider_key,
    );
    expect((await reader.findOperationById(ORG_A, operation.id))?.state).toBe("provider_started");

    await dbWrite
      .update(orgStorageQuota)
      .set({ bytes_used: 11n })
      .where(eq(orgStorageQuota.organization_id, ORG_A));
    await dbWrite
      .update(orgStorageObjects)
      .set({ provider_version: "privileged-drift" })
      .where(
        and(eq(orgStorageObjects.organization_id, ORG_A), eq(orgStorageObjects.id, object.id)),
      );
    await expectErrorCode(writer.commitPut(validCommit), "ORG_STORAGE_AUTHORITY_INVARIANT");
    expect(await quotaBytes(ORG_A)).toBe(11n);
    expect((await reader.findObjectById(ORG_A, object.id))?.current_provider_key).toBe(
      object.current_provider_key,
    );
    expect((await reader.findOperationById(ORG_A, operation.id))?.state).toBe("provider_started");
  });

  test("rolls back an unstarted abort when its frozen source has drifted", async () => {
    const object = await registerPresent(ORG_A, "abort-source-drift", 5n);
    await seedQuota(ORG_A, 5n, 100n);
    const operation = prepared(
      await writer.prepareOperation(
        putInput(object, { idempotencyKey: "abort-source-drift", targetSizeBytes: 2n }),
      ),
    );
    const claimed = await claim(operation);
    const abortInput: AbortOperationInput = {
      ...fence(claimed),
      responseStatus: 409,
      receiptDigest: digest(80),
      errorCode: "CLIENT_ABORT",
      errorDigest: digest(81),
    };
    await dbWrite
      .update(orgStorageQuota)
      .set({ bytes_used: 2n })
      .where(eq(orgStorageQuota.organization_id, ORG_A));
    await expectErrorCode(
      writer.markProviderStarted({
        ...fence(claimed),
        nextAttemptAt: new Date(Date.now() + 5_000),
      }),
      "ORG_STORAGE_AUTHORITY_INVARIANT",
    );
    await expectErrorCode(writer.abortUnstarted(abortInput), "ORG_STORAGE_AUTHORITY_INVARIANT");
    expect(await quotaBytes(ORG_A)).toBe(2n);
    const afterQuotaDrift = await reader.findOperationById(ORG_A, operation.id);
    expect(afterQuotaDrift?.state).toBe("prepared");
    expect(afterQuotaDrift?.provider_write_started).toBe(false);

    await dbWrite
      .update(orgStorageQuota)
      .set({ bytes_used: 7n })
      .where(eq(orgStorageQuota.organization_id, ORG_A));
    await dbWrite
      .update(orgStorageObjects)
      .set({ provider_version: "privileged-abort-drift" })
      .where(eq(orgStorageObjects.id, object.id));

    await expectErrorCode(writer.abortUnstarted(abortInput), "ORG_STORAGE_AUTHORITY_INVARIANT");
    expect(await quotaBytes(ORG_A)).toBe(7n);
    expect((await reader.findOperationById(ORG_A, operation.id))?.state).toBe("prepared");
  });
});
