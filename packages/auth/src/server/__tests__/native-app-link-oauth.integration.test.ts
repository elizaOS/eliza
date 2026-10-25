/**
 * Native in-app sign-in through a verified https App Link (Alpha Phone).
 *
 * Drives the real identity router and PGlite store end to end: a native caller
 * with no browser Origin starts Google authorization against the App Link
 * redirect, the (synthetic) provider round trip lands on Steward's callback,
 * Steward hands a one-time code back to the App Link, and the device redeems
 * it with its PKCE verifier. Provider HTTP calls are answered in-process by a
 * synthetic Google/Discord; no real account or credential is used.
 */
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { createLoginApp } from "../app";
import type { createPGLiteDb } from "../db/pglite";

const TENANT_ID = "elizacloud";
const APP_LINK = "https://eliza.app/alphaphone/auth/callback";
// Public base the Cloud API proxies to Steward; the router itself is unprefixed.
const STEWARD_ORIGIN = "https://api.eliza.app/steward";
const ROUTER_ORIGIN = "https://login.internal";

type Identity = Record<string, unknown>;
const identities = new Map<string, Identity>();
const realFetch = globalThis.fetch;
const PROVIDER_TOKEN_URLS = new Set([
  "https://oauth2.googleapis.com/token",
  "https://discord.com/api/oauth2/token",
]);
const PROVIDER_USERINFO_URLS = new Set([
  "https://www.googleapis.com/oauth2/v3/userinfo",
  "https://discord.com/api/users/@me",
]);
let app: ReturnType<typeof createLoginApp>;
let database: Awaited<ReturnType<typeof createPGLiteDb>>;
const previous = new Map<string, string | undefined>();

const base64url = (bytes: Buffer) => bytes.toString("base64url");
const s256 = (verifier: string) =>
  createHash("sha256").update(verifier).digest("base64url");

beforeAll(async () => {
  // Synthetic provider: the token endpoint hands out an access token naming
  // the identity queued under the authorization code; userinfo returns it.
  // Only the provider endpoints are intercepted.
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (PROVIDER_TOKEN_URLS.has(request.url)) {
      const body = new URLSearchParams(await request.text());
      const code = body.get("code") ?? "";
      if (!identities.has(code))
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: `at-${code}`,
        token_type: "Bearer",
      });
    }
    if (PROVIDER_USERINFO_URLS.has(request.url)) {
      const token = (request.headers.get("authorization") ?? "").replace(
        /^Bearer at-/,
        "",
      );
      const identity = identities.get(token);
      return identity
        ? Response.json(identity)
        : Response.json({ error: "invalid_token" }, { status: 401 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const environment: Record<string, string> = {
    NODE_ENV: "test",
    STEWARD_DB_MODE: "pglite",
    STEWARD_PGLITE_MEMORY: "true",
    STEWARD_MASTER_PASSWORD: randomBytes(32).toString("hex"),
    STEWARD_JWT_SECRET: randomBytes(32).toString("hex"),
    STEWARD_KDF_SALT: randomBytes(32).toString("hex"),
    STEWARD_AUDIT_HMAC_KEY: randomBytes(32).toString("hex"),
    APP_URL: STEWARD_ORIGIN,
    GOOGLE_CLIENT_ID: "synthetic-google-web-client",
    GOOGLE_CLIENT_SECRET: "synthetic-google-secret",
    DISCORD_CLIENT_ID: "synthetic-discord-client",
    DISCORD_CLIENT_SECRET: "synthetic-discord-secret",
  };
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  for (const key of [
    "GOOGLE_AUTHORIZATION_URL",
    "GOOGLE_TOKEN_URL",
    "GOOGLE_USERINFO_URL",
    "DISCORD_AUTHORIZATION_URL",
    "DISCORD_TOKEN_URL",
    "DISCORD_USERINFO_URL",
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
  const { tenants, tenantConfigs } = await import("../db/schema");
  await database.db.insert(tenants).values({
    id: TENANT_ID,
    name: "Synthetic Eliza Cloud",
    apiKeyHash: randomBytes(32).toString("hex"),
  });
  await database.db.insert(tenantConfigs).values({
    tenantId: TENANT_ID,
    allowedRedirectUrls: [APP_LINK],
    // Eliza Cloud accepts new members on first sign-in.
    joinMode: "open",
  });
  const { createLoginApp } = await import("../app");
  app = createLoginApp();
}, 60_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (database) await database.client.close();
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A native request: no Origin, no Referer, no cookies. */
function nativeGet(path: string) {
  return app.request(`${ROUTER_ORIGIN}${path}`, { method: "GET" });
}
function nativePost(path: string, body: object) {
  return app.request(`${ROUTER_ORIGIN}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authorizeQuery(overrides: Record<string, string | null> = {}) {
  const params = new URLSearchParams({
    response_type: "code",
    tenant_id: TENANT_ID,
    redirect_uri: APP_LINK,
    code_challenge: s256(base64url(randomBytes(48))),
    code_challenge_method: "S256",
    state: base64url(randomBytes(32)),
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  return params;
}

/** Runs authorize → provider → Steward callback and returns the App Link hand-off. */
async function completeProviderRoundTrip(
  provider: "google" | "discord",
  identity: Identity,
  options: { prompt?: string } = {},
) {
  const verifier = base64url(randomBytes(48));
  const appState = base64url(randomBytes(32));
  const query = authorizeQuery({
    code_challenge: s256(verifier),
    state: appState,
    ...(options.prompt ? { prompt: options.prompt } : {}),
  });
  const authorize = await nativeGet(
    `/auth/oauth/${provider}/authorize?${query}`,
  );
  expect(authorize.status).toBe(302);
  const providerUrl = new URL(authorize.headers.get("location") ?? "");
  const providerCode = base64url(randomBytes(16));
  identities.set(providerCode, identity);
  const callback = await nativeGet(
    `/auth/oauth/${provider}/callback?code=${providerCode}&state=${providerUrl.searchParams.get("state")}`,
  );
  expect(callback.status).toBe(302);
  const handOff = new URL(callback.headers.get("location") ?? "");
  return { providerUrl, handOff, verifier, appState };
}

function readHandOff(handOff: URL) {
  const fragment = new URLSearchParams(handOff.hash.slice(1));
  return { code: fragment.get("code") ?? "", state: fragment.get("state") };
}

describe("native App Link OAuth (Alpha Phone)", () => {
  test("authorize forwards prompt=select_account to Google and accepts no Origin", async () => {
    const appState = base64url(randomBytes(32));
    const response = await nativeGet(
      `/auth/oauth/google/authorize?${authorizeQuery({ state: appState, prompt: "select_account" })}`,
    );
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(`${location.origin}${location.pathname}`).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(location.searchParams.get("prompt")).toBe("select_account");
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${STEWARD_ORIGIN}/auth/oauth/google/callback`,
    );
    // Steward's own CSRF state goes to Google; the app's state never does.
    expect(location.searchParams.get("state")).not.toBe(appState);
    expect(location.toString()).not.toContain("synthetic-google-secret");
  });

  test("authorize rejects unsupported prompts, custom schemes and unlisted redirects", async () => {
    const cases: Array<[string, Record<string, string | null>]> = [
      ["google", { prompt: "none" }],
      ["google", { prompt: "login" }],
      ["discord", { prompt: "select_account" }],
      ["google", { redirect_uri: "alphaphone://auth/callback" }],
      ["google", { redirect_uri: "https://eliza.app/alphaphone/auth/other" }],
      [
        "google",
        { redirect_uri: "https://evil.example/alphaphone/auth/callback" },
      ],
      ["google", { redirect_uri: `${APP_LINK}?extra=1` }],
      ["google", { code_challenge: null }],
      ["google", { code_challenge_method: "plain" }],
    ];
    for (const [provider, overrides] of cases) {
      const response = await nativeGet(
        `/auth/oauth/${provider}/authorize?${authorizeQuery(overrides)}`,
      );
      expect({ overrides, status: response.status }).toEqual({
        overrides,
        status: 400,
      });
    }
  });

  test("Google round trip returns code+state to the App Link and redeems once with the verifier", async () => {
    const identity = {
      sub: "google-sub-owner",
      email: "owner@example.test",
      email_verified: true,
      name: "Synthetic Owner",
    };
    const { handOff, verifier, appState } = await completeProviderRoundTrip(
      "google",
      identity,
      { prompt: "select_account" },
    );
    expect(`${handOff.origin}${handOff.pathname}`).toBe(APP_LINK);
    expect(handOff.search).toBe("");
    const { code, state } = readHandOff(handOff);
    expect(state).toBe(appState);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Wrong verifier, redirect or tenant cannot redeem the code...
    for (const body of [
      {
        code,
        redirectUri: APP_LINK,
        tenantId: TENANT_ID,
        codeVerifier: base64url(randomBytes(48)),
      },
      {
        code,
        redirectUri: "https://eliza.app/auth/callback",
        tenantId: TENANT_ID,
        codeVerifier: verifier,
      },
      {
        code,
        redirectUri: APP_LINK,
        tenantId: "other-tenant",
        codeVerifier: verifier,
      },
      { code, redirectUri: APP_LINK, tenantId: TENANT_ID },
    ]) {
      const rejected = await nativePost("/auth/oauth/exchange", body);
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      expect(rejected.status).toBeLessThan(500);
    }

    const exchange = await nativePost("/auth/oauth/exchange", {
      code,
      redirectUri: APP_LINK,
      tenantId: TENANT_ID,
      codeVerifier: verifier,
    });
    const payload = await exchange.json();
    expect(exchange.status).toBe(200);
    expect(typeof payload.token).toBe("string");
    const { verifyToken } = await import("../auth/jwt");
    const claims = await verifyToken(payload.token);
    expect(claims.tenantId).toBe(TENANT_ID);
    expect(claims.email).toBe("owner@example.test");

    // ...and the legitimate redemption is single-use.
    const replay = await nativePost("/auth/oauth/exchange", {
      code,
      redirectUri: APP_LINK,
      tenantId: TENANT_ID,
      codeVerifier: verifier,
    });
    expect(replay.status).toBe(401);
  }, 30_000);

  test("a provider callback cannot be replayed into a second hand-off", async () => {
    const appState = base64url(randomBytes(32));
    const authorize = await nativeGet(
      `/auth/oauth/google/authorize?${authorizeQuery({ state: appState })}`,
    );
    const stewardState = new URL(
      authorize.headers.get("location") ?? "",
    ).searchParams.get("state");
    const providerCode = base64url(randomBytes(16));
    identities.set(providerCode, {
      sub: "google-sub-replay",
      email: "replay@example.test",
      email_verified: true,
    });
    const first = await nativeGet(
      `/auth/oauth/google/callback?code=${providerCode}&state=${stewardState}`,
    );
    expect(first.status).toBe(302);
    const second = await nativeGet(
      `/auth/oauth/google/callback?code=${providerCode}&state=${stewardState}`,
    );
    expect(second.status).toBeGreaterThanOrEqual(400);
    expect(second.headers.get("location")).toBeNull();
  }, 30_000);

  test("an unverified Google email is refused before any code reaches the app", async () => {
    const authorize = await nativeGet(
      `/auth/oauth/google/authorize?${authorizeQuery()}`,
    );
    const stewardState = new URL(
      authorize.headers.get("location") ?? "",
    ).searchParams.get("state");
    const providerCode = base64url(randomBytes(16));
    identities.set(providerCode, {
      sub: "google-sub-unverified",
      email: "unverified@example.test",
      email_verified: false,
    });
    const callback = await nativeGet(
      `/auth/oauth/google/callback?code=${providerCode}&state=${stewardState}`,
    );
    expect(callback.status).toBe(403);
    expect(callback.headers.get("location")).toBeNull();
    const rows = await database.client.query<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = $1",
      ["unverified@example.test"],
    );
    expect(rows.rows).toHaveLength(0);
  }, 30_000);

  test("a second provider with the same verified email links to the existing user", async () => {
    const email = "linked@example.test";
    const google = await completeProviderRoundTrip("google", {
      sub: "google-sub-linked",
      email,
      email_verified: true,
    });
    const googleCode = readHandOff(google.handOff).code;
    const googleSession = await (
      await nativePost("/auth/oauth/exchange", {
        code: googleCode,
        redirectUri: APP_LINK,
        tenantId: TENANT_ID,
        codeVerifier: google.verifier,
      })
    ).json();

    const discord = await completeProviderRoundTrip("discord", {
      id: "discord-id-linked",
      email,
      verified: true,
      username: "linked",
    });
    const discordCode = readHandOff(discord.handOff).code;
    const discordSession = await (
      await nativePost("/auth/oauth/exchange", {
        code: discordCode,
        redirectUri: APP_LINK,
        tenantId: TENANT_ID,
        codeVerifier: discord.verifier,
      })
    ).json();

    expect(googleSession.user?.id).toBeTruthy();
    expect(discordSession.user?.id).toBe(googleSession.user?.id);
    const users = await database.client.query<{ id: string }>(
      "SELECT id FROM users WHERE lower(email) = $1",
      [email],
    );
    expect(users.rows).toEqual([{ id: googleSession.user.id }]);
  }, 30_000);

  test("a hand-off code expires and cannot be redeemed late", async () => {
    const { handOff, verifier } = await completeProviderRoundTrip("google", {
      sub: "google-sub-expired",
      email: "expired@example.test",
      email_verified: true,
    });
    const { code } = readHandOff(handOff);
    setSystemTime(new Date(Date.now() + 10 * 60_000));
    try {
      const late = await nativePost("/auth/oauth/exchange", {
        code,
        redirectUri: APP_LINK,
        tenantId: TENANT_ID,
        codeVerifier: verifier,
      });
      expect(late.status).toBe(401);
    } finally {
      setSystemTime();
    }
  }, 30_000);

  test("mfa=exchange returns a TOTP account's challenge through the PKCE exchange", async () => {
    const identity = {
      sub: "google-sub-mfa",
      email: "mfa-owner@example.test",
      email_verified: true,
    };
    // Sign in once and enrol TOTP through the real endpoints.
    const first = await completeProviderRoundTrip("google", identity);
    const firstCode = readHandOff(first.handOff).code;
    const session = await (
      await nativePost("/auth/oauth/exchange", {
        code: firstCode,
        redirectUri: APP_LINK,
        tenantId: TENANT_ID,
        codeVerifier: first.verifier,
      })
    ).json();
    const bearer = (path: string, body: object) =>
      app.request(`${ROUTER_ORIGIN}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`,
        },
        body: JSON.stringify(body),
      });
    const enrol = await bearer("/auth/mfa/totp/enroll", {});
    expect(enrol.status).toBe(200);
    const { secret } = (await enrol.json()) as { secret: string };
    const { generateTotp } = await import("../auth/totp");
    const confirm = await bearer("/auth/mfa/totp/verify", {
      code: await generateTotp(secret),
    });
    expect(confirm.status).toBe(200);

    // Without the opt-in the account still gets Steward's error response.
    const legacyVerifier = base64url(randomBytes(48));
    const legacyAuthorize = await nativeGet(
      `/auth/oauth/google/authorize?${authorizeQuery({ code_challenge: s256(legacyVerifier) })}`,
    );
    const legacyProviderCode = base64url(randomBytes(16));
    identities.set(legacyProviderCode, identity);
    const legacy = await nativeGet(
      `/auth/oauth/google/callback?code=${legacyProviderCode}&state=${new URL(legacyAuthorize.headers.get("location") ?? "").searchParams.get("state")}`,
    );
    expect(legacy.status).toBe(403);
    expect(legacy.headers.get("location")).toBeNull();

    // With mfa=exchange the app gets a contract success return...
    const verifier = base64url(randomBytes(48));
    const appState = base64url(randomBytes(32));
    const authorize = await nativeGet(
      `/auth/oauth/google/authorize?${authorizeQuery({
        code_challenge: s256(verifier),
        state: appState,
        prompt: "select_account",
        mfa: "exchange",
      })}`,
    );
    expect(authorize.status).toBe(302);
    const providerCode = base64url(randomBytes(16));
    identities.set(providerCode, identity);
    const callback = await nativeGet(
      `/auth/oauth/google/callback?code=${providerCode}&state=${new URL(authorize.headers.get("location") ?? "").searchParams.get("state")}`,
    );
    expect(callback.status).toBe(302);
    const handOff = callback.headers.get("location") ?? "";
    const outcome = classifyCallback(handOff, "production");
    expect(outcome).toMatchObject({ kind: "success", state: appState });
    const code = outcome.kind === "success" ? outcome.code : "";

    // ...whose code still needs the verifier, and redeems to the challenge only.
    const wrong = await nativePost("/auth/oauth/exchange", {
      code,
      redirectUri: APP_LINK,
      tenantId: TENANT_ID,
      codeVerifier: base64url(randomBytes(48)),
    });
    expect(wrong.status).toBe(401);
    const exchange = await nativePost("/auth/oauth/exchange", {
      code,
      redirectUri: APP_LINK,
      tenantId: TENANT_ID,
      codeVerifier: verifier,
    });
    expect(exchange.status).toBe(200);
    const challenge = (await exchange.json()) as Record<string, unknown>;
    expect(challenge.mfaRequired).toBe(true);
    expect(challenge.token).toBeUndefined();
    expect(challenge.refreshToken).toBeUndefined();
    const mfa = challenge.mfa as { type: string; challengeId: string };
    expect(mfa.type).toBe("totp");

    const complete = await nativePost("/auth/mfa/totp/complete", {
      challengeId: mfa.challengeId,
      code: await generateTotp(secret, { time: Date.now() + 30_000 }),
    });
    expect(complete.status).toBe(200);
    const completed = (await complete.json()) as Record<string, unknown>;
    expect(typeof completed.token).toBe("string");

    const replay = await nativePost("/auth/oauth/exchange", {
      code,
      redirectUri: APP_LINK,
      tenantId: TENANT_ID,
      codeVerifier: verifier,
    });
    expect(replay.status).toBe(401);
  }, 30_000);

  test("authorize refuses an unknown mfa mode", async () => {
    const response = await nativeGet(
      `/auth/oauth/google/authorize?${authorizeQuery({ mfa: "inline" })}`,
    );
    expect(response.status).toBe(400);
  });

  test("authorize is rate limited per client address", async () => {
    const priorProxyHops = process.env.STEWARD_TRUSTED_PROXY_HOPS;
    process.env.STEWARD_TRUSTED_PROXY_HOPS = "1";
    // The production limiter, persisted in this test's database.
    const { setDatabaseAuthRateLimiter } = await import(
      "../api/services/auth-rate-limit"
    );
    const { checkDatabaseAuthRateLimit } = await import(
      "../auth/database-rate-limit"
    );
    setDatabaseAuthRateLimiter(checkDatabaseAuthRateLimit);
    try {
      const fromAddress = (address: string) =>
        app.request(
          `${ROUTER_ORIGIN}/auth/oauth/google/authorize?${authorizeQuery()}`,
          { method: "GET", headers: { "x-forwarded-for": address } },
        );
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 31; attempt += 1) {
        statuses.push((await fromAddress("203.0.113.7")).status);
      }
      expect(statuses.slice(0, 30).every((status) => status === 302)).toBe(
        true,
      );
      expect(statuses[30]).toBe(429);
      // Another device keeps its own budget.
      expect((await fromAddress("198.51.100.9")).status).toBe(302);
    } finally {
      setDatabaseAuthRateLimiter(undefined);
      if (priorProxyHops === undefined)
        delete process.env.STEWARD_TRUSTED_PROXY_HOPS;
      else process.env.STEWARD_TRUSTED_PROXY_HOPS = priorProxyHops;
    }
  }, 30_000);
});

// ── Shared callback contract with Alpha Phone ────────────────────────────────
//
// packages/app/test/fixtures/alphaphone-native-signin-callback.contract.json
// is committed byte for byte in AlphaCompute/alphaphone, whose native parser
// runs the same vectors. These tests feed Steward's real hand-offs (success
// and the error page's recovery link) through the fixture's rules and keep
// its error allowlist in step with the codes Steward can return to the app.

type ContractEnv = "production" | "staging";
type ContractOutcome =
  | { kind: "success"; code: string; state: string }
  | { kind: "error"; error: string; state: string }
  | { kind: "empty" }
  | { kind: "reject" };
const contract = JSON.parse(
  readFileSync(
    new URL(
      "../../../../app/test/fixtures/alphaphone-native-signin-callback.contract.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  hosts: Record<ContractEnv, string>;
  path: string;
  allowedKeys: string[];
  codePattern: string;
  statePattern: string;
  errorAllowlist: string[];
  stewardCodesWithoutReturn: string[];
  authorize: {
    requiredParams: Record<string, string>;
    redirectUri: Record<ContractEnv, string>;
  };
  cases: {
    name: string;
    env: ContractEnv;
    url: string;
    expect: ContractOutcome;
  }[];
};

/** The fixture's `rules`, applied to the raw URL text (same as Alpha's parser). */
function classifyCallback(url: string, env: ContractEnv): ContractOutcome {
  const reject: ContractOutcome = { kind: "reject" };
  const base = `https://${contract.hosts[env]}${contract.path}`;
  if (!url.startsWith(base)) return reject;
  const rest = url.slice(base.length);
  let query = "";
  let fragment = "";
  if (rest.startsWith("?")) {
    const hash = rest.indexOf("#");
    query = hash === -1 ? rest.slice(1) : rest.slice(1, hash);
    fragment = hash === -1 ? "" : rest.slice(hash + 1);
  } else if (rest.startsWith("#")) {
    fragment = rest.slice(1);
  } else if (rest !== "") {
    return reject;
  }
  if (query === "" && fragment === "") return { kind: "empty" };
  if (query !== "" && fragment !== "") return reject;
  const values = new Map<string, string>();
  for (const pair of (query || fragment).split("&")) {
    const separator = pair.indexOf("=");
    if (separator <= 0 || pair.indexOf("=", separator + 1) !== -1)
      return reject;
    const key = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!contract.allowedKeys.includes(key) || value === "" || values.has(key))
      return reject;
    values.set(key, value);
  }
  const state = values.get("state");
  if (
    values.size !== 2 ||
    !state ||
    !new RegExp(contract.statePattern).test(state)
  )
    return reject;
  const code = values.get("code");
  if (code !== undefined) {
    return fragment !== "" && new RegExp(contract.codePattern).test(code)
      ? { kind: "success", code, state }
      : reject;
  }
  const error = values.get("error");
  return error !== undefined && contract.errorAllowlist.includes(error)
    ? { kind: "error", error, state }
    : reject;
}

describe("Alpha Phone callback contract (shared fixture)", () => {
  test("the reference classifier matches every fixture vector", () => {
    expect(contract.authorize.redirectUri.production).toBe(APP_LINK);
    for (const entry of contract.cases) {
      expect({
        name: entry.name,
        outcome: classifyCallback(entry.url, entry.env),
      }).toEqual({ name: entry.name, outcome: entry.expect });
    }
  });

  test("authorize accepts exactly the parameters the contract makes Alpha send", async () => {
    const query = authorizeQuery(contract.authorize.requiredParams);
    const response = await nativeGet(`/auth/oauth/google/authorize?${query}`);
    expect(response.status).toBe(302);
    const provider = new URL(response.headers.get("location") ?? "");
    expect(provider.searchParams.get("prompt")).toBe("select_account");
  });

  test("Steward's success hand-off is a contract success return", async () => {
    const { handOff, appState } = await completeProviderRoundTrip(
      "google",
      {
        sub: "google-sub-contract",
        email: "contract@example.test",
        email_verified: true,
      },
      { prompt: "select_account" },
    );
    const outcome = classifyCallback(handOff.toString(), "production");
    expect(outcome.kind).toBe("success");
    expect(outcome).toMatchObject({ state: appState });
  }, 30_000);

  test("Steward's error page links back with a contract error return", async () => {
    const appState = base64url(randomBytes(32));
    const authorize = await nativeGet(
      `/auth/oauth/google/authorize?${authorizeQuery({ state: appState, prompt: "select_account" })}`,
    );
    expect(authorize.status).toBe(302);
    const stewardState = new URL(
      authorize.headers.get("location") ?? "",
    ).searchParams.get("state");
    const page = await app.request(
      `${ROUTER_ORIGIN}/auth/oauth/google/callback?error=access_denied&state=${stewardState}`,
      {
        method: "GET",
        headers: { accept: "text/html", "sec-fetch-mode": "navigate" },
      },
    );
    expect(page.status).toBe(400);
    const html = await page.text();
    const href = html.match(
      /class="stwd-oauth-error__action" href="([^"]+)"/,
    )?.[1];
    expect(href).toBeDefined();
    const recovery = (href ?? "").replaceAll("&amp;", "&");
    expect(classifyCallback(recovery, "production")).toEqual({
      kind: "error",
      error: "oauth_authorization_failed",
      state: appState,
    });
  }, 30_000);

  test("every code the OAuth callback can return to the app is in the allowlist", () => {
    const source = readFileSync(
      new URL("../api/routes/auth.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf('auth.get("/oauth/:provider/callback"');
    const end = source.indexOf('auth.post("/oauth/exchange"', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const handler = source.slice(start, end);
    const calls = handler.split("oauthCallbackFailure(c, {").slice(1);
    expect(calls.length).toBeGreaterThan(10);
    const returned = new Set<string>();
    const notReturned = new Set<string>();
    for (const call of calls) {
      const body = call.slice(0, call.indexOf("});"));
      const codes = [...body.matchAll(/"((?:oauth|mfa)_[a-z_]+)"/g)].map(
        (match) => match[1],
      );
      expect(codes.length).toBeGreaterThan(0);
      const returnsToApp = /\bredirectUrl\b|\.\.\.recovery/.test(body);
      for (const code of codes)
        (returnsToApp ? returned : notReturned).add(code);
    }
    for (const code of returned) {
      expect({
        code,
        allowlisted: contract.errorAllowlist.includes(code),
      }).toEqual({ code, allowlisted: true });
    }
    for (const code of notReturned) {
      expect({
        code,
        classified:
          contract.errorAllowlist.includes(code) ||
          contract.stewardCodesWithoutReturn.includes(code),
      }).toEqual({ code, classified: true });
    }
  });
});
