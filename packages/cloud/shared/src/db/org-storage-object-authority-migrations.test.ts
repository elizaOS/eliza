/**
 * Applies the real organization-storage authority migrations to isolated PGlite.
 * The suite proves Drizzle bigint mapping and fail-closed SQL invariants without repository mocks.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { type NewOrgStorageObject, orgStorageObjects } from "./schemas/org-storage-objects";
import {
  type NewOrgStorageOperation,
  type OrgStorageOperationState,
  orgStorageOperations,
} from "./schemas/org-storage-operations";

const ORG_A = "00000000-0000-4000-8000-00000000a001";
const ORG_B = "00000000-0000-4000-8000-00000000a002";
const ORG_WITH_AUTHORITY = "00000000-0000-4000-8000-00000000a003";
const BIG_OBJECT_ID = "00000000-0000-4000-8000-00000000b001";
const INVALID_OBJECT_ID = "00000000-0000-4000-8000-00000000b002";
const TERMINAL_OBJECT_ID = "00000000-0000-4000-8000-00000000b003";
const ABSENT_OBJECT_ID = "00000000-0000-4000-8000-00000000b004";
const TOMBSTONE_OBJECT_ID = "00000000-0000-4000-8000-00000000b005";
const CROSS_TENANT_OBJECT_ID = "00000000-0000-4000-8000-00000000b006";
const LEGACY_OBJECT_ID = "00000000-0000-4000-8000-00000000b007";
const CLAIM_GENERATION = "00000000-0000-4000-8000-00000000c001";
const EXACT_BIGINT = 9_007_199_254_740_993n;
const MIGRATION_TAGS = [
  "0236_org_storage_objects",
  "0237_org_storage_operations",
  "0238_org_storage_immutable_provider_keys",
] as const;
const MIGRATION_TAG_SET = new Set<string>(MIGRATION_TAGS);

const bareDigest = (character: string): string => character.repeat(64);
const prefixedDigest = (character: string): string => `sha256:${bareDigest(character)}`;
const providerKey = (organizationId: string, objectId: string, generation: bigint): string =>
  `__eliza_storage_authority/v1/org/${organizationId}/${objectId}/${generation}`;

let database: PGlite;
let migrationSql: Record<(typeof MIGRATION_TAGS)[number], string>;

function presentObject(
  id: string,
  options: Partial<NewOrgStorageObject> = {},
): NewOrgStorageObject {
  const organizationId = options.organization_id ?? ORG_A;
  const objectKey = options.object_key ?? `org/${organizationId}/objects/${id}`;
  const committedGeneration = options.committed_generation ?? 1n;
  return {
    id,
    organization_id: organizationId,
    storage_namespace: "attachment-r2-v1",
    object_key: objectKey,
    key_fingerprint: prefixedDigest("a"),
    presence: "present",
    last_allocated_generation: 1n,
    committed_generation: 1n,
    size_bytes: 5n,
    provider_version: "r2-version-1",
    provider_etag: "etag-1",
    current_provider_key: providerKey(organizationId, id, committedGeneration),
    content_type: "application/octet-stream",
    checksum_sha256: bareDigest("b"),
    provider_uploaded_at: new Date("2026-08-17T08:00:00.000Z"),
    ...options,
  };
}

function preparedPut(
  objectId: string,
  options: Partial<NewOrgStorageOperation> = {},
): NewOrgStorageOperation {
  const organizationId = options.organization_id ?? ORG_A;
  const operation = options.operation ?? "put";
  const sourcePresence = options.source_presence ?? "present";
  const sourceGeneration = options.source_generation ?? 1n;
  const targetGeneration = options.target_generation ?? 2n;
  const sourceSizeBytes = options.source_size_bytes ?? 5n;
  const targetSizeBytes = options.target_size_bytes ?? (operation === "put" ? 9n : 0n);
  return {
    organization_id: organizationId,
    object_id: objectId,
    operation,
    state: "prepared",
    idempotency_key_hash: prefixedDigest("c"),
    request_digest: prefixedDigest("d"),
    source_presence: sourcePresence,
    source_generation: sourceGeneration,
    target_generation: targetGeneration,
    source_size_bytes: sourceSizeBytes,
    target_size_bytes: targetSizeBytes,
    quota_delta_bytes: targetSizeBytes - sourceSizeBytes,
    quota_reserved_bytes: operation === "put" ? targetSizeBytes : 0n,
    quota_release_bytes: sourceSizeBytes,
    source_provider_version: sourcePresence === "present" ? "r2-version-1" : null,
    source_provider_etag: sourcePresence === "present" ? "etag-1" : null,
    source_provider_key:
      sourcePresence === "present" ? providerKey(organizationId, objectId, sourceGeneration) : null,
    target_content_type: operation === "put" ? "application/octet-stream" : null,
    target_content_sha256: operation === "put" ? bareDigest("e") : null,
    target_provider_key:
      operation === "put" ? providerKey(organizationId, objectId, targetGeneration) : null,
    ...options,
  };
}

interface ExecutableQuery {
  execute(): Promise<unknown>;
}

async function expectConstraintViolation(
  query: ExecutableQuery,
  constraintName?: string,
): Promise<void> {
  const execution = query.execute();
  if (constraintName) {
    let rejection: unknown;
    try {
      await execution;
    } catch (error) {
      rejection = error;
    }
    const cause = rejection instanceof Error ? rejection.cause : undefined;
    expect(String(cause)).toContain(constraintName);
    return;
  }
  await expect(execution).rejects.toThrow();
}

beforeAll(async () => {
  database = new PGlite();
  migrationSql = Object.fromEntries(
    MIGRATION_TAGS.map((tag) => [
      tag,
      readFileSync(join(import.meta.dir, `migrations/${tag}.sql`), "utf8"),
    ]),
  ) as Record<(typeof MIGRATION_TAGS)[number], string>;
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    INSERT INTO organizations (id) VALUES ('${ORG_A}'), ('${ORG_B}');
  `);
  for (const tag of MIGRATION_TAGS) {
    await database.exec(migrationSql[tag]);
  }
});

afterAll(async () => {
  await database.close();
});

describe("0236-0238 organization storage object authority", () => {
  test("registers bounded additive migrations that replay safely", async () => {
    const journal = JSON.parse(
      readFileSync(join(import.meta.dir, "migrations/meta/_journal.json"), "utf8"),
    ) as {
      entries: Array<{
        idx: number;
        version: string;
        when: number;
        tag: string;
        breakpoints: boolean;
      }>;
    };

    expect(journal.entries.filter(({ tag }) => MIGRATION_TAG_SET.has(tag))).toEqual([
      {
        idx: 235,
        version: "7",
        when: 1789502400000,
        tag: "0236_org_storage_objects",
        breakpoints: true,
      },
      {
        idx: 236,
        version: "7",
        when: 1789588800000,
        tag: "0237_org_storage_operations",
        breakpoints: true,
      },
      {
        idx: 237,
        version: "7",
        when: 1789675200000,
        tag: "0238_org_storage_immutable_provider_keys",
        breakpoints: true,
      },
    ]);
    for (const tag of MIGRATION_TAGS) {
      expect(migrationSql[tag].split(/\r?\n/).length).toBeLessThan(100);
      await database.exec(migrationSql[tag]);
    }

    const indexes = await database.query<{ indexdef: string; indexname: string }>(`
      SELECT indexdef, indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('org_storage_objects', 'org_storage_operations')
      ORDER BY indexname
    `);
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        "org_storage_objects_org_key_uidx",
        "org_storage_objects_org_presence_key_idx",
        "org_storage_objects_current_provider_key_uidx",
        "org_storage_operations_active_object_uidx",
        "org_storage_operations_due_idx",
        "org_storage_operations_generation_uidx",
        "org_storage_operations_idempotency_uidx",
        "org_storage_operations_org_state_idx",
        "org_storage_operations_source_provider_key_idx",
        "org_storage_operations_target_provider_key_uidx",
      ]),
    );
    expect(
      indexes.rows.find(
        ({ indexname }) => indexname === "org_storage_operations_target_provider_key_uidx",
      )?.indexdef,
    ).toContain("CREATE UNIQUE INDEX");
  });

  test("maps exact bigint authority and copy-on-write reservation through Drizzle", async () => {
    const client = drizzle(database, { schema: { orgStorageObjects, orgStorageOperations } });
    const [object] = await client
      .insert(orgStorageObjects)
      .values(
        presentObject(BIG_OBJECT_ID, {
          last_allocated_generation: 2n,
          committed_generation: 1n,
          size_bytes: EXACT_BIGINT,
        }),
      )
      .returning();
    const [operation] = await client
      .insert(orgStorageOperations)
      .values(
        preparedPut(BIG_OBJECT_ID, {
          idempotency_key_hash: prefixedDigest("f"),
          source_size_bytes: EXACT_BIGINT,
          target_size_bytes: EXACT_BIGINT + 10n,
          quota_delta_bytes: 10n,
          claim_owner: "storage-route-a",
          claim_generation: CLAIM_GENERATION,
          lease_expires_at: new Date("2026-08-17T08:05:00.000Z"),
        }),
      )
      .returning();

    expect(object).toMatchObject({
      size_bytes: EXACT_BIGINT,
      last_allocated_generation: 2n,
      committed_generation: 1n,
      current_provider_key: providerKey(ORG_A, BIG_OBJECT_ID, 1n),
    });
    expect(operation).toMatchObject({
      source_size_bytes: EXACT_BIGINT,
      target_size_bytes: EXACT_BIGINT + 10n,
      quota_delta_bytes: 10n,
      quota_reserved_bytes: EXACT_BIGINT + 10n,
      quota_release_bytes: EXACT_BIGINT,
      source_provider_key: providerKey(ORG_A, BIG_OBJECT_ID, 1n),
      target_provider_key: providerKey(ORG_A, BIG_OBJECT_ID, 2n),
      state: "prepared",
    });
  });

  test("accepts exact terminal receipts, tombstones, and unstarted aborts", async () => {
    const client = drizzle(database, { schema: { orgStorageObjects, orgStorageOperations } });
    await client.insert(orgStorageObjects).values([
      {
        id: TERMINAL_OBJECT_ID,
        organization_id: ORG_A,
        storage_namespace: "attachment-r2-v1",
        object_key: `org/${ORG_A}/objects/${TERMINAL_OBJECT_ID}`,
        key_fingerprint: prefixedDigest("0"),
        presence: "absent",
        last_allocated_generation: 4n,
        committed_generation: 2n,
        size_bytes: 0n,
      },
      {
        id: ABSENT_OBJECT_ID,
        organization_id: ORG_A,
        storage_namespace: "attachment-r2-v1",
        object_key: `org/${ORG_A}/objects/never-written`,
        key_fingerprint: prefixedDigest("1"),
        presence: "absent",
        last_allocated_generation: 0n,
        committed_generation: 0n,
        size_bytes: 0n,
      },
      {
        id: TOMBSTONE_OBJECT_ID,
        organization_id: ORG_A,
        storage_namespace: "attachment-r2-v1",
        object_key: `org/${ORG_A}/objects/deleted`,
        key_fingerprint: prefixedDigest("2"),
        presence: "absent",
        last_allocated_generation: 3n,
        committed_generation: 3n,
        size_bytes: 0n,
      },
    ]);

    const completedAt = new Date("2026-08-17T08:10:00.000Z");
    const providerStartedAt = new Date("2026-08-17T08:09:00.000Z");
    await client.insert(orgStorageOperations).values([
      preparedPut(TERMINAL_OBJECT_ID, {
        idempotency_key_hash: prefixedDigest("3"),
        request_digest: prefixedDigest("4"),
        source_presence: "absent",
        source_generation: 0n,
        target_generation: 1n,
        source_size_bytes: 0n,
        source_provider_version: null,
        source_provider_etag: null,
        target_size_bytes: 5n,
        quota_delta_bytes: 5n,
        quota_reserved_bytes: 5n,
        state: "committed",
        provider_write_started: true,
        provider_started_at: providerStartedAt,
        result_provider_version: "r2-version-1",
        result_provider_etag: "etag-1",
        result_size_bytes: 5n,
        result_checksum_sha256: bareDigest("e"),
        result_uploaded_at: completedAt,
        response_status: 201,
        receipt_digest: bareDigest("5"),
        completed_at: completedAt,
      }),
      {
        ...preparedPut(TERMINAL_OBJECT_ID),
        operation: "delete",
        state: "committed",
        idempotency_key_hash: prefixedDigest("6"),
        request_digest: prefixedDigest("7"),
        source_generation: 1n,
        target_generation: 2n,
        source_size_bytes: 5n,
        target_size_bytes: 0n,
        quota_delta_bytes: -5n,
        quota_reserved_bytes: 0n,
        quota_release_bytes: 5n,
        target_content_type: null,
        target_content_sha256: null,
        target_provider_key: null,
        provider_write_started: true,
        provider_started_at: providerStartedAt,
        last_observed_at: completedAt,
        response_status: 204,
        receipt_digest: bareDigest("8"),
        completed_at: completedAt,
      },
      preparedPut(TERMINAL_OBJECT_ID, {
        state: "aborted",
        idempotency_key_hash: prefixedDigest("9"),
        request_digest: prefixedDigest("a"),
        source_presence: "absent",
        source_generation: 2n,
        target_generation: 3n,
        source_size_bytes: 0n,
        source_provider_version: null,
        source_provider_etag: null,
        target_size_bytes: 7n,
        quota_delta_bytes: 7n,
        quota_reserved_bytes: 7n,
        response_status: 409,
        receipt_digest: bareDigest("b"),
        last_error_code: "OBJECT_BUSY",
        last_error_digest: bareDigest("c"),
        completed_at: completedAt,
      }),
      preparedPut(TERMINAL_OBJECT_ID, {
        state: "quarantined",
        idempotency_key_hash: prefixedDigest("0"),
        request_digest: prefixedDigest("1"),
        source_presence: "absent",
        source_generation: 2n,
        target_generation: 4n,
        source_size_bytes: 0n,
        source_provider_version: null,
        source_provider_etag: null,
        target_size_bytes: 7n,
        quota_delta_bytes: 7n,
        quota_reserved_bytes: 7n,
        provider_write_started: true,
        provider_started_at: providerStartedAt,
        last_observed_at: completedAt,
        last_error_code: "R2_GENERATION_MISMATCH",
        last_error_digest: bareDigest("2"),
      }),
    ]);

    const states = await client
      .select({ state: orgStorageOperations.state })
      .from(orgStorageOperations)
      .where(eq(orgStorageOperations.object_id, TERMINAL_OBJECT_ID));
    expect(states.map(({ state }) => state).sort()).toEqual([
      "aborted",
      "committed",
      "committed",
      "quarantined",
    ]);
    const providerTargets = await client
      .select({
        generation: orgStorageOperations.target_generation,
        state: orgStorageOperations.state,
        targetProviderKey: orgStorageOperations.target_provider_key,
      })
      .from(orgStorageOperations)
      .where(eq(orgStorageOperations.object_id, TERMINAL_OBJECT_ID));
    const physicalTargets = providerTargets.filter(
      (
        row,
      ): row is {
        generation: bigint;
        state: OrgStorageOperationState;
        targetProviderKey: string;
      } => row.targetProviderKey !== null,
    );
    expect(new Set(physicalTargets.map(({ targetProviderKey }) => targetProviderKey)).size).toBe(
      physicalTargets.length,
    );
    for (const { generation, targetProviderKey } of physicalTargets) {
      expect(targetProviderKey).toBe(providerKey(ORG_A, TERMINAL_OBJECT_ID, generation));
    }
    expect(
      physicalTargets
        .filter(({ state }) => state === "aborted")
        .map(({ targetProviderKey }) => targetProviderKey)
        .sort(),
    ).toEqual([providerKey(ORG_A, TERMINAL_OBJECT_ID, 3n)]);
    const [tombstone] = await client
      .select({ currentProviderKey: orgStorageObjects.current_provider_key })
      .from(orgStorageObjects)
      .where(eq(orgStorageObjects.id, TOMBSTONE_OBJECT_ID));
    expect(tombstone?.currentProviderKey).toBeNull();
    await expectConstraintViolation(
      client.insert(orgStorageOperations).values(
        preparedPut(TERMINAL_OBJECT_ID, {
          idempotency_key_hash: prefixedDigest("4"),
          request_digest: prefixedDigest("5"),
          source_generation: 2n,
          target_generation: 5n,
        }),
      ),
    );
  });

  test("accepts canonical generation keys and the explicit generation-one legacy bridge", async () => {
    const client = drizzle(database, { schema: { orgStorageObjects, orgStorageOperations } });
    const logicalKey = `org/${ORG_A}/legacy/${LEGACY_OBJECT_ID}`;
    const [legacyObject] = await client
      .insert(orgStorageObjects)
      .values(
        presentObject(LEGACY_OBJECT_ID, {
          object_key: logicalKey,
          current_provider_key: logicalKey,
          last_allocated_generation: 2n,
        }),
      )
      .returning();
    const [operation] = await client
      .insert(orgStorageOperations)
      .values(
        preparedPut(LEGACY_OBJECT_ID, {
          idempotency_key_hash: prefixedDigest("2"),
          request_digest: prefixedDigest("3"),
          source_provider_key: logicalKey,
        }),
      )
      .returning();

    expect(legacyObject.current_provider_key).toBe(logicalKey);
    expect(operation.source_provider_key).toBe(logicalKey);
    expect(operation.target_provider_key).toBe(providerKey(ORG_A, LEGACY_OBJECT_ID, 2n));
    expect(operation.source_provider_key).not.toBe(operation.target_provider_key);
  });

  test("retains an organization while durable object authority still exists", async () => {
    const client = drizzle(database, { schema: { orgStorageObjects, orgStorageOperations } });
    const objectId = "00000000-0000-4000-8000-00000000b008";
    await database.exec(`INSERT INTO organizations (id) VALUES ('${ORG_WITH_AUTHORITY}')`);
    await client.insert(orgStorageObjects).values({
      id: objectId,
      organization_id: ORG_WITH_AUTHORITY,
      storage_namespace: "attachment-r2-v1",
      object_key: `org/${ORG_WITH_AUTHORITY}/objects/${objectId}`,
      key_fingerprint: prefixedDigest("9"),
      presence: "absent",
      last_allocated_generation: 0n,
      committed_generation: 0n,
      size_bytes: 0n,
      current_provider_key: null,
    });

    await expect(
      database.exec(`DELETE FROM organizations WHERE id = '${ORG_WITH_AUTHORITY}'`),
    ).rejects.toThrow();
    const retained = await database.query<{ id: string }>(
      `SELECT id FROM organizations WHERE id = '${ORG_WITH_AUTHORITY}'`,
    );
    expect(retained.rows).toEqual([{ id: ORG_WITH_AUTHORITY }]);
  });

  test("rejects tenant/key/generation drift including overlong UTF-8 keys", async () => {
    const client = drizzle(database, { schema: { orgStorageObjects, orgStorageOperations } });
    await expectConstraintViolation(
      client.insert(orgStorageObjects).values(
        presentObject("00000000-0000-4000-8000-00000000d001", {
          object_key: `org/${ORG_B}/foreign-prefix`,
        }),
      ),
    );
    await expectConstraintViolation(
      client.insert(orgStorageObjects).values(
        presentObject("00000000-0000-4000-8000-00000000d002", {
          object_key: `org/${ORG_A}/${"é".repeat(600)}`,
        }),
      ),
    );
    await expectConstraintViolation(
      client.insert(orgStorageObjects).values(
        presentObject("00000000-0000-4000-8000-00000000d003", {
          object_key: `org/${ORG_A}/objects/cafe\u0301`,
        }),
      ),
    );
    await expectConstraintViolation(
      client.insert(orgStorageObjects).values(
        presentObject("00000000-0000-4000-8000-00000000d006", {
          object_key: `org/${ORG_A}/unsafe\nkey`,
        }),
      ),
    );
    await expectConstraintViolation(
      client.insert(orgStorageObjects).values(
        presentObject("00000000-0000-4000-8000-00000000d009", {
          object_key: `org/${ORG_A}/unsafe\u0085key`,
        }),
      ),
    );
    const legacyGenerationTwoId = "00000000-0000-4000-8000-00000000d007";
    const legacyGenerationTwoKey = `org/${ORG_A}/legacy/${legacyGenerationTwoId}`;
    await expectConstraintViolation(
      client.insert(orgStorageObjects).values(
        presentObject(legacyGenerationTwoId, {
          object_key: legacyGenerationTwoKey,
          current_provider_key: legacyGenerationTwoKey,
          committed_generation: 2n,
          last_allocated_generation: 2n,
        }),
      ),
    );
    const absentWithKeyId = "00000000-0000-4000-8000-00000000d008";
    await expectConstraintViolation(
      client.insert(orgStorageObjects).values({
        id: absentWithKeyId,
        organization_id: ORG_A,
        storage_namespace: "attachment-r2-v1",
        object_key: `org/${ORG_A}/objects/${absentWithKeyId}`,
        key_fingerprint: prefixedDigest("8"),
        presence: "absent",
        last_allocated_generation: 1n,
        committed_generation: 1n,
        size_bytes: 0n,
        current_provider_key: providerKey(ORG_A, absentWithKeyId, 1n),
      }),
    );
    await expectConstraintViolation(
      client.insert(orgStorageObjects).values(
        presentObject("00000000-0000-4000-8000-00000000d004", {
          committed_generation: 0n,
        }),
      ),
    );
    await expectConstraintViolation(
      client.insert(orgStorageObjects).values(
        presentObject("00000000-0000-4000-8000-00000000d005", {
          provider_version: null,
        }),
      ),
    );

    await client.insert(orgStorageObjects).values(
      presentObject(CROSS_TENANT_OBJECT_ID, {
        last_allocated_generation: 2n,
      }),
    );
    await expectConstraintViolation(
      client.insert(orgStorageOperations).values(
        preparedPut(CROSS_TENANT_OBJECT_ID, {
          organization_id: ORG_B,
          idempotency_key_hash: prefixedDigest("6"),
          request_digest: prefixedDigest("7"),
        }),
      ),
    );
  });

  test("rejects NULL-tristate bypasses and malformed operation accounting", async () => {
    const client = drizzle(database, { schema: { orgStorageObjects, orgStorageOperations } });
    await client.insert(orgStorageObjects).values(
      presentObject(INVALID_OBJECT_ID, {
        last_allocated_generation: 2n,
      }),
    );

    await expectConstraintViolation(
      client
        .insert(orgStorageOperations)
        .values(preparedPut(INVALID_OBJECT_ID, { request_digest: bareDigest("d") })),
    );
    await expectConstraintViolation(
      client
        .insert(orgStorageOperations)
        .values(preparedPut(INVALID_OBJECT_ID, { claim_owner: "worker-a" })),
    );
    await expectConstraintViolation(
      client
        .insert(orgStorageOperations)
        .values(preparedPut(INVALID_OBJECT_ID, { last_error_code: "R2_TIMEOUT" })),
    );
    await expectConstraintViolation(
      client
        .insert(orgStorageOperations)
        .values(preparedPut(INVALID_OBJECT_ID, { quota_reserved_bytes: 3n })),
    );
    await expectConstraintViolation(
      client
        .insert(orgStorageOperations)
        .values(preparedPut(INVALID_OBJECT_ID, { quota_release_bytes: 0n })),
    );
    await expectConstraintViolation(
      client
        .insert(orgStorageOperations)
        .values(preparedPut(INVALID_OBJECT_ID, { source_provider_key: null })),
    );
    await expectConstraintViolation(
      client.insert(orgStorageOperations).values(
        preparedPut(INVALID_OBJECT_ID, {
          target_provider_key: `org/${ORG_A}/objects/${INVALID_OBJECT_ID}`,
        }),
      ),
    );
    await expectConstraintViolation(
      client.insert(orgStorageOperations).values(
        preparedPut(INVALID_OBJECT_ID, {
          source_provider_key: providerKey(ORG_A, INVALID_OBJECT_ID, 2n),
        }),
      ),
    );
    await expectConstraintViolation(
      client.insert(orgStorageOperations).values(
        preparedPut(INVALID_OBJECT_ID, {
          source_generation: 0n,
          target_generation: 1n,
        }),
      ),
      "org_storage_operations_source_shape_check",
    );
    await expectConstraintViolation(
      client.insert(orgStorageOperations).values(
        preparedPut(INVALID_OBJECT_ID, {
          operation: "delete",
          target_provider_key: providerKey(ORG_A, INVALID_OBJECT_ID, 2n),
        }),
      ),
    );
    await expectConstraintViolation(
      client.insert(orgStorageOperations).values(
        preparedPut(INVALID_OBJECT_ID, {
          state: "provider_started",
          provider_write_started: false,
          provider_started_at: null,
        }),
      ),
    );

    const beforeProviderStartedAt = new Date("2026-08-17T08:18:00.000Z");
    const providerStartedAt = new Date("2026-08-17T08:19:00.000Z");
    const completedAt = new Date("2026-08-17T08:20:00.000Z");
    await expectConstraintViolation(
      client.insert(orgStorageOperations).values(
        preparedPut(INVALID_OBJECT_ID, {
          state: "aborted",
          provider_write_started: true,
          provider_started_at: providerStartedAt,
          response_status: 412,
          receipt_digest: bareDigest("a"),
          last_error_code: "PROVIDER_PRECONDITION_FAILED",
          last_error_digest: bareDigest("b"),
          completed_at: completedAt,
        }),
      ),
      "org_storage_operations_provider_state_check",
    );
    await expectConstraintViolation(
      client.insert(orgStorageOperations).values(
        preparedPut(INVALID_OBJECT_ID, {
          state: "provider_started",
          provider_write_started: true,
          provider_started_at: providerStartedAt,
          last_observed_at: beforeProviderStartedAt,
        }),
      ),
      "org_storage_operations_observation_shape_check",
    );
    await expectConstraintViolation(
      client.insert(orgStorageOperations).values(
        preparedPut(INVALID_OBJECT_ID, {
          state: "committed",
          provider_write_started: true,
          provider_started_at: providerStartedAt,
          last_observed_at: completedAt,
          response_status: 201,
          receipt_digest: bareDigest("f"),
          completed_at: completedAt,
          result_provider_version: "r2-version-1",
          result_provider_etag: "etag-2",
          result_size_bytes: 9n,
          result_checksum_sha256: bareDigest("e"),
          result_uploaded_at: completedAt,
        }),
      ),
      "org_storage_operations_result_shape_check",
    );
    await expectConstraintViolation(
      client.insert(orgStorageOperations).values(
        preparedPut(INVALID_OBJECT_ID, {
          state: "committed",
          provider_write_started: true,
          provider_started_at: providerStartedAt,
          response_status: 201,
          receipt_digest: bareDigest("c"),
          completed_at: completedAt,
          result_provider_version: "r2-version-2",
          result_provider_etag: "etag-2",
          result_size_bytes: 9n,
          result_checksum_sha256: bareDigest("e"),
          result_uploaded_at: completedAt,
        }),
      ),
      "org_storage_operations_observation_shape_check",
    );
    await expectConstraintViolation(
      client.insert(orgStorageOperations).values(
        preparedPut(INVALID_OBJECT_ID, {
          state: "quarantined",
          provider_write_started: true,
          provider_started_at: providerStartedAt,
          last_error_code: "R2_GENERATION_MISMATCH",
          last_error_digest: bareDigest("d"),
        }),
      ),
      "org_storage_operations_observation_shape_check",
    );
    await expectConstraintViolation(
      client.insert(orgStorageOperations).values(
        preparedPut(INVALID_OBJECT_ID, {
          state: "committed",
          response_status: 201,
          receipt_digest: bareDigest("a"),
          completed_at: completedAt,
          result_provider_version: "r2-version-2",
          result_provider_etag: "etag-2",
          result_size_bytes: 9n,
          result_checksum_sha256: bareDigest("e"),
          result_uploaded_at: completedAt,
        }),
      ),
    );
    await expectConstraintViolation(
      client.insert(orgStorageOperations).values(
        preparedPut(INVALID_OBJECT_ID, {
          state: "committed",
          provider_write_started: true,
          provider_started_at: completedAt,
          response_status: 201,
          receipt_digest: bareDigest("a"),
          completed_at: completedAt,
          result_provider_version: null,
          result_provider_etag: null,
          result_size_bytes: null,
          result_checksum_sha256: null,
          result_uploaded_at: null,
        }),
      ),
    );
    await expectConstraintViolation(
      client.insert(orgStorageOperations).values(
        preparedPut(INVALID_OBJECT_ID, {
          state: "quarantined",
          provider_write_started: true,
          provider_started_at: completedAt,
          last_error_code: "R2_GENERATION_MISMATCH",
          last_error_digest: null,
        }),
      ),
    );
  });
});
