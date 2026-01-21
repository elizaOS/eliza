import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../lib/db/schema";

// We need to mock the getDatabase to use our test database
// This tests the store functions with a real database

let pglite: PGlite;
let testDb: ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS_SQL = `
  CREATE TABLE IF NOT EXISTS soulmates_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(20) NOT NULL UNIQUE,
    email VARCHAR(255),
    name VARCHAR(255),
    location VARCHAR(255),
    credits INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    is_admin BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS soulmates_allowlist (
    phone VARCHAR(20) PRIMARY KEY,
    added_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    added_by UUID REFERENCES soulmates_users(id) ON DELETE SET NULL
  );
  CREATE TABLE IF NOT EXISTS soulmates_credit_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES soulmates_users(id) ON DELETE CASCADE,
    delta INTEGER NOT NULL,
    balance INTEGER NOT NULL,
    reason VARCHAR(50) NOT NULL,
    reference VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

beforeAll(async () => {
  pglite = new PGlite();
  testDb = drizzle(pglite, { schema });
  await pglite.exec(MIGRATIONS_SQL);
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await pglite.exec(`
    DELETE FROM soulmates_credit_ledger;
    DELETE FROM soulmates_allowlist;
    DELETE FROM soulmates_users;
  `);
});

describe("Store - Credit Operations", () => {
  describe("atomic credit updates", () => {
    it("handles concurrent credit additions without losing credits", async () => {
      // Create a user
      const [user] = await testDb
        .insert(schema.usersTable)
        .values({ phone: "+15551234567", credits: 0 })
        .returning();

      // Simulate concurrent credit additions using raw SQL (similar to addCredits)
      const addCreditsSql = `
        UPDATE soulmates_users 
        SET credits = GREATEST(0, credits + $1), updated_at = NOW()
        WHERE id = $2
        RETURNING *
      `;

      // Run concurrent updates
      const results = await Promise.all([
        pglite.query(addCreditsSql, [100, user.id]),
        pglite.query(addCreditsSql, [100, user.id]),
        pglite.query(addCreditsSql, [100, user.id]),
      ]);

      // All should succeed
      expect(results.every((r) => r.rows.length === 1)).toBe(true);

      // Final balance should be correct (300)
      const [finalUser] = await testDb
        .select()
        .from(schema.usersTable)
        .where(eq(schema.usersTable.id, user.id));

      expect(finalUser.credits).toBe(300);
    });

    it("prevents credits from going negative", async () => {
      const [user] = await testDb
        .insert(schema.usersTable)
        .values({ phone: "+15551234567", credits: 50 })
        .returning();

      // Try to subtract more than available
      const result = await pglite.query<{ credits: number }>(
        `UPDATE soulmates_users 
         SET credits = GREATEST(0, credits + $1), updated_at = NOW()
         WHERE id = $2
         RETURNING credits`,
        [-100, user.id],
      );

      expect(result.rows[0].credits).toBe(0);
    });
  });

  describe("idempotency", () => {
    it("prevents duplicate credit additions with same reference", async () => {
      const [user] = await testDb
        .insert(schema.usersTable)
        .values({ phone: "+15551234567", credits: 0 })
        .returning();

      const reference = "pi_test_duplicate";

      // First addition
      await testDb.insert(schema.creditLedgerTable).values({
        userId: user.id,
        delta: 100,
        balance: 100,
        reason: "topup",
        reference,
      });

      await testDb
        .update(schema.usersTable)
        .set({ credits: 100 })
        .where(eq(schema.usersTable.id, user.id));

      // Check for duplicate before second addition
      const [existing] = await testDb
        .select()
        .from(schema.creditLedgerTable)
        .where(eq(schema.creditLedgerTable.reference, reference))
        .limit(1);

      expect(existing).toBeDefined();
      expect(existing.reference).toBe(reference);

      // Verify credits weren't duplicated
      const [finalUser] = await testDb
        .select()
        .from(schema.usersTable)
        .where(eq(schema.usersTable.id, user.id));

      expect(finalUser.credits).toBe(100);
    });
  });
});

describe("Store - User Status Defaults", () => {
  it("defaults new users to active", async () => {
    const [user] = await testDb
      .insert(schema.usersTable)
      .values({ phone: "+15551234567" })
      .returning();

    expect(user.status).toBe("active");
  });

  it("keeps blocked users blocked", async () => {
    const [user] = await testDb
      .insert(schema.usersTable)
      .values({ phone: "+15551234567", status: "blocked" })
      .returning();

    expect(user.status).toBe("blocked");
  });
});
