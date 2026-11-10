/**
 * The last step of a redirect sign-in: redeeming the one-time code, MFA after
 * a browser magic link, guest sign-in policy and loopback redirect URIs.
 *
 * Drives the real identity router and PGlite store with the in-memory mock
 * email provider. Codes for the exchange tests are planted in Steward's code
 * store exactly as its callbacks write them; no provider is contacted.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import type { createLoginApp } from "../app";
import type { MockEmailInbox as MockEmailInboxType } from "../auth/email-provider";
import type { createPGLiteDb } from "../db/pglite";

const TENANT_ID = "elizacloud";
const GOOGLE_OFF_TENANT = "completion-google-off";
const GUEST_OFF_TENANT = "completion-guest-off";
const APP_CLIENT_ID = "reader-app";
const APP_LINK = "https://eliza.app/reader/auth/callback";
const LOOPBACK = "http://[::1]:8765/callback";
const STEWARD_ORIGIN = "https://api.eliza.app/steward";
const ROUTER_ORIGIN = "https://login.internal";

let app: ReturnType<typeof createLoginApp>;
let database: Awaited<ReturnType<typeof createPGLiteDb>>;
let inbox: typeof MockEmailInboxType;
const previous = new Map<string, string | undefined>();
let ipCounter = 0;

const base64url = (bytes: Buffer) => bytes.toString("base64url");
const s256 = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

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
  for (const key of [
    "RESEND_API_KEY",
    "EMAIL_MAGIC_LINK_BASE_URL",
    "STEWARD_OAUTH_ALLOWED_REDIRECTS",
    "STEWARD_OAUTH_REDIRECT_ALLOWLIST",
  ]) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  const { createPGLiteDb } = await import("../db/pglite");
  const { setPGLiteOverride } = await import("../db/client");
  database = await createPGLiteDb("memory://");
  setPGLiteOverride(database.db, () => database.client.close());
  const { tenants, tenantConfigs, tenantAppClients } = await import(
    "../db/schema"
  );
  for (const [id, loginMethods] of [
    [TENANT_ID, undefined],
    [GOOGLE_OFF_TENANT, { oauth: { google: false } }],
    [GUEST_OFF_TENANT, { guest: false }],
  ] as const) {
    await database.db.insert(tenants).values({
      id,
      name: `Synthetic ${id}`,
      apiKeyHash: randomBytes(32).toString("hex"),
    });
    await database.db.insert(tenantConfigs).values({
      tenantId: id,
      joinMode: "open",
      allowedRedirectUrls: [APP_LINK, LOOPBACK],
      ...(loginMethods ? { authAbuseConfig: { loginMethods } } : {}),
    });
  }
  // One app client of the Google-off tenant turns Google back on for itself.
  await database.db.insert(tenantAppClients).values({
    id: APP_CLIENT_ID,
    tenantId: GOOGLE_OFF_TENANT,
    name: "Reader",
    allowedRedirectUrls: [APP_LINK],
    loginMethods: { oauth: { google: true } },
  });
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
  return `198.19.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

function post(path: string, body: object, bearer?: string) {
  return app.request(`${ROUTER_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": nextIp(),
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

/** Store a one-time code the way Steward's callbacks do. */
async function plantCode(payload: Record<string, unknown>): Promise<string> {
  const { getOAuthCodeStore } = await import("../api/services/auth-lifecycle");
  const code = base64url(randomBytes(32));
  await getOAuthCodeStore().set(
    `oauth-code:${code}`,
    JSON.stringify({ expiresAt: Date.now() + 60_000, ...payload }),
  );
  return code;
}

function sixDigitCode(text: string): string {
  const match = text.match(/\b(\d{6})\b/);
  if (!match) throw new Error("no six-digit code in the email");
  return match[1];
}

describe("sign-in completion", () => {
  test("an app client's own login methods apply when its code is redeemed", async () => {
    const tokens = {
      providerName: "google",
      token: "synthetic-access",
      refreshToken: "synthetic-refresh",
      redirectUri: APP_LINK,
      tenantId: GOOGLE_OFF_TENANT,
      expiresIn: 900,
    };
    const exchange = (code: string) =>
      post("/auth/oauth/exchange", {
        code,
        redirect_uri: APP_LINK,
        tenant_id: GOOGLE_OFF_TENANT,
      });

    const allowed = await exchange(
      await plantCode({ ...tokens, clientId: APP_CLIENT_ID }),
    );
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { token: string }).token).toBe(
      "synthetic-access",
    );

    const refused = await exchange(await plantCode(tokens));
    expect(refused.status).toBe(403);
  });

  test("an MFA code redeemed at /oauth/:provider/token returns the challenge", async () => {
    const verifier = base64url(randomBytes(48));
    const code = await plantCode({
      providerName: "google",
      mfaRequired: true,
      mfa: { type: "totp", challengeId: "synthetic-challenge" },
      redirectUri: APP_LINK,
      tenantId: TENANT_ID,
      codeChallenge: s256(verifier),
      codeChallengeMethod: "S256",
    });
    const response = await post("/auth/oauth/google/token", {
      code,
      redirectUri: APP_LINK,
      tenantId: TENANT_ID,
      codeVerifier: verifier,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.mfaRequired).toBe(true);
    expect(body.mfa).toEqual({
      type: "totp",
      challengeId: "synthetic-challenge",
    });
    expect(body.token).toBeUndefined();
  });

  test("a TOTP user finishes a magic-link sign-in through the exchange code", async () => {
    const email = "completion-totp@example.test";
    await post("/auth/email/code/send", { email, tenantId: TENANT_ID });
    const verify = await post("/auth/email/code/verify", {
      email,
      code: sixDigitCode(inbox.last(email)?.text ?? ""),
      tenantId: TENANT_ID,
    });
    expect(verify.status).toBe(200);
    const session = (await verify.json()) as { token: string };
    const enrol = await post("/auth/mfa/totp/enroll", {}, session.token);
    expect(enrol.status).toBe(200);
    const { secret } = (await enrol.json()) as { secret: string };
    const { generateTotp } = await import("../auth/totp");
    expect(
      (
        await post(
          "/auth/mfa/totp/verify",
          { code: await generateTotp(secret) },
          session.token,
        )
      ).status,
    ).toBe(200);

    const sent = await post("/auth/email/send", { email, tenantId: TENANT_ID });
    expect(sent.status).toBe(200);
    const link = new URLSearchParams({
      token: inbox.last(email)?.token ?? "",
      email,
      tenantId: TENANT_ID,
    });
    const callback = await app.request(
      `${ROUTER_ORIGIN}/auth/callback/email?${link}`,
      { method: "GET", headers: { "X-Forwarded-For": nextIp() } },
    );
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location") ?? "");
    const code = new URLSearchParams(location.hash.slice(1)).get("code");
    expect(code).toBeTruthy();
    location.hash = "";

    const exchange = await post("/auth/oauth/exchange", {
      code,
      redirect_uri: location.toString(),
      tenant_id: TENANT_ID,
    });
    expect(exchange.status).toBe(200);
    const challenge = (await exchange.json()) as Record<string, unknown>;
    expect(challenge.mfaRequired).toBe(true);
    expect(challenge.token).toBeUndefined();

    const complete = await post("/auth/mfa/totp/complete", {
      challengeId: (challenge.mfa as { challengeId: string }).challengeId,
      code: await generateTotp(secret, { time: Date.now() + 30_000 }),
    });
    expect(complete.status).toBe(200);
    expect(typeof ((await complete.json()) as { token?: unknown }).token).toBe(
      "string",
    );
  }, 60_000);

  test("guest sign-in is refused where the tenant turns it off", async () => {
    const refused = await post("/auth/guest", { tenantId: GUEST_OFF_TENANT });
    expect(refused.status).toBe(403);
  });

  test("an IPv6 loopback redirect URI is admitted", async () => {
    const { assertAllowedOAuthRedirectUri } = await import(
      "../api/services/auth-lifecycle"
    );
    const url = await assertAllowedOAuthRedirectUri(LOOPBACK, TENANT_ID);
    expect(url.hostname).toBe("[::1]");
    await expect(
      assertAllowedOAuthRedirectUri("http://[::2]:8765/callback", TENANT_ID),
    ).rejects.toThrow("https");
  });
});
