import { beforeEach, expect, mock, test } from "bun:test";
import * as realCloudBindings from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import { MobileAppAuthProtocolError } from "@elizaos/cloud-shared/lib/services/mobile-app-auth";

const REGISTRATION = {
  appId: "0f8fad5b-d9cb-469f-a165-70867728950e",
  clientId: "ai.elizaresearch.alphaphone",
  environment: "production" as const,
  redirectUri: "https://eliza.app/alphaphone/auth/callback",
  scopes: ["cloud:user"] as const,
  credentialTtlSeconds: 2_592_000,
};
const realBindings = { ...realCloudBindings };
mock.module("@elizaos/cloud-shared/lib/runtime/cloud-bindings", () => ({
  ...realBindings,
  getCloudAwareEnv: () => ({
    GOOGLE_CLIENT_ID: "123456-webclient.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "secret",
  }),
}));
mock.module("../_registration", () => ({
  requireRegisteredMobileApp: async (_c: unknown, clientId: string) => {
    if (clientId !== REGISTRATION.clientId)
      throw new MobileAppAuthProtocolError(
        "invalid_client",
        "Unknown mobile App Auth client",
      );
    return { app: { id: REGISTRATION.appId }, registration: REGISTRATION };
  },
}));
mock.module("../_rate-limit", () => ({
  MOBILE_APP_AUTH_TOKEN_RATE_LIMIT: {},
  mobileAppAuthRateLimitMiddleware:
    () => async (_c: unknown, next: () => Promise<void>) =>
      next(),
  runMobileAppAuthGrantAdmission: async (
    _c: unknown,
    _userId: string,
    create: () => Promise<Response>,
  ) => create(),
}));

const { createMobileGoogleSignInRoute, idTokenSubject } = await import(
  "./route"
);
type Deps = Parameters<typeof createMobileGoogleSignInRoute>[0] & object;

const encode = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const ID_TOKEN = `${encode({ alg: "RS256" })}.${encode({ sub: "109876543210", email: "owner@example.com" })}.signature`;
const VERIFIER = "v".repeat(43);
const STATE = "s".repeat(43);
const BODY = {
  clientId: REGISTRATION.clientId,
  environment: "production",
  redirectUri: REGISTRATION.redirectUri,
  state: STATE,
  codeVerifier: VERIFIER,
  deviceName: "Alpha Phone",
  steward: {
    clientId: "alphaphone-android",
    challengeId: "c".repeat(43),
    idToken: ID_TOKEN,
    codeVerifier: "w".repeat(43),
  },
  serverAuthCode: "4/0AeaYSHnative",
};
const ENV = {
  ENVIRONMENT: "production",
  STEWARD_SESSION_SECRET: "session-secret",
  STEWARD_TENANT_ID: "elizacloud",
};
const CREDENTIAL = {
  credentialId: "6f9619ff-8b86-d011-b42d-00cf4fc964ff",
  secret: `eliza_mobile_${"a".repeat(64)}`,
  tokenType: "Bearer" as const,
  expiresAt: "2026-12-06T00:00:00.000Z",
  expiresIn: 2_592_000,
  scopes: ["cloud:user"],
  acknowledgementRequired: true as const,
  acknowledgeBy: "2026-11-06T00:05:00.000Z",
};

let events: string[];
let deps: Deps;
let googleCalls: Array<Record<string, unknown>>;
let ownerCalls: Array<Record<string, unknown>>;
let logoutCalls: unknown[][];

beforeEach(() => {
  events = [];
  googleCalls = [];
  ownerCalls = [];
  logoutCalls = [];
  deps = {
    stewardVerify: async (_c, steward) => {
      events.push(`verify:${steward.challengeId.slice(0, 1)}`);
      return {
        kind: "ok",
        token: "steward-jwt",
        refreshToken: "steward-refresh",
      };
    },
    stewardLogout: async (_c, token, refresh) => {
      events.push("logout");
      logoutCalls.push([token, refresh]);
    },
    verifyToken: (async () => ({
      userId: "steward-user-1",
      email: "owner@example.com",
      expiration: 0,
      issuedAt: 0,
    })) as unknown as Deps["verifyToken"],
    syncUser: (async () => {
      events.push("sync");
      return { id: "user-1", organization_id: "org-1", accountCreated: true };
    }) as unknown as Deps["syncUser"],
    connectUser: (async () => {
      events.push("connect");
      return "connected";
    }) as unknown as Deps["connectUser"],
    issueCode: (async (input: { binding: { codeChallenge: string } }) => {
      events.push(`issue:${input.binding.codeChallenge.length}`);
      return { code: "emac_code", expiresAt: "x", expiresIn: 300 };
    }) as unknown as Deps["issueCode"],
    exchangeCode: (async (input: { code: string; codeVerifier: string }) => {
      events.push(`exchange:${input.code}:${input.codeVerifier === VERIFIER}`);
      return CREDENTIAL;
    }) as unknown as Deps["exchangeCode"],
    requireOwner: (async (input: Record<string, unknown>) => {
      ownerCalls.push(input);
    }) as unknown as Deps["requireOwner"],
    exchangeGoogle: (async (
      _provider: unknown,
      input: Record<string, unknown>,
    ) => {
      events.push("google");
      googleCalls.push(input);
      return {
        connectionId: "conn-1",
        organizationId: "org-1",
        userId: "user-1",
        platformUserId: "109876543210",
        email: "owner@example.com",
        scopes: ["https://www.googleapis.com/auth/gmail.modify"],
        refreshTokenIssued: true,
      };
    }) as unknown as Deps["exchangeGoogle"],
    googleProvider: () =>
      ({
        id: "google",
        envVars: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
        defaultScopes: [
          "openid",
          "https://www.googleapis.com/auth/gmail.modify",
        ],
      }) as unknown as ReturnType<Deps["googleProvider"]>,
    invalidate: async () => {
      events.push("invalidate");
    },
    admitGrant: (async (
      _c: unknown,
      _u: string,
      create: () => Promise<Response>,
    ) => create()) as unknown as Deps["admitGrant"],
  };
});

const post = (body: unknown, routeDeps: Deps = deps) =>
  createMobileGoogleSignInRoute(routeDeps).request(
    "/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.9",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    ENV,
  );
// biome-ignore lint/suspicious/noExplicitAny: assertions read nested JSON fields.
type Json = Record<string, any>;
const json = async (response: Response) => (await response.json()) as Json;

test("one call signs in, issues the inactive mobile key and connects the same Google account", async () => {
  const response = await post(BODY);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await json(response);
  expect(body).toMatchObject({
    success: true,
    status: "signed_in",
    ...CREDENTIAL,
    code: "emac_code",
    accountCreated: true,
    google: {
      connected: true,
      connectionId: "conn-1",
      email: "owner@example.com",
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
      refreshTokenIssued: true,
    },
  });
  expect(events).toEqual([
    "verify:c",
    "sync",
    "connect",
    "issue:43",
    "exchange:emac_code:true",
    "google",
    "invalidate",
    "logout",
  ]);
  expect(googleCalls[0]).toEqual({
    organizationId: "org-1",
    userId: "user-1",
    serverAuthCode: "4/0AeaYSHnative",
    expectedPlatformUserId: "109876543210",
  });
  expect(ownerCalls[0]).toMatchObject({
    userId: "user-1",
    organizationId: "org-1",
    authMethod: "session",
  });
  expect(logoutCalls).toEqual([["steward-jwt", "steward-refresh"]]);
});

test("without a server auth code the sign-in stands alone", async () => {
  const { serverAuthCode: _omit, ...withoutGoogle } = BODY;
  const body = await json(await post(withoutGoogle));
  expect(body.status).toBe("signed_in");
  expect(body.google).toBeUndefined();
  expect(events).not.toContain("google");
});

test("a Google failure never fails the sign-in", async () => {
  for (const [failure, code] of [
    ["GOOGLE_SERVER_AUTH_CODE_ACCOUNT_MISMATCH", "google_account_mismatch"],
    ["GOOGLE_GRANTED_SCOPES_REQUIRED", "google_scopes_missing"],
    ["Token exchange failed: 400", "google_code_rejected"],
    ["Token exchange failed: 503", "google_unavailable"],
  ]) {
    const body = await json(
      await post(BODY, {
        ...deps,
        exchangeGoogle: (async () => {
          throw new Error(failure);
        }) as unknown as Deps["exchangeGoogle"],
      }),
    );
    expect(body.status).toBe("signed_in");
    expect(body.secret).toBe(CREDENTIAL.secret);
    expect(body.google).toEqual({ connected: false, code });
  }
  const notOwner = await json(
    await post(BODY, {
      ...deps,
      requireOwner: (async () => {
        throw new Error("forbidden");
      }) as unknown as Deps["requireOwner"],
    }),
  );
  expect(notOwner.google).toEqual({ connected: false, code: "owner_required" });
  expect(events).not.toContain("google");
  const unknownAccount = await json(
    await post({
      ...BODY,
      steward: { ...BODY.steward, idToken: "not-a-jwt-token-at-all" },
    }),
  );
  expect(unknownAccount.google).toEqual({
    connected: false,
    code: "google_account_unknown",
  });
});

test("a refused or second-factor identity issues no key; the Steward session always ends", async () => {
  const rejected = await post(BODY, {
    ...deps,
    stewardVerify: async () => ({ kind: "rejected", status: 401 }),
  });
  expect(rejected.status).toBe(401);
  expect((await json(rejected)).error).toBe("google_identity_rejected");
  const down = await post(BODY, {
    ...deps,
    stewardVerify: async () => ({ kind: "unavailable" }),
  });
  expect(down.status).toBe(502);
  expect((await json(down)).retryable).toBe(true);
  const mfa = await json(
    await post(BODY, {
      ...deps,
      stewardVerify: async () => ({
        kind: "mfa",
        mfa: { type: "totp", challengeId: "m1" },
      }),
    }),
  );
  expect(mfa).toEqual({
    success: true,
    status: "mfa_required",
    mfa: { type: "totp", challengeId: "m1" },
  });
  expect(events).not.toContain("issue:43");
  expect(logoutCalls).toHaveLength(0);
  const syncFails = await post(BODY, {
    ...deps,
    syncUser: (async () => {
      throw new Error("db down");
    }) as unknown as Deps["syncUser"],
  });
  expect(syncFails.status).toBe(500);
  expect(logoutCalls).toEqual([["steward-jwt", "steward-refresh"]]);
});

test("malformed bodies and foreign bindings are refused before Steward is called", async () => {
  for (const body of [
    "not json",
    {},
    { ...BODY, steward: { ...BODY.steward, challengeId: "short" } },
    { ...BODY, codeVerifier: "short" },
    { ...BODY, serverAuthCode: "4/0 has spaces" },
    { ...BODY, organizationId: "other" },
    { ...BODY, clientId: "ai.other.app" },
    { ...BODY, redirectUri: "https://evil.example/callback" },
    { ...BODY, state: "bad state" },
  ]) {
    const response = await post(body);
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  }
  expect(events).toEqual([]);
});

test("the public config names Cloud's web client for requestOfflineAccess", async () => {
  const response = await createMobileGoogleSignInRoute(deps).request(
    "/",
    {},
    ENV,
  );
  expect(response.status).toBe(200);
  expect(await json(response)).toEqual({
    configured: true,
    serverClientId: "123456-webclient.apps.googleusercontent.com",
    scopes: ["openid", "https://www.googleapis.com/auth/gmail.modify"],
  });
  const missing = await createMobileGoogleSignInRoute({
    ...deps,
    googleProvider: () => null,
  }).request("/", {}, ENV);
  expect(missing.status).toBe(503);
});

test("idTokenSubject reads the Google account id and nothing else", () => {
  expect(idTokenSubject(ID_TOKEN)).toBe("109876543210");
  expect(idTokenSubject("a.b.c")).toBeNull();
  expect(idTokenSubject(`x.${encode({ sub: "../../etc" })}.y`)).toBeNull();
});
