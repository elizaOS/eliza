/**
 * Exercises organization storage reservations through the real repository,
 * schema, and quota migrations on isolated in-process PGlite. The harness
 * installs only the prerequisite organization shape and quota-table DDL, so
 * bigint arithmetic and concurrent admission run without repository mocks.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const ORGANIZATION_ID = "00000000-0000-4000-8000-000000002950";
const PGLITE_TIMEOUT_MS = 60_000;
const QUOTA_MIGRATION_PATH = join(
  import.meta.dir,
  "../../migrations/0102_add_org_storage_quota.sql",
);
const NATIVE_CATALOG_MIGRATION_PATH = join(
  import.meta.dir,
  "../../migrations/0256_org_storage_native_objects.sql",
);

let closeDatabaseConnectionsForTests:
  | typeof import("../../client").closeDatabaseConnectionsForTests
  | null = null;
let dbWrite: typeof import("../../client").dbWrite;
let orgStorageQuota: typeof import("../../schemas/org-storage-quota").orgStorageQuota;
let repository: typeof import("../org-storage-quota").orgStorageQuotaRepository;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests, dbWrite } = await import("../../client"));
  ({ orgStorageQuota } = await import("../../schemas/org-storage-quota"));

  await dbWrite.execute(
    sql.raw(`
    CREATE TABLE organizations (
      id uuid PRIMARY KEY
    )
  `),
  );

  const migration = readFileSync(QUOTA_MIGRATION_PATH, "utf8");
  const pricingMarker = "-- Pricing entries for the storage proxy.";
  const markerIndex = migration.indexOf(pricingMarker);
  if (markerIndex === -1) {
    throw new Error("Quota migration is missing its pricing-section marker");
  }
  const quotaDdl = migration
    .slice(0, markerIndex)
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  for (const statement of quotaDdl.split(";")) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) {
      await dbWrite.execute(sql.raw(trimmed));
    }
  }

  const nativeCatalogMigration = readFileSync(NATIVE_CATALOG_MIGRATION_PATH, "utf8");
  const reconciliationDdl = nativeCatalogMigration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .find(
      (statement) =>
        statement.startsWith('ALTER TABLE "org_storage_quota"') &&
        statement.includes('ADD COLUMN "native_catalog_reconciled_at"'),
    );
  if (reconciliationDdl === undefined) {
    throw new Error("Native-catalog migration is missing the quota reconciliation column DDL");
  }
  await dbWrite.execute(sql.raw(reconciliationDdl));

  ({ orgStorageQuotaRepository: repository } = await import("../org-storage-quota"));
}, PGLITE_TIMEOUT_MS);

beforeEach(async () => {
  await dbWrite.delete(orgStorageQuota);
  await dbWrite.execute(sql`DELETE FROM organizations`);
  await dbWrite.execute(sql`INSERT INTO organizations (id) VALUES (${ORGANIZATION_ID})`);
});

afterAll(async () => {
  if (closeDatabaseConnectionsForTests !== null) {
    await closeDatabaseConnectionsForTests();
  }
});

describe("OrgStorageQuotaRepository", () => {
  test("matches the nullable native-catalog reconciliation column without installing its catalog", async () => {
    const column = await dbWrite.execute(sql`
      SELECT data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'org_storage_quota'
        AND column_name = 'native_catalog_reconciled_at'
    `);
    expect(column.rows).toEqual([
      {
        data_type: "timestamp with time zone",
        is_nullable: "YES",
        column_default: null,
      },
    ]);

    const unrelatedCatalog = await dbWrite.execute(sql`
      SELECT to_regclass('public.org_storage_objects')::text AS relation
    `);
    expect(unrelatedCatalog.rows).toEqual([{ relation: null }]);
  });

  test("reserves and releases bigint byte counts exactly, clamping releases at zero", async () => {
    const exactBytes = 9_007_199_254_740_993n;
    await repository.setBytesLimit(ORGANIZATION_ID, exactBytes + 10n);

    expect(await repository.tryReserveBytes(ORGANIZATION_ID, exactBytes)).toBe(exactBytes);

    await repository.releaseBytes(ORGANIZATION_ID, 2n);
    const afterExactRelease = await repository.findByOrganization(ORGANIZATION_ID);
    expect(afterExactRelease?.bytes_used).toBe(exactBytes - 2n);

    await repository.releaseBytes(ORGANIZATION_ID, exactBytes + 100n);
    const afterOversizedRelease = await repository.findByOrganization(ORGANIZATION_ID);
    expect(afterOversizedRelease?.bytes_used).toBe(0n);
  });

  test("rejects a reservation that would exceed the configured quota", async () => {
    await repository.setBytesLimit(ORGANIZATION_ID, 10n);

    expect(await repository.tryReserveBytes(ORGANIZATION_ID, 10n)).toBe(10n);
    expect(await repository.tryReserveBytes(ORGANIZATION_ID, 1n)).toBeNull();

    const stored = await repository.findByOrganization(ORGANIZATION_ID);
    expect(stored?.bytes_used).toBe(10n);
    expect(stored?.bytes_limit).toBe(10n);
  });

  test("keeps concurrent reservations within the configured quota", async () => {
    const bytesLimit = 10n;
    const bytesPerReservation = 3n;
    await repository.setBytesLimit(ORGANIZATION_ID, bytesLimit);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repository.tryReserveBytes(ORGANIZATION_ID, bytesPerReservation),
      ),
    );
    const accepted = results.filter((result) => result !== null);

    expect(accepted).toHaveLength(3);
    expect(accepted.every((bytesUsed) => bytesUsed <= bytesLimit)).toBe(true);

    const stored = await repository.findByOrganization(ORGANIZATION_ID);
    expect(stored?.bytes_used).toBe(9n);
    expect(stored?.bytes_limit).toBe(bytesLimit);
  });
});
