/** Real identity router and PGlite; only SMS delivery is captured locally. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import type { createLoginApp } from "../app";
import type { createPGLiteDb } from "../db/pglite";

let app: ReturnType<typeof createLoginApp>;
let database: Awaited<ReturnType<typeof createPGLiteDb>>;
const previous = new Map<string, string | undefined>();
const tenantId = "linked-phone-test";

beforeAll(async () => {
  const environment = {
    NODE_ENV: "test",
    SMS_PROVIDER: "mock",
    STEWARD_DB_MODE: "pglite",
    STEWARD_PGLITE_MEMORY: "true",
    APP_URL: "https://login.example.test",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
    STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
    STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
  };
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  const { createPGLiteDb } = await import("../db/pglite");
  const { setPGLiteOverride } = await import("../db/client");
  database = await createPGLiteDb("memory://");
  setPGLiteOverride(database.db, () => database.client.close());
  const { tenants, tenantConfigs } = await import("../db/schema");
  await database.db.insert(tenants).values({
    id: tenantId,
    name: "Linked phone test",
    apiKeyHash: randomBytes(32).toString("hex"),
  });
  await database.db
    .insert(tenantConfigs)
    .values({ tenantId, joinMode: "open" });
  const { createLoginApp } = await import("../app");
  app = createLoginApp();
}, 60_000);

afterAll(async () => {
  if (database) await database.client.close();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function post(path: string, body: object) {
  return app.request(`https://login.example.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a verified linked phone signs into its existing email account", async () => {
  const { users, accounts } = await import("../db/schema-auth");
  const phone = "+14155550123";
  const subject = `phone:${createHash("sha256").update(phone).digest("hex")}`;
  const [owner] = await database.db
    .insert(users)
    .values({ email: "phone-owner@example.test", emailVerified: true })
    .returning();
  await database.db.insert(accounts).values({
    userId: owner.id,
    provider: "phone",
    providerAccountId: subject,
  });
  const sent = await post("/auth/sms/send", { phone, tenantId });
  expect(sent.status).toBe(200);
  const { MockSmsInbox } = await import("../auth/sms-provider");
  const code = MockSmsInbox.last(phone)?.code;
  expect(code).toMatch(/^\d{6}$/);
  const verified = await post("/auth/sms/verify", { phone, code, tenantId });
  expect(verified.status).toBe(200);
  const body = await verified.json();
  expect(body.user.id).toBe(owner.id);
  const { verifyToken } = await import("../auth/jwt");
  const claims = await verifyToken(body.token);
  expect(claims.userId).toBe(owner.id);
  const replay = await post("/auth/sms/verify", { phone, code, tenantId });
  expect(replay.status).toBe(401);
});

async function verifyPhone(phone: string) {
  const sent = await post("/auth/sms/send", { phone, tenantId });
  expect(sent.status).toBe(200);
  const { MockSmsInbox } = await import("../auth/sms-provider");
  return post("/auth/sms/verify", {
    phone,
    code: MockSmsInbox.last(phone)?.code,
    tenantId,
  });
}

test("original phone accounts retain their identity", async () => {
  const { users } = await import("../db/schema-auth");
  const phone = "+14155550124";
  const subject = `phone:${createHash("sha256").update(phone).digest("hex")}`;
  const [owner] = await database.db
    .insert(users)
    .values({ walletAddress: subject })
    .returning();
  const response = await verifyPhone(phone);
  expect(response.status).toBe(200);
  expect((await response.json()).user.id).toBe(owner.id);
});

test("conflicting original and linked phone owners receive no session", async () => {
  const { users, accounts } = await import("../db/schema-auth");
  const phone = "+14155550125";
  const subject = `phone:${createHash("sha256").update(phone).digest("hex")}`;
  await database.db.insert(users).values({ walletAddress: subject });
  const [other] = await database.db
    .insert(users)
    .values({ email: "conflict@example.test" })
    .returning();
  await database.db.insert(accounts).values({
    userId: other.id,
    provider: "phone",
    providerAccountId: subject,
  });
  const response = await verifyPhone(phone);
  expect(response.status).toBe(500);
  expect((await response.json()).token).toBeUndefined();
});
