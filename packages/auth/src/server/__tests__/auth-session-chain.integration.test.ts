/**
 * Session chain after sign-in: logout, refresh rotation, MFA-completed refresh
 * tokens, device-code polling and the email-code guess limits.
 *
 * Drives the real identity router and PGlite store with the in-memory mock
 * email provider. No real mailbox or account is used.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { createLoginApp } from "../app";
import type { MockEmailInbox as MockEmailInboxType } from "../auth/email-provider";
import type { createPGLiteDb } from "../db/pglite";

const TENANT_ID = "elizacloud";
const EMAIL_OFF_TENANT = "chain-email-off";
const SMS_OFF_TENANT = "chain-sms-off";
const STEWARD_ORIGIN = "https://api.eliza.app/steward";
const ROUTER_ORIGIN = "https://login.internal";

let app: ReturnType<typeof createLoginApp>;
let database: Awaited<ReturnType<typeof createPGLiteDb>>;
let inbox: typeof MockEmailInboxType;
const previous = new Map<string, string | undefined>();
let ipCounter = 0;

beforeAll(async () => {
  const environment: Record<string, string> = {
    NODE_ENV: "test",
    EMAIL_PROVIDER: "mock",
    STEWARD_DB_MODE: "pglite",
    STEWARD_PGLITE_MEMORY: "true",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
    STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
    STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
    APP_URL: STEWARD_ORIGIN,
  };
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  for (const key of ["RESEND_API_KEY", "EMAIL_MAGIC_LINK_BASE_URL"]) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  const { createPGLiteDb } = await import("../db/pglite");
  const { setPGLiteOverride } = await import("../db/client");
  database = await createPGLiteDb("memory://");
  setPGLiteOverride(database.db, () => database.client.close());
  const { tenants, tenantConfigs } = await import("../db/schema");
  for (const [id, loginMethods] of [
    [TENANT_ID, undefined],
    [EMAIL_OFF_TENANT, { email: false }],
    [SMS_OFF_TENANT, { sms: false }],
  ] as const) {
    await database.db.insert(tenants).values({
      id,
      name: `Synthetic ${id}`,
      apiKeyHash: randomBytes(32).toString("hex"),
    });
    await database.db.insert(tenantConfigs).values({
      tenantId: id,
      joinMode: "open",
      ...(loginMethods ? { authAbuseConfig: { loginMethods } } : {}),
    });
  }
  ({ MockEmailInbox: inbox } = await import("../auth/email-provider"));
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

function nextIp(): string {
  ipCounter += 1;
  return `198.18.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

function post(
  path: string,
  body: object,
  options: { ip?: string; bearer?: string } = {},
) {
  return app.request(`${ROUTER_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": options.ip ?? nextIp(),
      ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(
    Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
  );
}

function sixDigitCode(text: string): string {
  const match = text.match(/\b(\d{6})\b/);
  if (!match) throw new Error("no six-digit code in the email");
  return match[1];
}

async function sendCode(email: string): Promise<string> {
  const sent = await post("/auth/email/code/send", {
    email,
    tenantId: TENANT_ID,
  });
  expect(sent.status).toBe(200);
  return sixDigitCode(inbox.last(email)?.text ?? "");
}

async function emailSignIn(email: string): Promise<Record<string, unknown>> {
  const code = await sendCode(email);
  const verify = await post("/auth/email/code/verify", {
    email,
    code,
    tenantId: TENANT_ID,
  });
  expect(verify.status).toBe(200);
  return (await verify.json()) as Record<string, unknown>;
}

async function refresh(refreshToken: string, tenantId?: string) {
  return post("/auth/refresh", {
    refreshToken,
    ...(tenantId ? { tenantId } : {}),
  });
}

/** Runs `body` against the production limiter, persisted in this test's database. */
async function withDatabaseLimiter(body: () => Promise<void>) {
  const priorProxyHops = process.env.STEWARD_TRUSTED_PROXY_HOPS;
  process.env.STEWARD_TRUSTED_PROXY_HOPS = "1";
  const { setDatabaseAuthRateLimiter } = await import(
    "../api/services/auth-rate-limit"
  );
  const { checkDatabaseAuthRateLimit } = await import(
    "../auth/database-rate-limit"
  );
  setDatabaseAuthRateLimiter(checkDatabaseAuthRateLimit);
  try {
    await body();
  } finally {
    setDatabaseAuthRateLimiter(undefined);
    if (priorProxyHops === undefined)
      delete process.env.STEWARD_TRUSTED_PROXY_HOPS;
    else process.env.STEWARD_TRUSTED_PROXY_HOPS = priorProxyHops;
  }
}

describe("session chain", () => {
  test("logout with a token a refresh already rotated also ends the successor", async () => {
    const session = await emailSignIn("chain-logout@example.test");
    const first = String(session.refreshToken);
    const rotated = await refresh(first);
    expect(rotated.status).toBe(200);
    const successor = String(
      ((await rotated.json()) as Record<string, unknown>).refreshToken,
    );

    // The logout carries the token it held before the refresh landed.
    const logout = await post("/auth/logout", { refreshToken: first });
    expect(logout.status).toBe(200);

    const afterLogout = await refresh(successor);
    expect(afterLogout.status).toBe(401);
  }, 30_000);

  test("a rotation that fails part way keeps the presented token's claims", async () => {
    const session = await emailSignIn("chain-rotation@example.test");
    const refreshToken = String(session.refreshToken);
    const { getMfaBackend } = await import("../api/services/auth-lifecycle");
    const backend = getMfaBackend();
    const set = backend.set.bind(backend);
    backend.set = async (key, value, ttlMs) => {
      if (key.startsWith("refresh:used:")) throw new Error("store unavailable");
      return set(key, value, ttlMs);
    };
    try {
      const failed = await refresh(refreshToken);
      expect(failed.status).toBe(500);
    } finally {
      backend.set = set;
    }

    const retried = await refresh(refreshToken);
    expect(retried.status).toBe(200);
    const body = (await retried.json()) as Record<string, unknown>;
    expect(claimsOf(String(body.token)).authMethod).toBe("email");
  }, 30_000);

  test("a refresh token from an MFA sign-in keeps its login method for tenant switches", async () => {
    const email = "chain-mfa@example.test";
    const first = await emailSignIn(email);
    const userId = String((first.user as Record<string, unknown>).id);
    const enrol = await post(
      "/auth/mfa/totp/enroll",
      {},
      { bearer: String(first.token) },
    );
    expect(enrol.status).toBe(200);
    const { secret } = (await enrol.json()) as { secret: string };
    const { generateTotp } = await import("../auth/totp");
    const confirm = await post(
      "/auth/mfa/totp/verify",
      { code: await generateTotp(secret) },
      { bearer: String(first.token) },
    );
    expect(confirm.status).toBe(200);

    const challenge = await emailSignIn(email);
    expect(challenge.mfaRequired).toBe(true);
    const complete = await post("/auth/mfa/totp/complete", {
      challengeId: (challenge.mfa as { challengeId: string }).challengeId,
      code: await generateTotp(secret, { time: Date.now() + 30_000 }),
    });
    expect(complete.status).toBe(200);
    const completed = (await complete.json()) as Record<string, unknown>;

    const { userTenants } = await import("../db/schema-auth");
    for (const tenantId of [EMAIL_OFF_TENANT, SMS_OFF_TENANT]) {
      await database.db
        .insert(userTenants)
        .values({ userId, tenantId, role: "member" });
    }

    // Email sign-in is off in this tenant, so the switch is refused and the
    // current session stays usable.
    const refused = await refresh(
      String(completed.refreshToken),
      EMAIL_OFF_TENANT,
    );
    expect(refused.status).toBe(403);

    // Another tenant restricts a different method; the email session moves.
    const switched = await refresh(
      String(completed.refreshToken),
      SMS_OFF_TENANT,
    );
    expect(switched.status).toBe(200);
    const body = (await switched.json()) as Record<string, unknown>;
    const claims = claimsOf(String(body.token));
    expect(claims.tenantId).toBe(SMS_OFF_TENANT);
    expect(claims.authMethod).toBe("email");
  }, 60_000);

  test("a session without a recorded login method cannot switch into a restricted tenant", async () => {
    const { tenantSwitchLoginRefusal } = await import(
      "../api/services/auth-lifecycle"
    );
    expect(await tenantSwitchLoginRefusal(EMAIL_OFF_TENANT, {})).toBeString();
    expect(await tenantSwitchLoginRefusal(TENANT_ID, {})).toBeNull();
  });

  test("device polling never rewrites the approve/deny record", async () => {
    const session = await emailSignIn("chain-device@example.test");
    const issued = await post("/auth/device/code", { tenantId: TENANT_ID });
    expect(issued.status).toBe(200);
    const { device_code: deviceCode, user_code: userCode } =
      (await issued.json()) as { device_code: string; user_code: string };

    const { getMfaBackend } = await import("../api/services/auth-lifecycle");
    const backend = getMfaBackend();
    const set = backend.set.bind(backend);
    const written: string[] = [];
    backend.set = async (key, value, ttlMs) => {
      written.push(key);
      return set(key, value, ttlMs);
    };
    const poll = () =>
      post("/auth/device/token", {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
      });
    try {
      const pending = await poll();
      expect(((await pending.json()) as { error: string }).error).toBe(
        "authorization_pending",
      );
      const tooFast = await poll();
      expect(((await tooFast.json()) as { error: string }).error).toBe(
        "slow_down",
      );
    } finally {
      backend.set = set;
    }
    expect(written.length).toBeGreaterThan(0);
    expect(written.some((key) => key.startsWith("device-auth:device:"))).toBe(
      false,
    );

    const approve = await post(
      "/auth/device/verify",
      { user_code: userCode },
      { bearer: String(session.token) },
    );
    expect(approve.status).toBe(200);
    // The pacing record still applies after approval; the decision survives it.
    const throttled = await poll();
    expect(((await throttled.json()) as { error: string }).error).toBe(
      "slow_down",
    );
    const again = await post(
      "/auth/device/verify",
      { user_code: userCode },
      { bearer: String(session.token) },
    );
    expect(again.status).toBe(409);
  }, 30_000);

  test("one client's wrong guesses do not lock the address for another client", async () => {
    await withDatabaseLimiter(async () => {
      const email = "chain-guesses@example.test";
      const attacker = "203.0.113.200";
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const response = await post(
          "/auth/email/code/verify",
          { email, code: "000000", tenantId: TENANT_ID },
          { ip: attacker },
        );
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 5).every((status) => status === 401)).toBe(true);
      expect(statuses[5]).toBe(429);

      const code = await sendCode(email);
      const owner = await post(
        "/auth/email/code/verify",
        { email, code, tenantId: TENANT_ID },
        { ip: "203.0.113.201" },
      );
      expect(owner.status).toBe(200);
    });
  }, 60_000);
});
