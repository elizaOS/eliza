/**
 * Real-PGlite proof that the gallery listing applies its displayability filter
 * in SQL rather than after LIMIT/OFFSET.
 *
 * The gallery route pages with LIMIT/OFFSET and then drops rows without a
 * storage_url in JavaScript. Rows that can never be displayed therefore consume
 * slots in the database page, so a full page can come back short and, once every
 * row in the final page is undisplayable, hasMore flips false while completed
 * rows remain unread.
 */

import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

import { pushSchema } from "drizzle-kit/api";
import { dbWrite } from "../../client";
import { apiKeys } from "../../schemas/api-keys";
import { generations } from "../../schemas/generations";
import { organizations } from "../../schemas/organizations";
import { usageRecords } from "../../schemas/usage-records";
import { users } from "../../schemas/users";
import { GenerationsRepository } from "../generations";

const PGLITE_TIMEOUT = 60_000;
const ORG_ID = "00000000-0000-4000-8000-0000000a0001";

let schemaFailure = "";

beforeAll(async () => {
  try {
    const { apply } = await pushSchema(
      { organizations, users, apiKeys, usageRecords, generations } as never,
      dbWrite as never,
    );
    await apply();
  } catch (error) {
    schemaFailure = error instanceof Error ? error.message : String(error);
  }
}, PGLITE_TIMEOUT);

beforeEach(async () => {
  expect(schemaFailure).toBe("");
  await dbWrite.delete(generations);
  await dbWrite.delete(organizations);
  await dbWrite
    .insert(organizations)
    .values({ id: ORG_ID, name: "gallery-org", slug: "gallery-org" } as never);
});

async function seed(rows: Array<{ storageUrl: string | null; createdAt: Date }>): Promise<void> {
  for (const [index, row] of rows.entries()) {
    await dbWrite.insert(generations).values({
      organization_id: ORG_ID,
      type: "image",
      model: "test-model",
      provider: "test-provider",
      prompt: `prompt-${index}`,
      status: "completed",
      storage_url: row.storageUrl,
      created_at: row.createdAt,
    } as never);
  }
}

describe("gallery listing pagination", () => {
  test(
    "applies the storage-url filter in SQL so LIMIT counts only displayable rows",
    async () => {
      // Newest first: three undisplayable rows ahead of two displayable ones.
      await seed([
        { storageUrl: "https://cdn.test/older-b", createdAt: new Date("2026-01-01T00:00:00Z") },
        { storageUrl: "https://cdn.test/older-a", createdAt: new Date("2026-01-02T00:00:00Z") },
        { storageUrl: null, createdAt: new Date("2026-01-03T00:00:00Z") },
        { storageUrl: null, createdAt: new Date("2026-01-04T00:00:00Z") },
        { storageUrl: null, createdAt: new Date("2026-01-05T00:00:00Z") },
      ]);

      const repository = new GenerationsRepository();
      const limit = 2;
      const page = await repository.listByOrganizationAndStatusSummary(ORG_ID, "completed", {
        requireStorageUrl: true,
        limit: limit + 1,
        offset: 0,
      });

      // Without the SQL filter the first page is consumed entirely by the three
      // null-storage rows, so the caller sees zero items and hasMore === false
      // while two displayable rows remain permanently unreachable.
      const displayable = page.filter((row) => row.storage_url);
      expect(displayable.length).toBe(2);
      expect(displayable.map((row) => row.storage_url)).toEqual([
        "https://cdn.test/older-a",
        "https://cdn.test/older-b",
      ]);
    },
    PGLITE_TIMEOUT,
  );

  test(
    "still returns undisplayable rows when the caller does not ask for the filter",
    async () => {
      await seed([
        { storageUrl: null, createdAt: new Date("2026-01-03T00:00:00Z") },
        { storageUrl: "https://cdn.test/one", createdAt: new Date("2026-01-02T00:00:00Z") },
      ]);

      const repository = new GenerationsRepository();
      const page = await repository.listByOrganizationAndStatusSummary(ORG_ID, "completed", {
        limit: 10,
        offset: 0,
      });

      expect(page.length).toBe(2);
      expect(page.some((row) => row.storage_url === null)).toBe(true);
    },
    PGLITE_TIMEOUT,
  );
});
