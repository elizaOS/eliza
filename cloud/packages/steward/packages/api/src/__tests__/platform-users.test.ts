import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { getDb, users } from "@stwd/db";
import { eq } from "drizzle-orm";

// Skip when no DB configured (CI without Postgres)
const SKIP = !process.env.DATABASE_URL;
const describeWithDatabase = SKIP ? describe.skip : describe;

const TEST_PORT = parseInt(process.env.PORT || "3200", 10);
const BASE_URL = `http://localhost:${TEST_PORT}`;

// Use the dev platform key configured in STEWARD_PLATFORM_KEYS
const PLATFORM_KEY =
  (process.env.STEWARD_PLATFORM_KEYS ?? "").split(",")[0].trim() || "dev-platform-key";

const TEST_EMAIL_NEW = `platform-users-test-new-${Date.now()}@example.com`;
const TEST_EMAIL_EXISTING = `platform-users-test-existing-${Date.now()}@example.com`;

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (SKIP) return;
  // Pre-insert the "existing" user so idempotency can be tested
  const db = getDb();
  await db
    .insert(users)
    .values({
      email: TEST_EMAIL_EXISTING,
      emailVerified: true,
      name: "Pre-existing",
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  if (SKIP) return;
  const db = getDb();
  await db.delete(users).where(eq(users.email, TEST_EMAIL_NEW));
  await db.delete(users).where(eq(users.email, TEST_EMAIL_EXISTING));
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describeWithDatabase("POST /platform/users", () => {
  it("returns 401 when platform key is missing", async () => {
    const res = await fetch(`${BASE_URL}/platform/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: TEST_EMAIL_NEW }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 when platform key is invalid", async () => {
    const res = await fetch(`${BASE_URL}/platform/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Steward-Platform-Key": "invalid-platform-key",
      },
      body: JSON.stringify({ email: TEST_EMAIL_NEW }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 400 when email is missing", async () => {
    const res = await fetch(`${BASE_URL}/platform/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Steward-Platform-Key": PLATFORM_KEY,
      },
      body: JSON.stringify({ name: "No Email" }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/email/i);
  });

  it("returns 400 when email is not a valid email string", async () => {
    const res = await fetch(`${BASE_URL}/platform/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Steward-Platform-Key": PLATFORM_KEY,
      },
      body: JSON.stringify({ email: "not-an-email" }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(false);
  });

  it("creates a new user and returns isNew=true (201)", async () => {
    if (SKIP) return;
    const res = await fetch(`${BASE_URL}/platform/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Steward-Platform-Key": PLATFORM_KEY,
      },
      body: JSON.stringify({
        email: TEST_EMAIL_NEW,
        name: "Migration User",
        emailVerified: true,
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as {
      ok: boolean;
      data: { userId: string; isNew: boolean };
    };
    expect(data.ok).toBe(true);
    expect(data.data.isNew).toBe(true);
    expect(typeof data.data.userId).toBe("string");
    expect(data.data.userId.length).toBeGreaterThan(0);
  });

  it("is idempotent — returns existing userId and isNew=false on duplicate email", async () => {
    if (SKIP) return;
    const res = await fetch(`${BASE_URL}/platform/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Steward-Platform-Key": PLATFORM_KEY,
      },
      body: JSON.stringify({
        email: TEST_EMAIL_EXISTING,
        name: "Should Not Overwrite",
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      data: { userId: string; isNew: boolean };
    };
    expect(data.ok).toBe(true);
    expect(data.data.isNew).toBe(false);
    expect(typeof data.data.userId).toBe("string");
  });

  it("does not overwrite existing user data on duplicate (safe upsert)", async () => {
    if (SKIP) return;
    const db = getDb();
    const [before] = await db
      .select({ name: users.name, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.email, TEST_EMAIL_EXISTING));

    // POST with different name — should NOT be applied
    await fetch(`${BASE_URL}/platform/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Steward-Platform-Key": PLATFORM_KEY,
      },
      body: JSON.stringify({ email: TEST_EMAIL_EXISTING, name: "OVERWRITTEN" }),
    });

    const [after] = await db
      .select({ name: users.name, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.email, TEST_EMAIL_EXISTING));

    // Name must not change
    expect(after.name).toBe(before.name);
  });

  it("email is stored lowercase", async () => {
    if (SKIP) return;
    const mixedCaseEmail = `Platform-Upper-${Date.now()}@Example.COM`;
    const db = getDb();

    const res = await fetch(`${BASE_URL}/platform/users`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Steward-Platform-Key": PLATFORM_KEY,
      },
      body: JSON.stringify({ email: mixedCaseEmail }),
    });
    expect(res.status).toBe(201);
    await res.json();
    const [row] = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.email, mixedCaseEmail.toLowerCase()));
    expect(row?.email).toBe(mixedCaseEmail.toLowerCase());

    // Cleanup
    await db.delete(users).where(eq(users.email, mixedCaseEmail.toLowerCase()));
  });
});
