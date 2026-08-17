/**
 * Applies the real native-storage HEAD receipt migrations to isolated PGlite.
 * The suite proves terminal response shapes, privacy boundaries, and deletion semantics end to end.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pushSchema } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  type NewOrgStorageHeadReceipt,
  type OrgStorageHeadHeaderPolicyVersion,
  orgStorageHeadReceipts,
} from "./schemas/org-storage-head-receipts";

const ORG_A = "00000000-0000-4000-8000-00000000a001";
const ORG_B = "00000000-0000-4000-8000-00000000a002";
const CREATED_AT = new Date("2026-08-17T10:00:00.000Z");
const LAST_MODIFIED = new Date("2026-08-17T09:00:37.000Z");
const REPLAY_EXPIRES_AT = new Date("2026-08-17T11:00:00.000Z");
const PURGE_AFTER = new Date("2026-08-18T11:00:00.000Z");
const NEW_MIGRATION_TAGS = [
  "0239_org_storage_head_receipts",
  "0240_org_storage_head_receipt_response_shapes",
] as const;
const ALL_MIGRATION_TAGS = [
  "0236_org_storage_objects",
  "0237_org_storage_operations",
  "0238_org_storage_immutable_provider_keys",
  ...NEW_MIGRATION_TAGS,
] as const;
const NEW_MIGRATION_TAG_SET = new Set<string>(NEW_MIGRATION_TAGS);

const bareDigest = (sequence: number): string => sequence.toString(16).padStart(64, "0");
const prefixedDigest = (sequence: number): string => `sha256:${bareDigest(sequence)}`;
const uuid = (sequence: number): string =>
  `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;

let database: PGlite;
let receiptSequence = 1;
let migrationSql: Record<(typeof ALL_MIGRATION_TAGS)[number], string>;

function nextSequence(): number {
  receiptSequence += 1;
  return receiptSequence;
}

function notFoundReceipt(
  sequence: number,
  overrides: Partial<NewOrgStorageHeadReceipt> = {},
): NewOrgStorageHeadReceipt {
  return {
    id: uuid(sequence),
    organization_id: ORG_A,
    idempotency_key_hash: prefixedDigest(sequence),
    request_digest: prefixedDigest(sequence + 1_000),
    charge_amount_usd: "0.000000",
    response_kind: "not_found",
    response_status: 404,
    receipt_digest: bareDigest(sequence + 2_000),
    replay_expires_at: REPLAY_EXPIRES_AT,
    purge_after: PURGE_AFTER,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function okReceipt(
  sequence: number,
  overrides: Partial<NewOrgStorageHeadReceipt> = {},
): NewOrgStorageHeadReceipt {
  return {
    ...notFoundReceipt(sequence),
    response_kind: "ok",
    response_status: 200,
    object_id: uuid(sequence + 10_000),
    object_generation: 7n,
    response_content_length: 42n,
    response_content_type: "application/octet-stream",
    response_etag: `etag-${sequence}`,
    response_last_modified: LAST_MODIFIED,
    response_force_attachment: true,
    ...overrides,
  };
}

function validatorReceipt(
  sequence: number,
  kind: "not_modified" | "precondition_failed",
  overrides: Partial<NewOrgStorageHeadReceipt> = {},
): NewOrgStorageHeadReceipt {
  return {
    ...notFoundReceipt(sequence),
    response_kind: kind,
    response_status: kind === "not_modified" ? 304 : 412,
    object_id: uuid(sequence + 10_000),
    object_generation: 7n,
    response_etag: `etag-${sequence}`,
    response_last_modified: LAST_MODIFIED,
    ...overrides,
  };
}

async function insertReceipt(receipt: NewOrgStorageHeadReceipt): Promise<void> {
  const client = drizzle(database, { schema: { orgStorageHeadReceipts } });
  await client.insert(orgStorageHeadReceipts).values(receipt);
}

async function expectViolation(
  operation: () => Promise<unknown>,
  constraintName?: string,
): Promise<void> {
  let rejection: unknown;
  try {
    await operation();
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeDefined();
  if (constraintName) {
    const error = rejection instanceof Error ? rejection : undefined;
    expect(`${String(error)} ${String(error?.cause)}`).toContain(constraintName);
  }
}

async function seedLedger(
  id: string,
  organizationId: string,
  receiptId: string,
  amount = "-0.000050",
): Promise<void> {
  await database.query(
    `INSERT INTO credit_transactions
      (id, organization_id, amount, type, description, metadata)
     VALUES ($1, $2, $3::numeric, 'debit', 'API proxy: storage — head',
      jsonb_build_object('type', 'native_storage_head', 'receipt_id', $4::text, 'version', 1))`,
    [id, organizationId, amount, receiptId],
  );
}

beforeAll(async () => {
  database = new PGlite();
  migrationSql = Object.fromEntries(
    ALL_MIGRATION_TAGS.map((tag) => [
      tag,
      readFileSync(join(import.meta.dir, `migrations/${tag}.sql`), "utf8"),
    ]),
  ) as Record<(typeof ALL_MIGRATION_TAGS)[number], string>;
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY);
    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      amount numeric(12, 6) NOT NULL,
      type text NOT NULL,
      description text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      stripe_payment_intent_id text
    );
    INSERT INTO organizations (id) VALUES ('${ORG_A}'), ('${ORG_B}');
  `);
  for (const tag of ALL_MIGRATION_TAGS) {
    await database.exec(migrationSql[tag]);
  }
});

afterAll(async () => {
  await database.close();
});

describe("0239-0240 native storage HEAD receipt authority", () => {
  test("registers terminal replay receipt migrations and the intended indexes", async () => {
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

    expect(journal.entries.filter(({ tag }) => NEW_MIGRATION_TAG_SET.has(tag))).toEqual([
      {
        idx: 238,
        version: "7",
        when: 1789761600000,
        tag: "0239_org_storage_head_receipts",
        breakpoints: true,
      },
      {
        idx: 239,
        version: "7",
        when: 1789848000000,
        tag: "0240_org_storage_head_receipt_response_shapes",
        breakpoints: true,
      },
    ]);
    for (const tag of NEW_MIGRATION_TAGS) {
      expect(migrationSql[tag].split(/\r?\n/).length).toBeLessThan(100);
      await database.exec(migrationSql[tag]);
    }
    expect(migrationSql["0239_org_storage_head_receipts"]).toContain(
      '"charge_amount_usd" <= 999999.999999',
    );

    const indexes = await database.query<{ indexdef: string; indexname: string }>(`
      SELECT indexdef, indexname FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'org_storage_head_receipts'
      ORDER BY indexname
    `);
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        "org_storage_head_receipts_credit_transaction_uidx",
        "org_storage_head_receipts_idempotency_uidx",
        "org_storage_head_receipts_org_object_generation_idx",
        "org_storage_head_receipts_purge_idx",
      ]),
    );
    const indexDefinition = (name: string): string =>
      indexes.rows.find(({ indexname }) => indexname === name)?.indexdef ?? "";
    expect(indexDefinition("org_storage_head_receipts_idempotency_uidx")).toContain("UNIQUE INDEX");
    expect(indexDefinition("org_storage_head_receipts_idempotency_uidx")).toContain(
      "(organization_id, idempotency_key_hash)",
    );
    expect(indexDefinition("org_storage_head_receipts_credit_transaction_uidx")).toContain(
      "UNIQUE INDEX",
    );
    expect(indexDefinition("org_storage_head_receipts_credit_transaction_uidx")).toContain(
      "WHERE (credit_transaction_id IS NOT NULL)",
    );
    expect(indexDefinition("org_storage_head_receipts_purge_idx")).toContain("(purge_after, id)");
    expect(indexDefinition("org_storage_head_receipts_org_object_generation_idx")).toContain(
      "(organization_id, object_id, object_generation)",
    );
    expect(indexDefinition("org_storage_head_receipts_org_object_generation_idx")).toContain(
      "WHERE (object_id IS NOT NULL)",
    );

    const constraints = await database.query<{ conname: string; definition: string }>(`
      SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = 'org_storage_head_receipts'::regclass
      ORDER BY conname
    `);
    expect(constraints.rows.map(({ conname }) => conname)).toEqual(
      expect.arrayContaining([
        "org_storage_head_receipts_charge_shape_check",
        "org_storage_head_receipts_credit_transaction_id_fkey",
        "org_storage_head_receipts_identity_check",
        "org_storage_head_receipts_organization_id_fkey",
        "org_storage_head_receipts_response_shape_check",
        "org_storage_head_receipts_response_value_check",
        "org_storage_head_receipts_retention_check",
      ]),
    );
    const constraintDefinition = (name: string): string =>
      constraints.rows.find(({ conname }) => conname === name)?.definition ?? "";
    expect(constraintDefinition("org_storage_head_receipts_organization_id_fkey")).toContain(
      "ON DELETE CASCADE",
    );
    expect(constraintDefinition("org_storage_head_receipts_credit_transaction_id_fkey")).toContain(
      "REFERENCES credit_transactions(id)",
    );
    expect(constraintDefinition("org_storage_head_receipts_identity_check")).toContain(
      "receipt_digest",
    );
    expect(constraintDefinition("org_storage_head_receipts_charge_shape_check")).toContain(
      "999999.999999",
    );
    expect(constraintDefinition("org_storage_head_receipts_response_value_check")).toContain(
      "9007199254740991",
    );
    expect(constraintDefinition("org_storage_head_receipts_response_value_check")).toContain(
      "date_trunc('second'::text",
    );
    expect(constraintDefinition("org_storage_head_receipts_response_value_check")).toContain(
      'COLLATE "C"',
    );
    expect(constraintDefinition("org_storage_head_receipts_response_shape_check")).toContain(
      "response_kind = 'not_modified'::text",
    );
    expect(constraintDefinition("org_storage_head_receipts_response_shape_check")).toContain(
      "response_status = 412",
    );
    expect(constraintDefinition("org_storage_head_receipts_retention_check")).toContain(
      "isfinite(replay_expires_at)",
    );

    const triggers = await database.query<{ action_statement: string; trigger_name: string }>(`
      SELECT trigger_name, action_statement
      FROM information_schema.triggers
      WHERE event_object_schema = 'public'
        AND event_object_table = 'org_storage_head_receipts'
      ORDER BY trigger_name
    `);
    expect(triggers.rows).toEqual([
      {
        trigger_name: "org_storage_head_receipts_immutable_trigger",
        action_statement: "EXECUTE FUNCTION reject_org_storage_head_receipt_update()",
      },
    ]);
  });

  test("contains no raw identity/provider/header columns and has no catalog-object FK", async () => {
    const columns = await database.query<{ column_name: string }>(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'org_storage_head_receipts'
      ORDER BY column_name
    `);
    const columnNames = columns.rows.map(({ column_name }) => column_name);
    expect(columnNames).toEqual([
      "authority_version",
      "charge_amount_usd",
      "created_at",
      "credit_transaction_id",
      "header_policy_version",
      "id",
      "idempotency_key_hash",
      "object_generation",
      "object_id",
      "operation",
      "organization_id",
      "purge_after",
      "receipt_digest",
      "replay_expires_at",
      "request_digest",
      "response_content_length",
      "response_content_type",
      "response_etag",
      "response_force_attachment",
      "response_kind",
      "response_last_modified",
      "response_status",
      "storage_namespace",
    ]);

    const referencedTables = await database.query<{ referenced_table: string }>(`
      SELECT confrelid::regclass::text AS referenced_table
      FROM pg_constraint
      WHERE conrelid = 'org_storage_head_receipts'::regclass AND contype = 'f'
      ORDER BY referenced_table
    `);
    expect(referencedTables.rows.map(({ referenced_table }) => referenced_table)).toEqual([
      "credit_transactions",
      "organizations",
    ]);
    expect(migrationSql["0239_org_storage_head_receipts"]).not.toContain(
      'ALTER TABLE "credit_transactions"',
    );
  });

  test("keeps the Drizzle declaration aligned with the migrated table", async () => {
    const { hasDataLoss, statementsToExecute, warnings } = await pushSchema(
      { orgStorageHeadReceipts },
      drizzle(database),
      undefined,
      ["org_storage_head_receipts"],
    );
    expect({ hasDataLoss, statementsToExecute, warnings }).toEqual({
      hasDataLoss: false,
      statementsToExecute: [],
      warnings: [],
    });
  });

  test("maps every terminal response shape and exact values through Drizzle", async () => {
    const client = drizzle(database, { schema: { orgStorageHeadReceipts } });
    const okSequence = nextSequence();
    const notModifiedSequence = nextSequence();
    const notFoundSequence = nextSequence();
    const preconditionSequence = nextSequence();
    await client
      .insert(orgStorageHeadReceipts)
      .values([
        okReceipt(okSequence),
        validatorReceipt(notModifiedSequence, "not_modified"),
        notFoundReceipt(notFoundSequence),
        validatorReceipt(preconditionSequence, "precondition_failed"),
      ]);

    const [stored] = await client
      .select()
      .from(orgStorageHeadReceipts)
      .where(eq(orgStorageHeadReceipts.id, uuid(okSequence)));
    const headerPolicy: OrgStorageHeadHeaderPolicyVersion | undefined =
      stored?.header_policy_version;
    expect(stored).toMatchObject({
      authority_version: 1,
      storage_namespace: "attachment-r2-v1",
      operation: "head",
      charge_amount_usd: "0.000000",
      response_kind: "ok",
      response_status: 200,
      object_generation: 7n,
      response_content_length: 42n,
      response_content_type: "application/octet-stream",
      response_etag: `etag-${okSequence}`,
      response_force_attachment: true,
    });
    expect(headerPolicy).toBe(1);
    expect(stored?.response_last_modified?.getTime()).toBe(LAST_MODIFIED.getTime());

    const kinds = await client
      .select({ kind: orgStorageHeadReceipts.response_kind })
      .from(orgStorageHeadReceipts)
      .where(eq(orgStorageHeadReceipts.request_digest, prefixedDigest(notFoundSequence + 1_000)));
    expect(kinds).toEqual([{ kind: "not_found" }]);
  });

  test("enforces tenant-scoped idempotency while allowing the same hash across tenants", async () => {
    const sequence = nextSequence();
    const sharedHash = prefixedDigest(sequence);
    await insertReceipt(notFoundReceipt(sequence, { idempotency_key_hash: sharedHash }));
    await insertReceipt(
      notFoundReceipt(nextSequence(), {
        organization_id: ORG_B,
        idempotency_key_hash: sharedHash,
      }),
    );
    await expectViolation(
      () =>
        insertReceipt(
          notFoundReceipt(nextSequence(), {
            organization_id: ORG_A,
            idempotency_key_hash: sharedHash,
          }),
        ),
      "org_storage_head_receipts_idempotency_uidx",
    );
  });

  test("rejects every update and preserves the original idempotency fence", async () => {
    const sequence = nextSequence();
    const originalHash = prefixedDigest(sequence);
    const replacementHash = prefixedDigest(sequence + 50_000);
    await insertReceipt(notFoundReceipt(sequence, { idempotency_key_hash: originalHash }));

    await expectViolation(
      () =>
        database.query(
          `UPDATE org_storage_head_receipts
           SET idempotency_key_hash = $1
           WHERE id = $2`,
          [replacementHash, uuid(sequence)],
        ),
      "org_storage_head_receipts_immutable",
    );

    const stored = await database.query<{ idempotency_key_hash: string }>(
      "SELECT idempotency_key_hash FROM org_storage_head_receipts WHERE id = $1",
      [uuid(sequence)],
    );
    expect(stored.rows).toEqual([{ idempotency_key_hash: originalHash }]);
    await expectViolation(
      () =>
        insertReceipt(
          notFoundReceipt(nextSequence(), {
            organization_id: ORG_A,
            idempotency_key_hash: originalHash,
          }),
        ),
      "org_storage_head_receipts_idempotency_uidx",
    );
  });

  test("links positive prices once and stores zero prices without a ledger row", async () => {
    const zeroSequence = nextSequence();
    await insertReceipt(notFoundReceipt(zeroSequence));

    const positiveSequence = nextSequence();
    const positiveReceiptId = uuid(positiveSequence);
    const ledgerId = uuid(positiveSequence + 20_000);
    await seedLedger(ledgerId, ORG_A, positiveReceiptId);
    await insertReceipt(
      okReceipt(positiveSequence, {
        charge_amount_usd: "0.000050",
        credit_transaction_id: ledgerId,
      }),
    );

    const maxSequence = nextSequence();
    const maxReceiptId = uuid(maxSequence);
    const maxLedgerId = uuid(maxSequence + 20_000);
    await seedLedger(maxLedgerId, ORG_A, maxReceiptId, "-999999.999999");
    await insertReceipt(
      notFoundReceipt(maxSequence, {
        charge_amount_usd: "999999.999999",
        credit_transaction_id: maxLedgerId,
      }),
    );

    const rows = await database.query<{
      charge_amount_usd: string;
      credit_transaction_id: string | null;
    }>(`
      SELECT charge_amount_usd::text, credit_transaction_id
      FROM org_storage_head_receipts
      WHERE id IN ('${uuid(zeroSequence)}', '${positiveReceiptId}', '${maxReceiptId}')
      ORDER BY charge_amount_usd
    `);
    expect(rows.rows).toEqual([
      { charge_amount_usd: "0.000000", credit_transaction_id: null },
      { charge_amount_usd: "0.000050", credit_transaction_id: ledgerId },
      { charge_amount_usd: "999999.999999", credit_transaction_id: maxLedgerId },
    ]);

    await expectViolation(
      () =>
        insertReceipt(
          notFoundReceipt(nextSequence(), {
            charge_amount_usd: "0.000050",
            credit_transaction_id: null,
          }),
        ),
      "org_storage_head_receipts_charge_shape_check",
    );
    await expectViolation(
      () =>
        insertReceipt(
          notFoundReceipt(nextSequence(), {
            charge_amount_usd: "0.000000",
            credit_transaction_id: ledgerId,
          }),
        ),
      "org_storage_head_receipts_charge_shape_check",
    );
    await expectViolation(
      () =>
        insertReceipt(
          notFoundReceipt(nextSequence(), {
            charge_amount_usd: "0.000050",
            credit_transaction_id: uuid(999_999),
          }),
        ),
      "org_storage_head_receipts_credit_transaction_id_fkey",
    );
    await expectViolation(
      () =>
        insertReceipt(
          notFoundReceipt(nextSequence(), {
            charge_amount_usd: "0.000050",
            credit_transaction_id: ledgerId,
          }),
        ),
      "org_storage_head_receipts_credit_transaction_uidx",
    );
  });

  test("rejects non-finite, negative, and unlinked charge shapes", async () => {
    const zeroSequence = nextSequence();
    await insertReceipt(notFoundReceipt(zeroSequence));
    for (const value of ["NaN", "-0.000001"]) {
      await expectViolation(
        () =>
          database.exec(
            `UPDATE org_storage_head_receipts
             SET charge_amount_usd = '${value}'::numeric WHERE id = '${uuid(zeroSequence)}'`,
          ),
        "org_storage_head_receipts_charge_shape_check",
      );
    }
    await expectViolation(() =>
      database.exec(
        `UPDATE org_storage_head_receipts SET charge_amount_usd = '-Infinity'::numeric
         WHERE id = '${uuid(zeroSequence)}'`,
      ),
    );

    const positiveSequence = nextSequence();
    const positiveReceiptId = uuid(positiveSequence);
    const ledgerId = uuid(positiveSequence + 20_000);
    await seedLedger(ledgerId, ORG_A, positiveReceiptId);
    await insertReceipt(
      notFoundReceipt(positiveSequence, {
        charge_amount_usd: "0.000050",
        credit_transaction_id: ledgerId,
      }),
    );
    await expectViolation(() =>
      database.exec(
        `UPDATE org_storage_head_receipts SET charge_amount_usd = 'Infinity'::numeric
           WHERE id = '${positiveReceiptId}'`,
      ),
    );

    const stored = await database.query<{
      charge_amount_usd: string;
      credit_transaction_id: string | null;
      id: string;
    }>(`
      SELECT id, charge_amount_usd::text, credit_transaction_id
      FROM org_storage_head_receipts
      WHERE id IN ('${uuid(zeroSequence)}', '${positiveReceiptId}')
      ORDER BY id
    `);
    expect(stored.rows).toEqual([
      {
        id: uuid(zeroSequence),
        charge_amount_usd: "0.000000",
        credit_transaction_id: null,
      },
      {
        id: positiveReceiptId,
        charge_amount_usd: "0.000050",
        credit_transaction_id: ledgerId,
      },
    ]);
  });

  test("rejects every NULL/status bypass and forbidden response-field combination", async () => {
    const missingOkFields: Array<Partial<NewOrgStorageHeadReceipt>> = [
      { object_id: null },
      { object_generation: null },
      { response_content_length: null },
      { response_content_type: null },
      { response_etag: null },
      { response_last_modified: null },
      { response_force_attachment: null },
    ];
    for (const missingField of missingOkFields) {
      await expectViolation(
        () => insertReceipt(okReceipt(nextSequence(), missingField)),
        "org_storage_head_receipts_response_shape_check",
      );
    }

    const missingValidatorFields: Array<Partial<NewOrgStorageHeadReceipt>> = [
      { object_id: null },
      { object_generation: null },
      { response_etag: null },
      { response_last_modified: null },
    ];
    for (const missingField of missingValidatorFields) {
      await expectViolation(
        () => insertReceipt(validatorReceipt(nextSequence(), "not_modified", missingField)),
        "org_storage_head_receipts_response_shape_check",
      );
      await expectViolation(
        () => insertReceipt(validatorReceipt(nextSequence(), "precondition_failed", missingField)),
        "org_storage_head_receipts_response_shape_check",
      );
    }

    for (const forbiddenField of [
      { response_content_length: 1n },
      { response_content_type: "text/plain" },
      { response_force_attachment: false },
    ] satisfies Array<Partial<NewOrgStorageHeadReceipt>>) {
      await expectViolation(
        () => insertReceipt(validatorReceipt(nextSequence(), "not_modified", forbiddenField)),
        "org_storage_head_receipts_response_shape_check",
      );
      await expectViolation(
        () =>
          insertReceipt(validatorReceipt(nextSequence(), "precondition_failed", forbiddenField)),
        "org_storage_head_receipts_response_shape_check",
      );
    }
    const forbiddenNotFoundFields: Array<Partial<NewOrgStorageHeadReceipt>> = [
      { object_id: uuid(90_001) },
      { object_generation: 1n },
      { response_content_length: 0n },
      { response_content_type: "text/plain" },
      { response_etag: "etag" },
      { response_last_modified: LAST_MODIFIED },
      { response_force_attachment: false },
    ];
    for (const forbiddenField of forbiddenNotFoundFields) {
      await expectViolation(
        () => insertReceipt(notFoundReceipt(nextSequence(), forbiddenField)),
        "org_storage_head_receipts_response_shape_check",
      );
    }
    const validSequence = nextSequence();
    await insertReceipt(okReceipt(validSequence));
    for (const assignment of ["response_status = 304", "response_kind = 'unknown'"]) {
      await expectViolation(
        () =>
          database.exec(
            `UPDATE org_storage_head_receipts SET ${assignment} WHERE id = '${uuid(validSequence)}'`,
          ),
        "org_storage_head_receipts_response_shape_check",
      );
    }
  });

  test("bounds generation, length, content type, ETag, and Last-Modified exactly", async () => {
    const invalidValues: Array<Partial<NewOrgStorageHeadReceipt>> = [
      { object_generation: 0n },
      { response_content_length: -1n },
      { response_content_length: 9_007_199_254_740_992n },
      { response_content_type: "" },
      { response_content_type: " text/plain" },
      { response_content_type: "text/plain\n" },
      { response_content_type: `text/plain${String.fromCharCode(0x2000)}` },
      { response_content_type: `${String.fromCharCode(0x2028)}text/plain` },
      { response_content_type: `text/plain${String.fromCharCode(0x205f)}` },
      { response_content_type: `${String.fromCharCode(0x3000)}text/plain` },
      { response_content_type: `application/${String.fromCharCode(0x80)}json` },
      { response_content_type: `application/${String.fromCharCode(0x85)}json` },
      { response_content_type: `application/${String.fromCharCode(0x9f)}json` },
      { response_content_type: `text/plain${String.fromCharCode(0xa0)}` },
      { response_content_type: `${String.fromCharCode(0xfeff)}text/plain` },
      { response_content_type: "a".repeat(256) },
      { response_etag: "" },
      { response_etag: '"quoted"' },
      { response_etag: "has space" },
      { response_etag: "etag\ninjected" },
      { response_etag: "étag" },
      { response_etag: "a".repeat(513) },
      { response_last_modified: new Date("2026-08-17T09:00:00.001Z") },
    ];
    for (const invalidValue of invalidValues) {
      await expectViolation(
        () => insertReceipt(okReceipt(nextSequence(), invalidValue)),
        "org_storage_head_receipts_response_value_check",
      );
    }

    const boundarySequence = nextSequence();
    await insertReceipt(
      okReceipt(boundarySequence, { response_content_length: 9_007_199_254_740_991n }),
    );
    const emptySequence = nextSequence();
    await insertReceipt(okReceipt(emptySequence, { response_content_length: 0n }));
    const [emptyReceipt] = await drizzle(database, { schema: { orgStorageHeadReceipts } })
      .select({ contentLength: orgStorageHeadReceipts.response_content_length })
      .from(orgStorageHeadReceipts)
      .where(eq(orgStorageHeadReceipts.id, uuid(emptySequence)));
    expect(emptyReceipt).toEqual({ contentLength: 0n });
    await expectViolation(
      () =>
        database.exec(
          `UPDATE org_storage_head_receipts SET response_last_modified = 'infinity'::timestamptz
           WHERE id = '${uuid(boundarySequence)}'`,
        ),
      "org_storage_head_receipts_response_value_check",
    );
  });

  test("rejects malformed identities, unsupported policies, and invalid retention", async () => {
    const malformedIdentities: Array<Partial<NewOrgStorageHeadReceipt>> = [
      { idempotency_key_hash: bareDigest(1) },
      { request_digest: `sha256:${"A".repeat(64)}` },
      { receipt_digest: prefixedDigest(1) },
      { receipt_digest: "A".repeat(64) },
      { authority_version: 2 },
      { storage_namespace: "other" },
      { operation: "get" },
    ];
    for (const malformedIdentity of malformedIdentities) {
      await expectViolation(
        () => insertReceipt(notFoundReceipt(nextSequence(), malformedIdentity)),
        "org_storage_head_receipts_identity_check",
      );
    }

    const validSequence = nextSequence();
    await insertReceipt(notFoundReceipt(validSequence));
    await expectViolation(
      () =>
        database.exec(
          `UPDATE org_storage_head_receipts SET header_policy_version = 2
           WHERE id = '${uuid(validSequence)}'`,
        ),
      "org_storage_head_receipts_identity_check",
    );

    for (const invalidRetention of [
      { replay_expires_at: CREATED_AT },
      { purge_after: REPLAY_EXPIRES_AT },
      { replay_expires_at: new Date("2026-08-19T00:00:00.000Z") },
    ] satisfies Array<Partial<NewOrgStorageHeadReceipt>>) {
      await expectViolation(
        () => insertReceipt(notFoundReceipt(nextSequence(), invalidRetention)),
        "org_storage_head_receipts_retention_check",
      );
    }
    for (const assignment of [
      "created_at = 'infinity'::timestamptz",
      "replay_expires_at = 'infinity'::timestamptz",
      "purge_after = 'infinity'::timestamptz",
    ]) {
      await expectViolation(
        () =>
          database.exec(
            `UPDATE org_storage_head_receipts SET ${assignment} WHERE id = '${uuid(validSequence)}'`,
          ),
        "org_storage_head_receipts_retention_check",
      );
    }
  });

  test("physically purges only receipts past their purge cutoff", async () => {
    const dueSequence = nextSequence();
    const retainedSequence = nextSequence();
    await insertReceipt(
      notFoundReceipt(dueSequence, {
        replay_expires_at: new Date("2026-08-17T10:30:00.000Z"),
        purge_after: new Date("2026-08-17T11:30:00.000Z"),
      }),
    );
    await insertReceipt(notFoundReceipt(retainedSequence));

    const deleted = await database.query<{ id: string }>(`
      DELETE FROM org_storage_head_receipts
      WHERE purge_after <= '2026-08-17T12:00:00.000Z'::timestamptz
      RETURNING id
    `);
    expect(deleted.rows).toEqual([{ id: uuid(dueSequence) }]);
    const retained = await database.query<{ id: string }>(`
      SELECT id FROM org_storage_head_receipts
      WHERE id IN ('${uuid(dueSequence)}', '${uuid(retainedSequence)}')
      ORDER BY id
    `);
    expect(retained.rows).toEqual([{ id: uuid(retainedSequence) }]);
  });

  test("keeps exact response evidence after deleting the catalog object", async () => {
    const sequence = nextSequence();
    const objectId = uuid(sequence + 10_000);
    await database.query(
      `INSERT INTO org_storage_objects
        (id, organization_id, object_key, key_fingerprint, presence,
         last_allocated_generation, committed_generation, size_bytes)
       VALUES ($1, $2, $3, $4, 'absent', 7, 7, 0)`,
      [objectId, ORG_A, `org/${ORG_A}/objects/${objectId}`, prefixedDigest(sequence + 3_000)],
    );
    await insertReceipt(
      okReceipt(sequence, {
        object_id: objectId,
        object_generation: 7n,
        response_content_length: 123n,
        response_content_type: "text/plain",
        response_etag: "durable-etag",
        response_last_modified: LAST_MODIFIED,
        response_force_attachment: false,
      }),
    );

    await database.query("DELETE FROM org_storage_objects WHERE id = $1", [objectId]);
    const client = drizzle(database, { schema: { orgStorageHeadReceipts } });
    const [evidence] = await client
      .select({
        object_id: orgStorageHeadReceipts.object_id,
        object_generation: orgStorageHeadReceipts.object_generation,
        response_content_length: orgStorageHeadReceipts.response_content_length,
        response_content_type: orgStorageHeadReceipts.response_content_type,
        response_etag: orgStorageHeadReceipts.response_etag,
        response_last_modified: orgStorageHeadReceipts.response_last_modified,
        response_force_attachment: orgStorageHeadReceipts.response_force_attachment,
      })
      .from(orgStorageHeadReceipts)
      .where(eq(orgStorageHeadReceipts.id, uuid(sequence)));
    expect(evidence).toEqual({
      object_id: objectId,
      object_generation: 7n,
      response_content_length: 123n,
      response_content_type: "text/plain",
      response_etag: "durable-etag",
      response_last_modified: LAST_MODIFIED,
      response_force_attachment: false,
    });
  });

  test("blocks isolated ledger deletion but permits one-statement organization cascade", async () => {
    const organizationId = uuid(80_001);
    const sequence = nextSequence();
    const receiptId = uuid(sequence);
    const ledgerId = uuid(sequence + 20_000);
    await database.query("INSERT INTO organizations (id) VALUES ($1)", [organizationId]);
    await seedLedger(ledgerId, organizationId, receiptId);
    await insertReceipt(
      notFoundReceipt(sequence, {
        organization_id: organizationId,
        charge_amount_usd: "0.000050",
        credit_transaction_id: ledgerId,
      }),
    );

    await database.exec("BEGIN");
    await expectViolation(
      () => database.query("DELETE FROM credit_transactions WHERE id = $1", [ledgerId]),
      "org_storage_head_receipts_credit_transaction_id_fkey",
    );
    await database.exec("ROLLBACK");
    await database.query("DELETE FROM organizations WHERE id = $1", [organizationId]);

    const counts = await database.query<{
      organizations: number;
      transactions: number;
      receipts: number;
    }>(`
      SELECT
        (SELECT count(*)::int FROM organizations WHERE id = '${organizationId}') AS organizations,
        (SELECT count(*)::int FROM credit_transactions WHERE id = '${ledgerId}') AS transactions,
        (SELECT count(*)::int FROM org_storage_head_receipts WHERE id = '${receiptId}') AS receipts
    `);
    expect(counts.rows).toEqual([{ organizations: 0, transactions: 0, receipts: 0 }]);
  });
});
