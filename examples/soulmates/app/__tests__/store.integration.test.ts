import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as schema from "../lib/db/schema";

// Setup in-memory PGlite for testing
let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

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
  CREATE TABLE IF NOT EXISTS soulmates_analytics_snapshots (
    day VARCHAR(10) PRIMARY KEY,
    snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS soulmates_rate_limits (
    key VARCHAR(255) PRIMARY KEY,
    count INTEGER NOT NULL DEFAULT 1,
    reset_at TIMESTAMPTZ NOT NULL
  );
`;

beforeAll(async () => {
  // Use in-memory database for tests
  pglite = new PGlite();
  db = drizzle(pglite, { schema });
  await pglite.exec(MIGRATIONS_SQL);
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  // Clean tables before each test
  await pglite.exec(`
    DELETE FROM soulmates_credit_ledger;
    DELETE FROM soulmates_allowlist;
    DELETE FROM soulmates_analytics_snapshots;
    DELETE FROM soulmates_users;
    DELETE FROM soulmates_rate_limits;
  `);
});

describe("Database Schema Integration", () => {
  describe("users table", () => {
    it("creates user with default values", async () => {
      const [user] = await db
        .insert(schema.usersTable)
        .values({ phone: "+15551234567" })
        .returning();

      expect(user.id).toBeDefined();
      expect(user.phone).toBe("+15551234567");
      expect(user.credits).toBe(0);
      expect(user.status).toBe("active");
      expect(user.isAdmin).toBe(false);
      expect(user.name).toBeNull();
      expect(user.email).toBeNull();
      expect(user.location).toBeNull();
    });

    it("enforces unique phone numbers", async () => {
      await db
        .insert(schema.usersTable)
        .values({ phone: "+15551234567" })
        .returning();

      await expect(
        Promise.resolve(
          db
            .insert(schema.usersTable)
            .values({ phone: "+15551234567" })
            .returning(),
        ),
      ).rejects.toThrow();
    });

    it("updates user fields", async () => {
      const [user] = await db
        .insert(schema.usersTable)
        .values({ phone: "+15551234567" })
        .returning();

      await db
        .update(schema.usersTable)
        .set({
          name: "John Doe",
          email: "john@example.com",
          location: "New York",
          credits: 100,
          status: "active",
        })
        .where(eq(schema.usersTable.id, user.id));

      const [updated] = await db
        .select()
        .from(schema.usersTable)
        .where(eq(schema.usersTable.id, user.id));

      expect(updated.name).toBe("John Doe");
      expect(updated.email).toBe("john@example.com");
      expect(updated.location).toBe("New York");
      expect(updated.credits).toBe(100);
      expect(updated.status).toBe("active");
    });

    it("supports active and blocked statuses", async () => {
      const statuses = ["active", "blocked"];

      for (const status of statuses) {
        const phone = `+1555${Math.random().toString().slice(2, 9)}`;
        const [user] = await db
          .insert(schema.usersTable)
          .values({ phone, status })
          .returning();
        expect(user.status).toBe(status);
      }
    });

    it("handles null optional fields correctly", async () => {
      const [user] = await db
        .insert(schema.usersTable)
        .values({
          phone: "+15551234567",
          name: null,
          email: null,
          location: null,
        })
        .returning();

      expect(user.name).toBeNull();
      expect(user.email).toBeNull();
      expect(user.location).toBeNull();
    });
  });

  describe("allowlist table", () => {
    it("adds phone to allowlist", async () => {
      await db.insert(schema.allowlistTable).values({ phone: "+15551234567" });

      const [entry] = await db
        .select()
        .from(schema.allowlistTable)
        .where(eq(schema.allowlistTable.phone, "+15551234567"));

      expect(entry.phone).toBe("+15551234567");
      expect(entry.addedAt).toBeInstanceOf(Date);
      expect(entry.addedBy).toBeNull();
    });

    it("enforces unique phones in allowlist", async () => {
      await db
        .insert(schema.allowlistTable)
        .values({ phone: "+15551234567" })
        .returning();

      await expect(
        Promise.resolve(
          db
            .insert(schema.allowlistTable)
            .values({ phone: "+15551234567" })
            .returning(),
        ),
      ).rejects.toThrow();
    });

    it("links allowlist to user who added it", async () => {
      const [admin] = await db
        .insert(schema.usersTable)
        .values({ phone: "+15559999999", isAdmin: true })
        .returning();

      await db
        .insert(schema.allowlistTable)
        .values({ phone: "+15551234567", addedBy: admin.id });

      const [entry] = await db
        .select()
        .from(schema.allowlistTable)
        .where(eq(schema.allowlistTable.phone, "+15551234567"));

      expect(entry.addedBy).toBe(admin.id);
    });

    it("sets addedBy to null when adding user is deleted", async () => {
      const [admin] = await db
        .insert(schema.usersTable)
        .values({ phone: "+15559999999", isAdmin: true })
        .returning();

      await db
        .insert(schema.allowlistTable)
        .values({ phone: "+15551234567", addedBy: admin.id });

      await db
        .delete(schema.usersTable)
        .where(eq(schema.usersTable.id, admin.id));

      const [entry] = await db
        .select()
        .from(schema.allowlistTable)
        .where(eq(schema.allowlistTable.phone, "+15551234567"));

      expect(entry.addedBy).toBeNull();
    });

    it("can remove from allowlist", async () => {
      await db.insert(schema.allowlistTable).values({ phone: "+15551234567" });
      await db
        .delete(schema.allowlistTable)
        .where(eq(schema.allowlistTable.phone, "+15551234567"));

      const entries = await db
        .select()
        .from(schema.allowlistTable)
        .where(eq(schema.allowlistTable.phone, "+15551234567"));

      expect(entries).toHaveLength(0);
    });
  });

  describe("credit ledger table", () => {
    it("records credit transaction", async () => {
      const [user] = await db
        .insert(schema.usersTable)
        .values({ phone: "+15551234567", credits: 0 })
        .returning();

      const [entry] = await db
        .insert(schema.creditLedgerTable)
        .values({
          userId: user.id,
          delta: 100,
          balance: 100,
          reason: "topup",
          reference: "pi_test123",
        })
        .returning();

      expect(entry.userId).toBe(user.id);
      expect(entry.delta).toBe(100);
      expect(entry.balance).toBe(100);
      expect(entry.reason).toBe("topup");
      expect(entry.reference).toBe("pi_test123");
    });

    it("supports negative deltas (spending)", async () => {
      const [user] = await db
        .insert(schema.usersTable)
        .values({ phone: "+15551234567", credits: 100 })
        .returning();

      const [entry] = await db
        .insert(schema.creditLedgerTable)
        .values({
          userId: user.id,
          delta: -50,
          balance: 50,
          reason: "admin_adjustment",
        })
        .returning();

      expect(entry.delta).toBe(-50);
      expect(entry.balance).toBe(50);
    });

    it("cascades delete when user is deleted", async () => {
      const [user] = await db
        .insert(schema.usersTable)
        .values({ phone: "+15551234567" })
        .returning();

      await db.insert(schema.creditLedgerTable).values({
        userId: user.id,
        delta: 100,
        balance: 100,
        reason: "topup",
      });

      await db
        .delete(schema.usersTable)
        .where(eq(schema.usersTable.id, user.id));

      const entries = await db
        .select()
        .from(schema.creditLedgerTable)
        .where(eq(schema.creditLedgerTable.userId, user.id));

      expect(entries).toHaveLength(0);
    });

    it("maintains transaction history", async () => {
      const [user] = await db
        .insert(schema.usersTable)
        .values({ phone: "+15551234567" })
        .returning();

      await db.insert(schema.creditLedgerTable).values({
        userId: user.id,
        delta: 100,
        balance: 100,
        reason: "topup",
      });

      await db.insert(schema.creditLedgerTable).values({
        userId: user.id,
        delta: 200,
        balance: 300,
        reason: "topup",
      });

      await db.insert(schema.creditLedgerTable).values({
        userId: user.id,
        delta: -50,
        balance: 250,
        reason: "admin_adjustment",
      });

      const entries = await db
        .select()
        .from(schema.creditLedgerTable)
        .where(eq(schema.creditLedgerTable.userId, user.id));

      expect(entries).toHaveLength(3);
    });
  });

  describe("rate limits table", () => {
    it("creates rate limit entry", async () => {
      const resetAt = new Date(Date.now() + 60000);
      await db
        .insert(schema.rateLimitTable)
        .values({ key: "sms:ip:127.0.0.1", count: 1, resetAt });

      const [entry] = await db
        .select()
        .from(schema.rateLimitTable)
        .where(eq(schema.rateLimitTable.key, "sms:ip:127.0.0.1"));

      expect(entry.key).toBe("sms:ip:127.0.0.1");
      expect(entry.count).toBe(1);
    });

    it("updates rate limit count", async () => {
      const resetAt = new Date(Date.now() + 60000);
      await db
        .insert(schema.rateLimitTable)
        .values({ key: "sms:ip:127.0.0.1", count: 1, resetAt });

      await db
        .update(schema.rateLimitTable)
        .set({ count: 5 })
        .where(eq(schema.rateLimitTable.key, "sms:ip:127.0.0.1"));

      const [entry] = await db
        .select()
        .from(schema.rateLimitTable)
        .where(eq(schema.rateLimitTable.key, "sms:ip:127.0.0.1"));

      expect(entry.count).toBe(5);
    });

    it("supports upsert (conflict resolution)", async () => {
      const resetAt = new Date(Date.now() + 60000);

      await db
        .insert(schema.rateLimitTable)
        .values({ key: "test-key", count: 1, resetAt })
        .onConflictDoUpdate({
          target: schema.rateLimitTable.key,
          set: { count: 1, resetAt },
        });

      const newResetAt = new Date(Date.now() + 120000);
      await db
        .insert(schema.rateLimitTable)
        .values({ key: "test-key", count: 1, resetAt: newResetAt })
        .onConflictDoUpdate({
          target: schema.rateLimitTable.key,
          set: { count: 1, resetAt: newResetAt },
        });

      const entries = await db
        .select()
        .from(schema.rateLimitTable)
        .where(eq(schema.rateLimitTable.key, "test-key"));

      expect(entries).toHaveLength(1);
    });
  });
});

describe("Concurrent Operations", () => {
  it("handles concurrent user creation with different phones", async () => {
    const phones = [
      "+15551111111",
      "+15552222222",
      "+15553333333",
      "+15554444444",
      "+15555555555",
    ];

    const results = await Promise.all(
      phones.map((phone) =>
        db.insert(schema.usersTable).values({ phone }).returning(),
      ),
    );

    expect(results).toHaveLength(5);
    const createdPhones = results.map((r) => r[0].phone);
    expect(new Set(createdPhones).size).toBe(5);
  });

  it("handles concurrent credit ledger entries for same user", async () => {
    const [user] = await db
      .insert(schema.usersTable)
      .values({ phone: "+15551234567" })
      .returning();

    const entries = await Promise.all([
      db
        .insert(schema.creditLedgerTable)
        .values({
          userId: user.id,
          delta: 100,
          balance: 100,
          reason: "topup",
          reference: "ref1",
        })
        .returning(),
      db
        .insert(schema.creditLedgerTable)
        .values({
          userId: user.id,
          delta: 200,
          balance: 300,
          reason: "topup",
          reference: "ref2",
        })
        .returning(),
      db
        .insert(schema.creditLedgerTable)
        .values({
          userId: user.id,
          delta: 50,
          balance: 350,
          reason: "admin_adjustment",
          reference: "ref3",
        })
        .returning(),
    ]);

    expect(entries).toHaveLength(3);

    const allEntries = await db
      .select()
      .from(schema.creditLedgerTable)
      .where(eq(schema.creditLedgerTable.userId, user.id));

    expect(allEntries).toHaveLength(3);
  });
});

describe("Edge Cases", () => {
  it("handles very long phone numbers", async () => {
    const longPhone = "+123456789012345"; // 15 digits (max E.164)
    const [user] = await db
      .insert(schema.usersTable)
      .values({ phone: longPhone })
      .returning();

    expect(user.phone).toBe(longPhone);
  });

  it("handles maximum field lengths", async () => {
    const [user] = await db
      .insert(schema.usersTable)
      .values({
        phone: "+15551234567",
        name: "a".repeat(255),
        email: `${"a".repeat(243)}@example.com`, // 255 total
        location: "a".repeat(255),
      })
      .returning();

    expect(user.name?.length).toBe(255);
    expect(user.location?.length).toBe(255);
  });

  it("handles zero credits correctly", async () => {
    const [user] = await db
      .insert(schema.usersTable)
      .values({ phone: "+15551234567", credits: 0 })
      .returning();

    expect(user.credits).toBe(0);

    await db
      .update(schema.usersTable)
      .set({ credits: 100 })
      .where(eq(schema.usersTable.id, user.id));

    await db
      .update(schema.usersTable)
      .set({ credits: 0 })
      .where(eq(schema.usersTable.id, user.id));

    const [updated] = await db
      .select()
      .from(schema.usersTable)
      .where(eq(schema.usersTable.id, user.id));

    expect(updated.credits).toBe(0);
  });

  it("handles large credit values", async () => {
    const [user] = await db
      .insert(schema.usersTable)
      .values({ phone: "+15551234567", credits: 2147483647 }) // Max 32-bit int
      .returning();

    expect(user.credits).toBe(2147483647);
  });

  it("handles special characters in name", async () => {
    const [user] = await db
      .insert(schema.usersTable)
      .values({
        phone: "+15551234567",
        name: "María O'Brien-García 日本語",
      })
      .returning();

    expect(user.name).toBe("María O'Brien-García 日本語");
  });
});
