/**
 * Native in-app email sign-in (Alpha Phone): POST /auth/email/code/send, then
 * POST /auth/email/code/verify. (`delivery: "code"` on /auth/email/send is the
 * compatible older spelling of the same code-only email.)
 *
 * Drives the real identity router and PGlite store with the in-memory mock
 * email provider. A native caller asks for a code-only email, which must carry
 * no link at all (a link would sign in a browser and consume the challenge),
 * and redeems the code through /auth/email/code/verify. No real mailbox or
 * account is used.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { createLoginApp } from "../app";
import type { MockEmailInbox as MockEmailInboxType } from "../auth/email-provider";
import type { createPGLiteDb } from "../db/pglite";

const TENANT_ID = "elizacloud";
const STEWARD_ORIGIN = "https://api.eliza.app/steward";
const ROUTER_ORIGIN = "https://login.internal";

let app: ReturnType<typeof createLoginApp>;
let database: Awaited<ReturnType<typeof createPGLiteDb>>;
let inbox: typeof MockEmailInboxType;
const previous = new Map<string, string | undefined>();

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
    EMAIL_AUTH_REDIRECT_BASE_URL: "https://cloud.example.test",
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
  await database.db.insert(tenants).values({
    id: TENANT_ID,
    name: "Synthetic Eliza Cloud",
    apiKeyHash: randomBytes(32).toString("hex"),
  });
  await database.db.insert(tenantConfigs).values({
    tenantId: TENANT_ID,
    joinMode: "open",
    allowedRedirectUrls: [
      "https://cloud.example.test/login",
      "https://other-cloud.example.test/login",
    ],
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

/** A native request: no Origin, no Referer, no cookies. Distinct client IPs
 * keep the per-IP limiter out of the way between tests. */
function nativePost(path: string, body: object, ip: string) {
  return app.request(`${ROUTER_ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": ip,
    },
    body: JSON.stringify(body),
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

function sixDigitCode(text: string): string {
  const match = text.match(/\b(\d{6})\b/);
  if (!match) throw new Error("no six-digit code in the email");
  return match[1];
}

function browserProof() {
  const verifier = randomBytes(48).toString("base64url");
  return {
    verifier,
    binding: {
      state: randomBytes(24).toString("base64url"),
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      codeChallengeMethod: "S256" as const,
      redirectUri: "https://cloud.example.test/login",
    },
  };
}

function deliveredEmailLink(email: string) {
  // The inbox's convenience magicLink field ends at the token. Exercise the complete delivered URL.
  const link = inbox
    .last(email)
    ?.text.match(/https?:\/\/[^\s<>]+/g)
    ?.find((value) => value.includes("/callback/email?"));
  if (!link) throw new Error("No complete email callback was delivered");
  return new URL(link);
}

async function emailCallback(email: string) {
  const url = deliveredEmailLink(email);
  // Browser query parameters cannot replace the server-held destination or state.
  url.searchParams.set("redirectUri", "https://attacker.example/login");
  const response = await app.request(
    `${ROUTER_ORIGIN}${url.pathname}${url.search}`,
  );
  return new URL(response.headers.get("location") ?? "");
}

describe("native email code sign-in (Alpha Phone)", () => {
  test("browser email callback preserves its state, exact redirect and S256 proof through one-use exchange", async () => {
    const email = "bound-browser@example.test";
    const { verifier, binding } = browserProof();
    const sent = await nativePost(
      "/auth/email/send",
      { email, tenantId: TENANT_ID, browserBinding: binding },
      "198.51.100.151",
    );
    expect(sent.status).toBe(200);
    const token = deliveredEmailLink(email).searchParams.get("token");
    const direct = await nativePost(
      "/auth/email/verify",
      { token, email, tenantId: TENANT_ID, browserCallback: true },
      "198.51.100.163",
    );
    expect(direct.status).toBe(401);
    expect((await direct.json()).token).toBeUndefined();
    const callback = await emailCallback(email);
    expect(callback.origin + callback.pathname).toBe(binding.redirectUri);
    const fragment = new URLSearchParams(callback.hash.slice(1));
    expect(fragment.get("state")).toBe(binding.state);
    expect(fragment.get("tenantId")).toBe(TENANT_ID);
    const code = fragment.get("code");
    expect(code).toBeTruthy();
    const request = {
      code,
      redirectUri: binding.redirectUri,
      tenantId: TENANT_ID,
      codeVerifier: verifier,
      purpose: "email-login",
    };
    for (const rejected of [
      { ...request, purpose: undefined },
      { ...request, codeVerifier: undefined },
      { ...request, codeVerifier: randomBytes(48).toString("base64url") },
      { ...request, tenantId: "wrong-tenant" },
      { ...request, redirectUri: "https://attacker.example/login" },
    ]) {
      const result = await nativePost(
        "/auth/oauth/exchange",
        rejected,
        "198.51.100.152",
      );
      expect(result.status).toBe(401);
      expect((await result.json()).token).toBeUndefined();
    }
    const providerRoute = await nativePost(
      "/auth/oauth/google/token",
      request,
      "198.51.100.160",
    );
    expect(providerRoute.status).toBe(401);
    expect((await providerRoute.json()).code).toBe("code_purpose_mismatch");
    const { tenantConfigs } = await import("../db/schema");
    await database.db
      .update(tenantConfigs)
      .set({ authAbuseConfig: { loginMethods: { email: false } } })
      .where(eq(tenantConfigs.tenantId, TENANT_ID));
    try {
      const disabled = await nativePost(
        "/auth/oauth/exchange",
        request,
        "198.51.100.164",
      );
      expect(disabled.status).toBe(403);
      expect((await disabled.json()).token).toBeUndefined();
    } finally {
      await database.db
        .update(tenantConfigs)
        .set({ authAbuseConfig: {} })
        .where(eq(tenantConfigs.tenantId, TENANT_ID));
    }
    const exchange = await nativePost(
      "/auth/oauth/exchange",
      request,
      "198.51.100.153",
    );
    expect(exchange.status).toBe(200);
    const session = await exchange.json();
    expect(session.purpose).toBe("email-login");
    expect(typeof session.token).toBe("string");
    expect(
      (await nativePost("/auth/oauth/exchange", request, "198.51.100.154"))
        .status,
    ).toBe(401);
    const replay = await emailCallback(email);
    expect(replay.searchParams.get("reason")).toBe("invalid_link");
  });

  test("a rejected resend cannot replace the last accepted browser proof", async () => {
    const email = "browser-failed-resend@example.test";
    const first = browserProof(),
      second = browserProof();
    expect(
      (
        await nativePost(
          "/auth/email/send",
          { email, tenantId: TENANT_ID, browserBinding: first.binding },
          "198.51.100.165",
        )
      ).status,
    ).toBe(200);
    const { MockEmailProvider } = await import("../auth/email-provider");
    const original = MockEmailProvider.prototype.send;
    MockEmailProvider.prototype.send = async () => {
      throw new Error("Email transport unavailable");
    };
    try {
      const rejected = await nativePost(
        "/auth/email/send",
        { email, tenantId: TENANT_ID, browserBinding: second.binding },
        "198.51.100.166",
      );
      expect(rejected.status).toBe(502);
    } finally {
      MockEmailProvider.prototype.send = original;
    }
    const callback = await emailCallback(email);
    const fragment = new URLSearchParams(callback.hash.slice(1));
    expect(fragment.get("state")).toBe(first.binding.state);
    const exchange = await nativePost(
      "/auth/oauth/exchange",
      {
        code: fragment.get("code"),
        redirectUri: first.binding.redirectUri,
        tenantId: TENANT_ID,
        codeVerifier: first.verifier,
        purpose: "email-login",
      },
      "198.51.100.167",
    );
    expect(exchange.status).toBe(200);
  });

  test("browser email callback can use an exact tenant-registered login instead of the global default", async () => {
    const email = "tenant-browser-login@example.test";
    const { binding, verifier } = browserProof();
    binding.redirectUri = "https://other-cloud.example.test/login";
    expect(
      (
        await nativePost(
          "/auth/email/send",
          { email, tenantId: TENANT_ID, browserBinding: binding },
          "198.51.100.161",
        )
      ).status,
    ).toBe(200);
    const callback = await emailCallback(email);
    expect(callback.origin + callback.pathname).toBe(binding.redirectUri);
    const code = new URLSearchParams(callback.hash.slice(1)).get("code");
    const exchange = await nativePost(
      "/auth/oauth/exchange",
      {
        code,
        redirectUri: binding.redirectUri,
        tenantId: TENANT_ID,
        codeVerifier: verifier,
        purpose: "email-login",
      },
      "198.51.100.162",
    );
    expect(exchange.status).toBe(200);
    expect((await exchange.json()).purpose).toBe("email-login");
  });

  test("browser binding is all-or-nothing and cannot select an unregistered redirect", async () => {
    const { binding } = browserProof();
    let index = 0;
    for (const browserBinding of [
      null,
      {},
      { ...binding, state: "" },
      { ...binding, codeChallengeMethod: "plain" },
      { ...binding, codeChallenge: "x" },
      { ...binding, redirectUri: "https://attacker.example/login" },
      {
        ...binding,
        redirectUri:
          "https://cloud.example.test/login?returnTo=https://attacker.example",
      },
      { ...binding, redirectUri: "https://cloud.example.test/login#x" },
    ]) {
      const email = `bad-binding-${index++}@example.test`;
      const result = await nativePost(
        "/auth/email/send",
        { email, tenantId: TENANT_ID, browserBinding },
        "198.51.100.155",
      );
      expect(result.status).toBe(400);
      expect(inbox.last(email)).toBeUndefined();
    }
    const email = "code-only-browser-binding@example.test";
    expect(
      (
        await nativePost(
          "/auth/email/send",
          {
            email,
            tenantId: TENANT_ID,
            delivery: "code",
            browserBinding: binding,
          },
          "198.51.100.156",
        )
      ).status,
    ).toBe(400);
    expect(inbox.last(email)).toBeUndefined();
  });

  test("resend supersedes the whole browser binding while companion code login stays usable", async () => {
    const email = "browser-resend@example.test";
    const first = browserProof(),
      second = browserProof();
    expect(
      (
        await nativePost(
          "/auth/email/send",
          { email, tenantId: TENANT_ID, browserBinding: first.binding },
          "198.51.100.157",
        )
      ).status,
    ).toBe(200);
    const oldLink = deliveredEmailLink(email);
    expect(
      (
        await nativePost(
          "/auth/email/send",
          { email, tenantId: TENANT_ID, browserBinding: second.binding },
          "198.51.100.158",
        )
      ).status,
    ).toBe(200);
    const old = await app.request(
      `${ROUTER_ORIGIN}${oldLink.pathname}${oldLink.search}`,
    );
    expect(
      new URL(old.headers.get("location") ?? "").searchParams.get("reason"),
    ).toBe("invalid_link");
    const code = sixDigitCode(inbox.last(email)?.text ?? "");
    const login = await nativePost(
      "/auth/email/code/verify",
      { email, code, tenantId: TENANT_ID },
      "198.51.100.159",
    );
    expect(login.status).toBe(200);
    const session = await login.json();
    expect(session.ok).toBe(true);
    expect(session.data?.token ?? session.token).toBeTruthy();
    expect((await emailCallback(email)).searchParams.get("reason")).toBe(
      "invalid_link",
    );
  });

  test('delivery "code" sends a code-only email that contains no link and signs in through code verify', async () => {
    const email = "native-code@example.test";
    const sent = await nativePost(
      "/auth/email/send",
      { email, tenantId: TENANT_ID, delivery: "code" },
      "198.51.100.10",
    );
    expect(sent.status).toBe(200);
    const message = inbox.last(email);
    expect(message).toBeDefined();
    if (!message) return;
    for (const body of [message.text, message.html ?? ""]) {
      expect(body).not.toMatch(/https?:\/\//i);
      expect(body).not.toContain("/callback/email");
      expect(body).not.toMatch(/<a\s/i);
    }
    expect(message.magicLink).toBeUndefined();
    expect(message.token).toBeUndefined();

    const verify = await nativePost(
      "/auth/email/code/verify",
      { email, code: sixDigitCode(message.text), tenantId: TENANT_ID },
      "198.51.100.10",
    );
    expect(verify.status).toBe(200);
    const payload = (await verify.json()) as Record<string, unknown>;
    expect(payload.ok).not.toBe(false);
    expect(typeof payload.token).toBe("string");
  });

  test("the default delivery still sends a magic link with the code", async () => {
    const email = "browser-link@example.test";
    const sent = await nativePost(
      "/auth/email/send",
      { email, tenantId: TENANT_ID },
      "198.51.100.11",
    );
    expect(sent.status).toBe(200);
    const message = inbox.last(email);
    expect(message?.magicLink).toContain("/callback/email");
    expect(message?.text).toMatch(/\b\d{6}\b/);
  });

  test("an unknown delivery value is refused before any email is sent", async () => {
    const email = "bad-delivery@example.test";
    for (const delivery of ["link", "sms", 1, null]) {
      const response = await nativePost(
        "/auth/email/send",
        { email, tenantId: TENANT_ID, delivery },
        "198.51.100.12",
      );
      expect({ delivery, status: response.status }).toEqual({
        delivery,
        status: 400,
      });
    }
    expect(inbox.last(email)).toBeUndefined();
  });

  test("POST /email/code/send emails only a code; verify returns the Steward session connect needs", async () => {
    const email = "native-send@example.test";
    const ip = "198.51.100.20";
    const sent = await nativePost(
      "/auth/email/code/send",
      { email, tenantId: TENANT_ID },
      ip,
    );
    expect(sent.status).toBe(200);
    expect(sent.headers.get("cache-control")).toContain("no-store");
    const sentBody = (await sent.json()) as {
      ok: boolean;
      data: Record<string, unknown>;
    };
    expect(sentBody.ok).toBe(true);
    // No poll secret or challenge id: a native client never polls.
    expect(Object.keys(sentBody.data).sort()).toEqual([
      "codeLength",
      "expiresAt",
    ]);
    expect(sentBody.data.codeLength).toBe(6);
    const ttlMs = Date.parse(String(sentBody.data.expiresAt)) - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60_000);

    const message = inbox.last(email);
    expect(message).toBeDefined();
    if (!message) return;
    for (const body of [message.text, message.html ?? ""]) {
      expect(body).not.toMatch(/https?:\/\//i);
      expect(body).not.toContain("/callback/email");
      expect(body).not.toMatch(/<a\s/i);
    }
    expect(message.magicLink).toBeUndefined();
    expect(message.token).toBeUndefined();
    const code = sixDigitCode(message.text);

    const verify = await nativePost(
      "/auth/email/code/verify",
      { email, code, tenantId: TENANT_ID },
      ip,
    );
    expect(verify.status).toBe(200);
    const session = (await verify.json()) as Record<string, unknown>;
    expect(session.ok).toBe(true);
    expect(typeof session.token).toBe("string");
    expect(typeof session.refreshToken).toBe("string");
    expect(typeof session.expiresIn).toBe("number");
    expect((session.user as Record<string, unknown>).email).toBe(email);

    // Single use: the same code cannot be redeemed twice.
    const replay = await nativePost(
      "/auth/email/code/verify",
      { email, code, tenantId: TENANT_ID },
      "198.51.100.21",
    );
    expect(replay.status).toBe(401);
  });

  test("a later send supersedes the earlier code", async () => {
    const email = "native-supersede@example.test";
    await nativePost(
      "/auth/email/code/send",
      { email, tenantId: TENANT_ID },
      "198.51.100.30",
    );
    const first = sixDigitCode(inbox.last(email)?.text ?? "");
    await nativePost(
      "/auth/email/code/send",
      { email, tenantId: TENANT_ID },
      "198.51.100.30",
    );
    const second = sixDigitCode(inbox.last(email)?.text ?? "");
    if (first !== second) {
      const stale = await nativePost(
        "/auth/email/code/verify",
        { email, code: first, tenantId: TENANT_ID },
        "198.51.100.31",
      );
      expect(stale.status).toBe(401);
    }
    const fresh = await nativePost(
      "/auth/email/code/verify",
      { email, code: second, tenantId: TENANT_ID },
      "198.51.100.32",
    );
    expect(fresh.status).toBe(200);
  });

  test("wrong codes lock the challenge so the right code no longer works", async () => {
    const email = "native-lock@example.test";
    await nativePost(
      "/auth/email/code/send",
      { email, tenantId: TENANT_ID },
      "198.51.100.40",
    );
    const code = sixDigitCode(inbox.last(email)?.text ?? "");
    const wrong = code === "000000" ? "111111" : "000000";
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await nativePost(
        "/auth/email/code/verify",
        { email, code: wrong, tenantId: TENANT_ID },
        `198.51.100.${41 + attempt}`,
      );
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 4)).toEqual([401, 401, 401, 401]);
    expect(statuses[4]).toBe(429);
    const late = await nativePost(
      "/auth/email/code/verify",
      { email, code, tenantId: TENANT_ID },
      "198.51.100.49",
    );
    expect(late.status).not.toBe(200);
  });

  test("the per-address budget is shared with /email/send", async () => {
    await withDatabaseLimiter(async () => {
      const email = "native-budget@example.test";
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const path =
          attempt % 2 === 0 ? "/auth/email/send" : "/auth/email/code/send";
        const response = await nativePost(
          path,
          { email, tenantId: TENANT_ID },
          `198.51.100.${60 + attempt}`,
        );
        statuses.push(response.status);
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    });
  }, 60_000);

  test("malformed bodies are refused before any email is sent", async () => {
    const email = "native-malformed@example.test";
    for (const body of [
      {},
      { email: "" },
      { email: 42 },
      { email, tenantId: 7 },
      { email, captchaToken: {} },
    ]) {
      const response = await nativePost(
        "/auth/email/code/send",
        body,
        "198.51.100.70",
      );
      expect(response.status).toBe(400);
    }
    expect(inbox.last(email)).toBeUndefined();
  });

  test("the tenant-wide code email ceiling stops a flood across addresses and IPs", async () => {
    await withDatabaseLimiter(async () => {
      const statuses: number[] = [];
      for (let index = 0; index < 121; index += 1) {
        const response = await nativePost(
          "/auth/email/code/send",
          { email: `flood-${index}@example.test`, tenantId: TENANT_ID },
          `203.0.113.${index}`,
        );
        statuses.push(response.status);
      }
      // The per-address test above already spent a couple of this minute's
      // tenant budget, so the ceiling (120/min) arrives a little early. Once
      // it is reached, every further send is refused and nothing is mailed.
      const firstRefused = statuses.indexOf(429);
      expect(firstRefused).toBeGreaterThan(110);
      expect(firstRefused).toBeLessThanOrEqual(120);
      expect(statuses.slice(0, firstRefused).every((s) => s === 200)).toBe(
        true,
      );
      expect(statuses.slice(firstRefused).every((s) => s === 429)).toBe(true);
      expect(inbox.last("flood-120@example.test")).toBeUndefined();
    });
  }, 120_000);

  test("code send is rate limited per client address", async () => {
    await withDatabaseLimiter(async () => {
      const statuses: number[] = [];
      for (let index = 0; index < 31; index += 1) {
        const response = await nativePost(
          "/auth/email/code/send",
          {
            email: `per-ip-${index}@example.test`,
            tenantId: "unknown-tenant-for-ip-budget",
          },
          "192.0.2.77",
        );
        statuses.push(response.status);
      }
      // The per-IP limiter runs before any tenant work, so it answers 429 on
      // the 31st request whatever the body says.
      expect(statuses[30]).toBe(429);
      expect(statuses.slice(0, 30).includes(429)).toBe(false);
    });
  }, 60_000);
});
