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
    WHATSAPP_OTP_ENABLED: "true",
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

async function verifyPhone(phone: string, channel = "sms") {
  const sent = await post(`/auth/${channel}/send`, { phone, tenantId });
  expect(sent.status).toBe(200);
  const { MockSmsInbox } = await import("../auth/sms-provider");
  return post(`/auth/${channel}/verify`, {
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

test("a refresh into another tenant applies that tenant's login methods and keeps the session on refusal", async () => {
  const { tenants, tenantConfigs } = await import("../db/schema");
  const { userTenants } = await import("../db/schema-auth");
  const login = await verifyPhone("+14155550199");
  expect(login.status).toBe(200);
  const session = (await login.json()) as {
    refreshToken: string;
    user: { id: string };
  };
  await database.db.insert(tenants).values([
    {
      id: "sms-off",
      name: "SMS off",
      apiKeyHash: randomBytes(32).toString("hex"),
    },
    {
      id: "not-joined",
      name: "Not joined",
      apiKeyHash: randomBytes(32).toString("hex"),
    },
  ]);
  await database.db.insert(tenantConfigs).values({
    tenantId: "sms-off",
    authAbuseConfig: { loginMethods: { sms: false } },
  } as never);
  await database.db
    .insert(userTenants)
    .values({ userId: session.user.id, tenantId: "sms-off", role: "member" });

  const refresh = (tenantId?: string) =>
    post("/auth/refresh", {
      refreshToken: session.refreshToken,
      ...(tenantId ? { tenantId } : {}),
    });

  const disabled = await refresh("sms-off");
  expect(disabled.status).toBe(403);
  expect((await disabled.json()).token).toBeUndefined();
  const notMember = await refresh("not-joined");
  expect(notMember.status).toBe(403);
  // Neither refusal spent or revoked the session.
  const same = await refresh();
  expect(same.status).toBe(200);
});

test("a refresh into another tenant applies that tenant's OIDC provider rule to an OIDC session", async () => {
  const { tenants, tenantConfigs } = await import("../db/schema");
  const { userTenants } = await import("../db/schema-auth");
  const { getMfaBackend, getOAuthKeyStore } = await import(
    "../api/services/auth-lifecycle"
  );
  const login = await verifyPhone("+14155550198");
  expect(login.status).toBe(200);
  const session = (await login.json()) as {
    refreshToken: string;
    user: { id: string };
  };
  await database.db.insert(tenants).values({
    id: "idp-off",
    name: "Corp IdP off",
    apiKeyHash: randomBytes(32).toString("hex"),
  });
  await database.db.insert(tenantConfigs).values({
    tenantId: "idp-off",
    authAbuseConfig: { loginMethods: { oidc: { "corp-idp": false } } },
  } as never);
  await database.db
    .insert(userTenants)
    .values({ userId: session.user.id, tenantId: "idp-off", role: "member" });
  // Store the claims an OIDC sign-in through "corp-idp" records on its
  // refresh token (no OIDC provider runs in this test).
  const tokenHash = createHash("sha256")
    .update(session.refreshToken)
    .digest("hex");
  await getMfaBackend().set(
    `refresh:claims:${tokenHash}`,
    JSON.stringify(
      getOAuthKeyStore().encrypt(
        JSON.stringify({
          userId: session.user.id,
          authMethod: "oidc",
          oidcProviderId: "corp-idp",
          oidcSubject: "subject-1",
          emailVerified: false,
        }),
      ),
    ),
    60_000,
  );

  const disabled = await post("/auth/refresh", {
    refreshToken: session.refreshToken,
    tenantId: "idp-off",
  });
  expect(disabled.status).toBe(403);
  expect((await disabled.json()).error).toBe(
    "OIDC login is disabled for this tenant",
  );
});

test("the tenant switch route applies the target tenant's login methods", async () => {
  const { tenants, tenantConfigs } = await import("../db/schema");
  const { userTenants } = await import("../db/schema-auth");
  const { createSessionToken } = await import("../api/services/auth-lifecycle");
  const login = await verifyPhone("+14155550197");
  expect(login.status).toBe(200);
  const { user } = (await login.json()) as { user: { id: string } };
  await database.db.insert(tenants).values([
    {
      id: "switch-sms-off",
      name: "SMS off",
      apiKeyHash: randomBytes(32).toString("hex"),
    },
    {
      id: "switch-open",
      name: "Open",
      apiKeyHash: randomBytes(32).toString("hex"),
    },
  ]);
  await database.db.insert(tenantConfigs).values([
    {
      tenantId: "switch-sms-off",
      authAbuseConfig: { loginMethods: { sms: false } },
    },
    { tenantId: "switch-open" },
  ] as never);
  await database.db.insert(userTenants).values([
    { userId: user.id, tenantId: "switch-sms-off", role: "member" },
    { userId: user.id, tenantId: "switch-open", role: "member" },
  ]);
  const personalTenant = `personal-${user.id}`;
  await database.db
    .insert(userTenants)
    .values({ userId: user.id, tenantId: personalTenant, role: "owner" })
    .onConflictDoNothing();
  const token = await createSessionToken("", personalTenant, {
    userId: user.id,
    tenantId: personalTenant,
    authMethod: "sms",
    mfaVerifiedAt: Date.now(),
  });
  const switchTo = (tenantId: string) =>
    app.request("https://login.example.test/user/me/tenants/switch", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ tenantId }),
    });

  const refused = await switchTo("switch-sms-off");
  expect(refused.status).toBe(403);
  expect((await refused.json()).error).toBe(
    "sms login is disabled for this tenant",
  );
  expect((await switchTo("switch-open")).status).toBe(200);
});

test("a phone linked through SMS gets no second account from WhatsApp login", async () => {
  const { users, accounts } = await import("../db/schema-auth");
  const phone = "+14155550126";
  const subject = `phone:${createHash("sha256").update(phone).digest("hex")}`;
  const [owner] = await database.db
    .insert(users)
    .values({ email: "sms-linked@example.test", emailVerified: true })
    .returning();
  await database.db.insert(accounts).values({
    userId: owner.id,
    provider: "phone",
    providerAccountId: subject,
  });
  const whatsapp = await verifyPhone(phone, "whatsapp");
  expect((await whatsapp.json()).token).toBeUndefined();
  const { eq } = await import("drizzle-orm");
  expect(
    await database.db
      .select()
      .from(users)
      .where(eq(users.walletAddress, subject)),
  ).toEqual([]);
  const sms = await verifyPhone(phone);
  expect(sms.status).toBe(200);
  expect((await sms.json()).user.id).toBe(owner.id);
});

test("a phone linked to two users through SMS and WhatsApp signs in to neither", async () => {
  const { users, accounts } = await import("../db/schema-auth");
  const phone = "+14155550127";
  const subject = `phone:${createHash("sha256").update(phone).digest("hex")}`;
  const [smsOwner, whatsappOwner] = await database.db
    .insert(users)
    .values([
      { email: "split-sms@example.test", emailVerified: true },
      { email: "split-whatsapp@example.test", emailVerified: true },
    ])
    .returning();
  await database.db.insert(accounts).values([
    { userId: smsOwner.id, provider: "phone", providerAccountId: subject },
    {
      userId: whatsappOwner.id,
      provider: "whatsapp",
      providerAccountId: subject,
    },
  ]);
  for (const channel of ["sms", "whatsapp"]) {
    const response = await verifyPhone(phone, channel);
    expect((await response.json()).token).toBeUndefined();
  }
});
