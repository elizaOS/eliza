/**
 * Security contract for the disabled-by-default staging API-key session
 * exchange. This suite drives the REAL route, API-key auth, primary-backed
 * user/org/identity checks, Postgres code store, HS256 signer, and token
 * verifier on an isolated PGlite database. No identity or tenant is created by
 * the route; all rows below represent the pre-existing staging QA subject.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { decodeJwt, decodeProtectedHeader, jwtVerify, SignJWT } from "jose";

const PROCESS_ENV_KEYS = [
  "CACHE_ENABLED",
  "DATABASE_URL",
  "ENVIRONMENT",
  "MOCK_REDIS",
  "NODE_ENV",
] as const;
const ORIGINAL_PROCESS_ENV = Object.fromEntries(
  PROCESS_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof PROCESS_ENV_KEYS)[number], string | undefined>;

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
// Cloud Tests disables caching globally. This security regression deliberately
// exercises both a hot validation entry and a cold credential after rotation,
// so opt this isolated suite into its in-memory MOCK_REDIS backend.
process.env.CACHE_ENABLED = "true";
process.env.ENVIRONMENT = "staging";
process.env.MOCK_REDIS = "1";
process.env.NODE_ENV = "test";

setDefaultTimeout(90_000);

const API_ORIGIN = "https://api-staging.eliza.app";
const API_HOST = "api-staging.eliza.app";
const APP_ORIGIN = "https://cloud-staging.eliza.app";
const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const API_KEY_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ID = "44444444-4444-4444-8444-444444444444";
const APP_API_KEY_ID = "55555555-5555-4555-8555-555555555555";
const APP_ID = "66666666-6666-4666-8666-666666666666";
const STEWARD_USER_ID = "steward-existing-staging-qa-user";
const TENANT_ID = "elizacloud-staging";
const LEGACY_SIGNER_SECRET = "legacy-test-secret".repeat(4);
const SIGNER_SECRET = "dedicated-staging-session-test-secret-0123456789";
const SIGNING_KEY_ID = "staging-qa-v1-test";
const EXACT_ROLLBACK_SHA = "15ece9a356874057ae0e9db281be628d4d61c660";
const RAW_API_KEY = `eliza_${"ab".repeat(32)}`;
const API_KEY_HASH = createHash("sha256").update(RAW_API_KEY).digest("hex");
const RAW_APP_API_KEY = `eliza_${"ef".repeat(32)}`;
const APP_API_KEY_HASH = createHash("sha256")
  .update(RAW_APP_API_KEY)
  .digest("hex");
const ROTATED_RAW_API_KEY = `eliza_${"cd".repeat(32)}`;
const ROTATED_API_KEY_HASH = createHash("sha256")
  .update(ROTATED_RAW_API_KEY)
  .digest("hex");
const RAW_SANDBOX_API_KEY = `eliza_${"12".repeat(32)}`;
const SANDBOX_API_KEY_HASH = createHash("sha256")
  .update(RAW_SANDBOX_API_KEY)
  .digest("hex");

type RouteApp = typeof import("../auth/staging-session-exchange/route").default;
type LegacySsoApp = typeof import("../auth/sso-bridge/route").default;
type StewardRefreshApp = typeof import("../auth/steward-refresh/route").default;
type StewardSessionApp = typeof import("../auth/steward-session/route").default;
type DbClient = typeof import("@/db/client");
type Schemas = typeof import("@/db/schemas");
type CacheClientModule = typeof import("@/lib/cache/client");
type CacheKeysModule = typeof import("@/lib/cache/keys");
type StewardClientModule = typeof import("@/lib/auth/steward-client");
type CloudBindingsModule = typeof import("@/lib/runtime/cloud-bindings");
type SharedAuthModule = typeof import("@/lib/auth");
type WorkersHonoAuthModule = typeof import("@/lib/auth/workers-hono-auth");
type InferenceSessionAuthModule =
  typeof import("@/lib/services/inference-session-auth-context");
type InferenceAuthCacheModule =
  typeof import("@/lib/services/inference-auth-cache");
type OidcSessionModule = typeof import("@/lib/oidc/session");
type ServiceJwtModule = typeof import("@/lib/auth/service-jwt");

let app: RouteApp;
let legacySsoApp: LegacySsoApp;
let stewardRefreshApp: StewardRefreshApp;
let stewardSessionApp: StewardSessionApp;
let dbWrite: DbClient["dbWrite"];
let closeDatabaseConnectionsForTests: DbClient["closeDatabaseConnectionsForTests"];
let schemas: Schemas;
let cache: CacheClientModule["cache"];
let CacheKeys: CacheKeysModule["CacheKeys"];
let mintStewardTokenFromClaims: StewardClientModule["mintStewardTokenFromClaims"];
let verifyStewardTokenCached: StewardClientModule["verifyStewardTokenCached"];
let markSsoBridgeLogout: (stewardUserId: string) => Promise<void>;
let runWithCloudBindingsAsync: CloudBindingsModule["runWithCloudBindingsAsync"];
let getCurrentUserFromRequest: SharedAuthModule["getCurrentUserFromRequest"];
let requireAuthOrApiKey: SharedAuthModule["requireAuthOrApiKey"];
let getWorkersCurrentUser: WorkersHonoAuthModule["getCurrentUser"];
let resolveInferenceSessionAuthContext: InferenceSessionAuthModule["resolveInferenceSessionAuthContext"];
let writeInferenceSessionAuthDecision: InferenceAuthCacheModule["writeInferenceSessionAuthDecision"];
let INFERENCE_AUTH_CONTEXT_VERSION: InferenceAuthCacheModule["INFERENCE_AUTH_CONTEXT_VERSION"];
let resolveOidcSession: OidcSessionModule["resolveOidcSession"];
let verifyServiceJwt: ServiceJwtModule["verifyServiceJwt"];
let apiKeyDetailApp: Hono;
let apiKeyRegenerateApp: Hono;

interface TestEnv extends Record<string, unknown> {
  NODE_ENV?: string;
  ENVIRONMENT?: string;
  MOCK_REDIS?: string;
  STEWARD_JWT_SECRET?: string;
  ELIZA_SERVICE_JWT_SECRET?: string;
  STEWARD_TENANT_ID?: string;
  STAGING_SESSION_EXCHANGE_ENABLED?: string;
  STAGING_SESSION_EXCHANGE_VERSION?: string;
  STAGING_SESSION_EXCHANGE_SIGNING_SECRET?: string;
  STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID?: string;
  STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS?: string;
  STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS?: string;
  STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS?: string;
}

const BASE_ENV: TestEnv = {
  NODE_ENV: "production",
  ENVIRONMENT: "staging",
  MOCK_REDIS: "1",
  STEWARD_JWT_SECRET: LEGACY_SIGNER_SECRET,
  STEWARD_TENANT_ID: TENANT_ID,
  STAGING_SESSION_EXCHANGE_ENABLED: "true",
  STAGING_SESSION_EXCHANGE_VERSION: "v1",
  STAGING_SESSION_EXCHANGE_SIGNING_SECRET: SIGNER_SECRET,
  STAGING_SESSION_EXCHANGE_SIGNING_KEY_ID: SIGNING_KEY_ID,
  STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS: API_KEY_ID,
  STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS: USER_ID,
  STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS: ORGANIZATION_ID,
};

function testEnv(
  overrides: TestEnv = {},
  omitted: Array<keyof TestEnv> = [],
): TestEnv {
  const env = { ...BASE_ENV, ...overrides };
  for (const key of omitted) delete env[key];
  return env;
}

let ipCounter = 0;

interface CallOptions {
  apiKey?: string | null;
  bearer?: string | null;
  body?: unknown;
  env?: TestEnv;
  host?: string | null;
  ip?: string;
  origin?: string | null;
  url?: string;
}

async function call(
  path: "/mint" | "/exchange",
  options: CallOptions = {},
): Promise<Response> {
  ipCounter += 1;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cf-connecting-ip": options.ip ?? `198.51.100.${(ipCounter % 240) + 1}`,
  };
  const host = options.host === undefined ? API_HOST : options.host;
  const origin = options.origin === undefined ? APP_ORIGIN : options.origin;
  if (host !== null) headers.host = host;
  if (origin !== null) headers.origin = origin;
  if (options.apiKey) headers["x-api-key"] = options.apiKey;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;

  const background: Array<Promise<unknown>> = [];
  const response = await app.request(
    options.url ?? `${API_ORIGIN}${path}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(options.body ?? {}),
    },
    (options.env ?? BASE_ENV) as never,
    {
      waitUntil: (promise) => background.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    },
  );
  const backgroundResults = await Promise.allSettled(background);
  const backgroundFailures = backgroundResults.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (backgroundFailures.length > 0) {
    throw new AggregateError(
      backgroundFailures.map((result) => result.reason),
      "staging-session request background work failed",
    );
  }
  return response;
}

async function makeVerifierPair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const verifier = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const challengeBytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = Array.from(new Uint8Array(challengeBytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { verifier, challenge };
}

async function mintCode(
  env: TestEnv = BASE_ENV,
): Promise<{ code: string; verifier: string; responseText: string }> {
  const { verifier, challenge } = await makeVerifierPair();
  const response = await call("/mint", {
    apiKey: RAW_API_KEY,
    body: { codeChallenge: challenge },
    env,
  });
  const responseText = await response.text();
  expect(response.status).toBe(200);
  const body = JSON.parse(responseText) as { code: string; expiresIn: number };
  expect(body.code).toMatch(/^esqa_[0-9a-f]{64}$/);
  expect(body.expiresIn).toBe(60);
  expect(response.headers.get("cache-control")).toContain("no-store");
  return { code: body.code, verifier, responseText };
}

function exchange(
  code: string,
  verifier: string | null,
  env: TestEnv = BASE_ENV,
): Promise<Response> {
  return call("/exchange", {
    body: verifier === null ? { code } : { code, codeVerifier: verifier },
    env,
  });
}

async function callLegacySso(
  path: "/mint" | "/exchange",
  input: {
    bearer?: string;
    body: unknown;
    origin?: string;
  },
): Promise<Response> {
  ipCounter += 1;
  return await legacySsoApp.request(
    `${API_ORIGIN}${path}`,
    {
      method: "POST",
      headers: {
        authorization: input.bearer ? `Bearer ${input.bearer}` : "",
        "cf-connecting-ip": `203.0.113.${(ipCounter % 240) + 1}`,
        "content-type": "application/json",
        host: API_HOST,
        origin:
          input.origin ??
          (path === "/mint" ? "https://staging.eliza.app" : APP_ORIGIN),
      },
      body: JSON.stringify(input.body),
    },
    BASE_ENV as never,
  );
}

async function bearerRefresh(token: string): Promise<Response> {
  return await stewardRefreshApp.request(
    `${API_ORIGIN}/`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        host: API_HOST,
        origin: APP_ORIGIN,
      },
    },
    BASE_ENV as never,
  );
}

async function syncSessionCookie(
  token: string,
  refreshToken = "must-not-survive-qa-session",
): Promise<Response> {
  return await stewardSessionApp.request(
    `${API_ORIGIN}/`,
    {
      method: "POST",
      headers: {
        "cf-connecting-ip": `203.0.113.${(ipCounter++ % 240) + 1}`,
        "content-type": "application/json",
        host: API_HOST,
        origin: APP_ORIGIN,
      },
      body: JSON.stringify({ token, refreshToken }),
    },
    BASE_ENV as never,
  );
}

async function mintDerivedToken(): Promise<string> {
  const { code, verifier } = await mintCode();
  const response = await exchange(code, verifier);
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

function legacySessionCacheKeys(token: string): {
  steward: string;
  user: string;
} {
  const tokenHash = createHash("sha256")
    .update(token)
    .digest("hex")
    .substring(0, 32);
  return {
    steward: CacheKeys.session.steward(tokenHash),
    user: CacheKeys.session.user(tokenHash),
  };
}

async function primeOuterUserCache(token: string): Promise<void> {
  await cache.set(
    legacySessionCacheKeys(token).user,
    {
      id: OTHER_ID,
      email: "cached-staging-qa@example.test",
      is_active: true,
      organization_id: null,
      organization: null,
    },
    300,
  );
}

interface ExactRollbackClaims {
  userId: string;
  expiration: number;
  issuedAt: number;
}

/**
 * Cache/signature ordering copied from the verifier at EXACT_ROLLBACK_SHA:
 * legacy session cache first, ordinary Steward HMAC only on a miss.
 */
async function verifyWithExactRollbackCacheOrder(
  token: string,
): Promise<ExactRollbackClaims | null> {
  const cached = await cache.get<ExactRollbackClaims>(
    legacySessionCacheKeys(token).steward,
  );
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiration > now) return cached;

  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(LEGACY_SIGNER_SECRET),
      { algorithms: ["HS256"] },
    );
    const userId = (payload.sub ?? payload.userId ?? "") as string;
    if (!userId) return null;
    return {
      userId,
      expiration: payload.exp ?? 0,
      issuedAt: payload.iat ?? 0,
    };
  } catch {
    // error-policy:J3 the exact rollback treats a failed ordinary-key
    // signature as an invalid credential after its legacy-cache miss.
    return null;
  }
}

/** Outer ordering copied from auth.ts at EXACT_ROLLBACK_SHA. */
async function authenticateWithExactRollbackCacheOrder(
  token: string,
): Promise<{ id: string } | null> {
  const cachedUser = await cache.get<{ id: string }>(
    legacySessionCacheKeys(token).user,
  );
  if (cachedUser) return cachedUser;
  const claims = await verifyWithExactRollbackCacheOrder(token);
  return claims ? { id: claims.userId } : null;
}

async function resolveFromOuterCookieCache(
  token: string,
  env: TestEnv = BASE_ENV,
) {
  return await runWithCloudBindingsAsync(env, async () =>
    getCurrentUserFromRequest(
      new Request(`${API_ORIGIN}/api/v1/models`, {
        headers: { cookie: `steward-token-staging=${token}` },
      }),
    ),
  );
}

async function resetExistingSubject(): Promise<void> {
  const cacheKeys = [
    CacheKeys.apiKey.validation(API_KEY_HASH.slice(0, 16)),
    CacheKeys.apiKey.validation(ROTATED_API_KEY_HASH.slice(0, 16)),
    CacheKeys.apiKey.validation(APP_API_KEY_HASH.slice(0, 16)),
    CacheKeys.user.withOrg(USER_ID),
    CacheKeys.user.byStewardId(STEWARD_USER_ID),
    CacheKeys.user.byStewardIdWithOrg(STEWARD_USER_ID),
  ];
  const cacheCleanup = await Promise.allSettled(
    cacheKeys.map((key) => cache.del(key)),
  );
  const cacheFailures = cacheCleanup.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (cacheFailures.length > 0) {
    throw new AggregateError(
      cacheFailures.map((result) => result.reason),
      "failed to clear staging-session test caches",
    );
  }

  await dbWrite.delete(schemas.ssoBridgeCodes);
  await dbWrite.delete(schemas.ssoBridgeLogoutMarkers);
  await dbWrite.delete(schemas.authEvents);
  await dbWrite.delete(schemas.apps);
  await dbWrite.delete(schemas.apiKeys);
  await dbWrite.delete(schemas.userIdentities);
  await dbWrite.delete(schemas.users);
  await dbWrite.delete(schemas.organizations);

  await dbWrite.insert(schemas.organizations).values({
    id: ORGANIZATION_ID,
    name: "Existing Staging QA Organization",
    slug: "existing-staging-qa-organization",
    steward_tenant_id: TENANT_ID,
    is_active: true,
  });
  await dbWrite.insert(schemas.users).values({
    id: USER_ID,
    email: "existing-staging-qa@example.test",
    email_verified: true,
    organization_id: ORGANIZATION_ID,
    role: "owner",
    steward_user_id: STEWARD_USER_ID,
    is_active: true,
  });
  await dbWrite.insert(schemas.userIdentities).values({
    id: OTHER_ID,
    user_id: USER_ID,
    steward_user_id: STEWARD_USER_ID,
  });
  await dbWrite.insert(schemas.apiKeys).values({
    id: API_KEY_ID,
    name: "existing isolated staging QA key",
    key_hash: API_KEY_HASH,
    key_prefix: RAW_API_KEY.slice(0, 12),
    organization_id: ORGANIZATION_ID,
    user_id: USER_ID,
    is_active: true,
  });
  await dbWrite.insert(schemas.apiKeys).values({
    id: APP_API_KEY_ID,
    name: "scoped staging app key",
    key_hash: APP_API_KEY_HASH,
    key_prefix: RAW_APP_API_KEY.slice(0, 12),
    organization_id: ORGANIZATION_ID,
    user_id: USER_ID,
    is_active: true,
  });
  await dbWrite.insert(schemas.apps).values({
    id: APP_ID,
    name: "Scoped staging test app",
    slug: "scoped-staging-test-app",
    organization_id: ORGANIZATION_ID,
    created_by_user_id: USER_ID,
    app_url: "https://scoped-app.example.test",
    api_key_id: APP_API_KEY_ID,
  });
}

beforeAll(async () => {
  expect(CAN_USE_ISOLATED_PGLITE).toBe(true);

  const { pushSchema } = await import("@/db/push-schema-for-tests");
  schemas = await import("@/db/schemas");
  ({ dbWrite, closeDatabaseConnectionsForTests } = await import("@/db/client"));
  const { apply } = await pushSchema(
    {
      organizations: schemas.organizations,
      users: schemas.users,
      userIdentities: schemas.userIdentities,
      apiKeys: schemas.apiKeys,
      apps: schemas.apps,
      appDeploymentStatusEnum: schemas.appDeploymentStatusEnum,
      appReviewStatusEnum: schemas.appReviewStatusEnum,
      userDatabaseStatusEnum: schemas.userDatabaseStatusEnum,
      userModerationStatus: schemas.userModerationStatus,
      userModerationStatusEnum: schemas.userModerationStatusEnum,
      creditTransactions: schemas.creditTransactions,
      orgRateLimitOverrides: schemas.orgRateLimitOverrides,
      authEvents: schemas.authEvents,
      ssoBridgeCodes: schemas.ssoBridgeCodes,
      ssoBridgeLogoutMarkers: schemas.ssoBridgeLogoutMarkers,
    } as never,
    dbWrite as never,
  );
  await apply();
  // The origin session path loads the admission snapshot, which reads the
  // entitlement projection. Apply the real subscription authority migrations
  // rather than a schema push: their composite foreign keys depend on unique
  // indexes that drizzle-kit orders after the constraints.
  const { getPgliteClientForTests } = await import("@/db/client");
  for (const name of [
    "0373_subscription_authority.sql",
    "0374_subscription_funding_transaction_uniqueness.sql",
  ]) {
    const migration = await readFile(
      new URL(`../../shared/src/db/migrations/${name}`, import.meta.url),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) await getPgliteClientForTests().exec(statement);
    }
  }

  app = (await import("../auth/staging-session-exchange/route")).default;
  legacySsoApp = (await import("../auth/sso-bridge/route")).default;
  stewardRefreshApp = (await import("../auth/steward-refresh/route")).default;
  stewardSessionApp = (await import("../auth/steward-session/route")).default;
  ({ cache } = await import("@/lib/cache/client"));
  ({ CacheKeys } = await import("@/lib/cache/keys"));
  ({ mintStewardTokenFromClaims, verifyStewardTokenCached } = await import(
    "@/lib/auth/steward-client"
  ));
  ({ markSsoBridgeLogout } = await import("@/lib/services/sso-bridge-codes"));
  ({ runWithCloudBindingsAsync } = await import(
    "@/lib/runtime/cloud-bindings"
  ));
  ({ getCurrentUserFromRequest, requireAuthOrApiKey } = await import(
    "@/lib/auth"
  ));
  ({ getCurrentUser: getWorkersCurrentUser } = await import(
    "@/lib/auth/workers-hono-auth"
  ));
  ({ resolveInferenceSessionAuthContext } = await import(
    "@/lib/services/inference-session-auth-context"
  ));
  ({ writeInferenceSessionAuthDecision, INFERENCE_AUTH_CONTEXT_VERSION } =
    await import("@/lib/services/inference-auth-cache"));
  ({ resolveOidcSession } = await import("@/lib/oidc/session"));
  ({ verifyServiceJwt } = await import("@/lib/auth/service-jwt"));
  const apiKeyDetailRoute = (await import("../v1/api-keys/[id]/route")).default;
  apiKeyDetailApp = new Hono().route("/:id", apiKeyDetailRoute);
  const apiKeyRegenerateRoute = (
    await import("../v1/api-keys/[id]/regenerate/route")
  ).default;
  apiKeyRegenerateApp = new Hono().route("/:id", apiKeyRegenerateRoute);
});

beforeEach(async () => {
  await resetExistingSubject();
});

afterAll(async () => {
  let results: PromiseSettledResult<unknown>[] = [];
  try {
    const cleanupTasks: Array<Promise<unknown>> = [];
    if (cache && CacheKeys) {
      cleanupTasks.push(
        cache.del(CacheKeys.apiKey.validation(API_KEY_HASH.slice(0, 16))),
        cache.del(
          CacheKeys.apiKey.validation(ROTATED_API_KEY_HASH.slice(0, 16)),
        ),
        cache.del(CacheKeys.apiKey.validation(APP_API_KEY_HASH.slice(0, 16))),
        cache.del(CacheKeys.user.withOrg(USER_ID)),
        cache.del(CacheKeys.user.byStewardId(STEWARD_USER_ID)),
        cache.del(CacheKeys.user.byStewardIdWithOrg(STEWARD_USER_ID)),
      );
    }
    if (closeDatabaseConnectionsForTests) {
      cleanupTasks.push(closeDatabaseConnectionsForTests());
    }
    results = await Promise.allSettled(cleanupTasks);
  } finally {
    for (const key of PROCESS_ENV_KEYS) {
      const original = ORIGINAL_PROCESS_ENV[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }

  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      "staging-session test cleanup failed",
    );
  }
});

describe("staging triple gate and exact request surface", () => {
  test("disabled, local, production, and lookalike API surfaces are absent", async () => {
    const { challenge } = await makeVerifierPair();
    const cases: CallOptions[] = [
      { env: testEnv({ STAGING_SESSION_EXCHANGE_ENABLED: "false" }) },
      { env: testEnv({}, ["STAGING_SESSION_EXCHANGE_ENABLED"]) },
      { env: testEnv({}, ["STAGING_SESSION_EXCHANGE_VERSION"]) },
      { env: testEnv({ STAGING_SESSION_EXCHANGE_VERSION: "v2" }) },
      { env: testEnv({ NODE_ENV: "test" }) },
      { env: testEnv({ ENVIRONMENT: "production" }) },
      { url: "http://localhost:8787/mint", host: "localhost:8787" },
      { url: "https://api.eliza.app/mint", host: "api.eliza.app" },
      {
        url: "https://api-staging.eliza.app.evil.test/mint",
        host: "api-staging.eliza.app.evil.test",
      },
      { host: "api-staging.eliza.app:443" },
      { host: "cloud-staging.eliza.app" },
    ];

    for (const options of cases) {
      const response = await call("/mint", {
        ...options,
        apiKey: RAW_API_KEY,
        body: { codeChallenge: challenge },
      });
      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe(
        "not_found",
      );
    }
  });

  test("only the byte-exact app-staging Origin is accepted", async () => {
    const { challenge } = await makeVerifierPair();
    for (const origin of [
      null,
      "https://cloud.eliza.app",
      "http://cloud-staging.eliza.app",
      "https://cloud-staging.eliza.app:443",
      "https://cloud-staging.eliza.app.evil.test",
    ]) {
      const response = await call("/mint", {
        apiKey: RAW_API_KEY,
        body: { codeChallenge: challenge },
        origin,
      });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe(
        "forbidden_origin",
      );
    }
  });
});

describe("mint authentication and existing-subject eligibility", () => {
  test("requires one isolated API-key credential and rejects session or ambiguous credentials", async () => {
    const { challenge } = await makeVerifierPair();
    const ordinary = await mintStewardTokenFromClaims(
      BASE_ENV,
      {
        userId: STEWARD_USER_ID,
        tenantId: TENANT_ID,
        issuedAt: 0,
        expiration: 0,
      },
      300,
    );
    expect(ordinary).not.toBeNull();

    for (const credentials of [
      {},
      { bearer: ordinary?.token },
      { apiKey: RAW_API_KEY, bearer: RAW_API_KEY },
    ]) {
      const response = await call("/mint", {
        ...credentials,
        body: { codeChallenge: challenge },
      });
      expect(response.status).toBe(401);
    }

    const bearerOnly = await call("/mint", {
      bearer: RAW_API_KEY,
      body: { codeChallenge: challenge },
    });
    expect(bearerOnly.status).toBe(200);
  });

  test("rejects an app-scoped API key even when it belongs to the allowlisted user and org", async () => {
    const { challenge } = await makeVerifierPair();
    const response = await call("/mint", {
      apiKey: RAW_APP_API_KEY,
      body: { codeChallenge: challenge },
      env: testEnv({
        STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS: `${API_KEY_ID},${APP_API_KEY_ID}`,
      }),
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe(
      "subject_not_eligible",
    );
  });

  test("rejects a provisioner-managed sandbox key even when its id is allowlisted", async () => {
    await dbWrite
      .update(schemas.apiKeys)
      .set({ name: `agent-sandbox:${OTHER_ID}` })
      .where(eq(schemas.apiKeys.id, API_KEY_ID));
    const { challenge } = await makeVerifierPair();
    const response = await call("/mint", {
      apiKey: RAW_API_KEY,
      body: { codeChallenge: challenge },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe(
      "subject_not_eligible",
    );
  });

  test("prevents a provisioner-managed key from being renamed into an allowlistable user key", async () => {
    const ordinary = await mintStewardTokenFromClaims(
      BASE_ENV,
      {
        userId: STEWARD_USER_ID,
        tenantId: TENANT_ID,
        issuedAt: 0,
        expiration: 0,
      },
      300,
    );
    expect(ordinary).not.toBeNull();
    const sandboxName = `agent-sandbox:${OTHER_ID}`;
    await dbWrite
      .update(schemas.apiKeys)
      .set({ name: sandboxName })
      .where(eq(schemas.apiKeys.id, API_KEY_ID));

    const response = await apiKeyDetailApp.request(
      `${API_ORIGIN}/${API_KEY_ID}`,
      {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${ordinary?.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "ordinary-user-key" }),
      },
      BASE_ENV as never,
      {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
        props: {},
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error:
        "Provisioner-managed API keys cannot be updated through user routes.",
    });
    const [persisted] = await dbWrite
      .select({ name: schemas.apiKeys.name })
      .from(schemas.apiKeys)
      .where(eq(schemas.apiKeys.id, API_KEY_ID));
    expect(persisted?.name).toBe(sandboxName);
  });

  test("prevents a sandbox API key from regenerating an allowlisted QA key", async () => {
    await dbWrite.insert(schemas.apiKeys).values({
      id: OTHER_ID,
      name: `agent-sandbox:${OTHER_ID}`,
      key_hash: SANDBOX_API_KEY_HASH,
      key_prefix: RAW_SANDBOX_API_KEY.slice(0, 12),
      organization_id: ORGANIZATION_ID,
      user_id: USER_ID,
      is_active: true,
    });

    const response = await apiKeyRegenerateApp.request(
      `${API_ORIGIN}/${API_KEY_ID}`,
      {
        method: "POST",
        headers: { "x-api-key": RAW_SANDBOX_API_KEY },
      },
      BASE_ENV as never,
      {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
        props: {},
      },
    );
    expect(response.status).toBe(401);
    const [target] = await dbWrite
      .select({ keyHash: schemas.apiKeys.key_hash })
      .from(schemas.apiKeys)
      .where(eq(schemas.apiKeys.id, API_KEY_ID));
    expect(target?.keyHash).toBe(API_KEY_HASH);
  });

  test("revalidates the presented key against the current primary row across cache hit and miss", async () => {
    const oldValidationCacheKey = CacheKeys.apiKey.validation(
      API_KEY_HASH.slice(0, 16),
    );
    const rotatedValidationCacheKey = CacheKeys.apiKey.validation(
      ROTATED_API_KEY_HASH.slice(0, 16),
    );
    expect(await cache.get(oldValidationCacheKey)).toBeNull();

    // First request takes the validation cache-miss path and deliberately
    // leaves the old credential hot for the rotation race below.
    const { challenge: warmChallenge } = await makeVerifierPair();
    const warm = await call("/mint", {
      apiKey: RAW_API_KEY,
      body: { codeChallenge: warmChallenge },
    });
    expect(warm.status).toBe(200);
    expect(
      await cache.get<{ id: string; key_hash: string }>(oldValidationCacheKey),
    ).toMatchObject({
      id: API_KEY_ID,
      key_hash: API_KEY_HASH,
    });

    // Rotate the same row directly on primary without invalidating the old
    // validation entry, reproducing the cache-hit window under review.
    await dbWrite
      .update(schemas.apiKeys)
      .set({
        key_hash: ROTATED_API_KEY_HASH,
        key_prefix: ROTATED_RAW_API_KEY.slice(0, 12),
      })
      .where(eq(schemas.apiKeys.id, API_KEY_ID));
    expect(await cache.get(rotatedValidationCacheKey)).toBeNull();

    const { challenge: staleChallenge } = await makeVerifierPair();
    const staleCacheHit = await call("/mint", {
      apiKey: RAW_API_KEY,
      body: { codeChallenge: staleChallenge },
    });
    expect(staleCacheHit.status).toBe(403);
    expect(((await staleCacheHit.json()) as { code: string }).code).toBe(
      "subject_not_eligible",
    );

    // The rotated credential starts on a validation cache miss, resolves the
    // current row, and is then independently matched to that primary hash.
    const { challenge: rotatedChallenge } = await makeVerifierPair();
    const rotatedCacheMiss = await call("/mint", {
      apiKey: ROTATED_RAW_API_KEY,
      body: { codeChallenge: rotatedChallenge },
    });
    expect(rotatedCacheMiss.status).toBe(200);
    expect(
      await cache.get<{ id: string; key_hash: string }>(
        rotatedValidationCacheKey,
      ),
    ).toMatchObject({
      id: API_KEY_ID,
      key_hash: ROTATED_API_KEY_HASH,
    });
  });

  test("missing signer and malformed challenge fail before issuing a code", async () => {
    const { challenge } = await makeVerifierPair();
    const missingSigner = await call("/mint", {
      apiKey: RAW_API_KEY,
      body: { codeChallenge: challenge },
      env: testEnv({}, ["STAGING_SESSION_EXCHANGE_SIGNING_SECRET"]),
    });
    expect(missingSigner.status).toBe(503);
    expect(((await missingSigner.json()) as { code: string }).code).toBe(
      "server_secret_missing",
    );

    const serviceSignerCollision = await call("/mint", {
      apiKey: RAW_API_KEY,
      body: { codeChallenge: challenge },
      env: testEnv({ ELIZA_SERVICE_JWT_SECRET: SIGNER_SECRET }),
    });
    expect(serviceSignerCollision.status).toBe(503);
    expect(
      ((await serviceSignerCollision.json()) as { code: string }).code,
    ).toBe("server_secret_missing");

    const malformed = await call("/mint", {
      apiKey: RAW_API_KEY,
      body: { codeChallenge: "not-a-sha256-challenge" },
    });
    expect(malformed.status).toBe(400);
    expect(await dbWrite.select().from(schemas.ssoBridgeCodes)).toHaveLength(0);
  });

  test("wrong key/user/org allowlists are denied and wildcard/missing allowlists are configuration failures", async () => {
    const { challenge } = await makeVerifierPair();
    for (const env of [
      testEnv({ STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS: OTHER_ID }),
      testEnv({ STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS: OTHER_ID }),
      testEnv({ STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS: OTHER_ID }),
    ]) {
      const response = await call("/mint", {
        apiKey: RAW_API_KEY,
        body: { codeChallenge: challenge },
        env,
      });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe(
        "subject_not_eligible",
      );
    }

    for (const env of [
      testEnv({ STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS: "*" }),
      testEnv({}, ["STAGING_SESSION_EXCHANGE_ALLOWED_API_KEY_IDS"]),
      testEnv({ STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS: "*" }),
      testEnv({}, ["STAGING_SESSION_EXCHANGE_ALLOWED_ORGANIZATION_IDS"]),
    ]) {
      const response = await call("/mint", {
        apiKey: RAW_API_KEY,
        body: { codeChallenge: challenge },
        env,
      });
      expect(response.status).toBe(503);
      expect(((await response.json()) as { code: string }).code).toBe(
        "exchange_unavailable",
      );
    }
  });

  const eligibilityCases: Array<{
    name: string;
    mutate: () => Promise<unknown>;
    expectedStatus?: number;
  }> = [
    {
      name: "inactive API key",
      mutate: () =>
        dbWrite
          .update(schemas.apiKeys)
          .set({ is_active: false })
          .where(eq(schemas.apiKeys.id, API_KEY_ID)),
      expectedStatus: 401,
    },
    {
      name: "soft-deleted API key",
      mutate: () =>
        dbWrite
          .update(schemas.apiKeys)
          .set({ deleted_at: new Date() })
          .where(eq(schemas.apiKeys.id, API_KEY_ID)),
      expectedStatus: 401,
    },
    {
      name: "inactive user",
      mutate: () =>
        dbWrite
          .update(schemas.users)
          .set({ is_active: false })
          .where(eq(schemas.users.id, USER_ID)),
    },
    {
      name: "soft-deleted user",
      mutate: () =>
        dbWrite
          .update(schemas.users)
          .set({ deleted_at: new Date() })
          .where(eq(schemas.users.id, USER_ID)),
    },
    {
      name: "anonymous user",
      mutate: () =>
        dbWrite
          .update(schemas.users)
          .set({ is_anonymous: true })
          .where(eq(schemas.users.id, USER_ID)),
    },
    {
      name: "expired user",
      mutate: () =>
        dbWrite
          .update(schemas.users)
          .set({ expires_at: new Date(Date.now() - 1_000) })
          .where(eq(schemas.users.id, USER_ID)),
    },
    {
      name: "inactive organization",
      mutate: () =>
        dbWrite
          .update(schemas.organizations)
          .set({ is_active: false })
          .where(eq(schemas.organizations.id, ORGANIZATION_ID)),
    },
    {
      name: "system placeholder identity",
      mutate: async () => {
        const systemId = `system::${USER_ID}`;
        await dbWrite
          .update(schemas.userIdentities)
          .set({ steward_user_id: systemId })
          .where(eq(schemas.userIdentities.user_id, USER_ID));
        return dbWrite
          .update(schemas.users)
          .set({ steward_user_id: systemId })
          .where(eq(schemas.users.id, USER_ID));
      },
    },
    {
      name: "canonical/projection mismatch",
      mutate: () =>
        dbWrite
          .update(schemas.userIdentities)
          .set({ steward_user_id: "steward-mismatched-projection" })
          .where(eq(schemas.userIdentities.user_id, USER_ID)),
    },
    {
      name: "missing organization tenant mapping",
      mutate: () =>
        dbWrite
          .update(schemas.organizations)
          .set({ steward_tenant_id: null })
          .where(eq(schemas.organizations.id, ORGANIZATION_ID)),
    },
    {
      name: "cross-tenant organization mapping",
      mutate: () =>
        dbWrite
          .update(schemas.organizations)
          .set({ steward_tenant_id: "elizacloud-production" })
          .where(eq(schemas.organizations.id, ORGANIZATION_ID)),
    },
  ];

  for (const eligibilityCase of eligibilityCases) {
    test(`rejects ${eligibilityCase.name} without JIT repair`, async () => {
      await eligibilityCase.mutate();
      const { challenge } = await makeVerifierPair();
      const response = await call("/mint", {
        apiKey: RAW_API_KEY,
        body: { codeChallenge: challenge },
      });
      expect(response.status).toBe(eligibilityCase.expectedStatus ?? 403);
      expect(await dbWrite.select().from(schemas.ssoBridgeCodes)).toHaveLength(
        0,
      );
    });
  }

  test("rejects every repository-generated synthetic Steward identity", async () => {
    for (const stewardUserId of [
      `system::${USER_ID}`,
      "system:warm-pool",
      `anonymous:${USER_ID}`,
      `affiliate:${USER_ID}`,
      `wallet:evm:${USER_ID}`,
      `email:qa-${USER_ID}@example.test`,
      `telegram:${USER_ID}`,
      `discord:${USER_ID}`,
      `phone:+15550000000`,
      `whatsapp:${USER_ID}`,
      `svc_qa_${USER_ID}`,
    ]) {
      await dbWrite
        .update(schemas.userIdentities)
        .set({ steward_user_id: stewardUserId })
        .where(eq(schemas.userIdentities.user_id, USER_ID));
      await dbWrite
        .update(schemas.users)
        .set({ steward_user_id: stewardUserId })
        .where(eq(schemas.users.id, USER_ID));

      const { challenge } = await makeVerifierPair();
      const response = await call("/mint", {
        apiKey: RAW_API_KEY,
        body: { codeChallenge: challenge },
      });
      expect(response.status).toBe(403);
      expect(await dbWrite.select().from(schemas.ssoBridgeCodes)).toHaveLength(
        0,
      );
      await resetExistingSubject();
    }
  });
});

describe("opaque code, PKCE burn, and token scope", () => {
  test("stores only code/verifier hashes and returns a <=1h token with no role or credential", async () => {
    const { code, verifier, responseText } = await mintCode();
    expect(responseText).not.toContain(RAW_API_KEY);
    expect(responseText).not.toContain(verifier);

    const rows = await dbWrite.select().from(schemas.ssoBridgeCodes);
    expect(rows).toHaveLength(1);
    const stored = JSON.stringify(rows[0]);
    expect(rows[0]?.code_hash).toMatch(/^staging-session:v1:[0-9a-f]{64}$/);
    expect(rows[0]?.code_hash).not.toBe(code);
    expect(stored).not.toContain(code);
    expect(stored).not.toContain(verifier);
    expect(stored).not.toContain(RAW_API_KEY);

    const response = await exchange(code, verifier);
    const exchangeText = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(exchangeText).not.toContain(RAW_API_KEY);
    expect(exchangeText).not.toContain(code);
    expect(exchangeText).not.toContain(verifier);

    const body = JSON.parse(exchangeText) as {
      token: string;
      expiresAt: number;
      expiresIn: number;
    };
    const payload = decodeJwt(body.token);
    expect(decodeProtectedHeader(body.token)).toEqual({
      alg: "HS256",
      typ: "eliza-staging-session+jwt",
      kid: SIGNING_KEY_ID,
    });
    expect(payload.sub).toBe(STEWARD_USER_ID);
    expect(payload.tenantId).toBe(TENANT_ID);
    expect(payload.tenant_id).toBe(TENANT_ID);
    expect(payload.role).toBeUndefined();
    expect(payload.roles).toBeUndefined();
    expect(payload.eliza_staging_session).toMatchObject({
      version: "v1",
      apiKeyId: API_KEY_ID,
      cloudUserId: USER_ID,
      organizationId: ORGANIZATION_ID,
      credentialFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      sessionIssuedAt: expect.any(Number),
      sessionMaxExpiresAt: expect.any(Number),
    });
    expect(JSON.stringify(payload)).not.toContain(RAW_API_KEY);
    expect(body.expiresIn).toBeGreaterThan(0);
    expect(body.expiresIn).toBeLessThanOrEqual(3600);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(3600);

    const verified = await verifyStewardTokenCached(BASE_ENV, body.token);
    expect(verified).toMatchObject({
      userId: STEWARD_USER_ID,
      tenantId: TENANT_ID,
      stagingSessionBinding: {
        version: "v1",
        apiKeyId: API_KEY_ID,
        cloudUserId: USER_ID,
        organizationId: ORGANIZATION_ID,
      },
    });
  });

  test("cannot launder the QA token through service JWT auth if HMAC secrets collide", async () => {
    const token = await mintDerivedToken();
    const result = await runWithCloudBindingsAsync(
      { ...BASE_ENV, ELIZA_SERVICE_JWT_SECRET: SIGNER_SECRET },
      async () => await verifyServiceJwt(`Bearer ${token}`),
    );
    expect(result).toBeNull();
  });

  test("wrong or missing verifier burns the code before refusal", async () => {
    for (const attemptedVerifier of ["00".repeat(32), null]) {
      const { code, verifier } = await mintCode();
      expect(attemptedVerifier).not.toBe(verifier);
      const refused = await exchange(code, attemptedVerifier);
      expect(refused.status).toBe(401);
      const replay = await exchange(code, verifier);
      expect(replay.status).toBe(401);
    }
  });

  test("concurrent exchange has exactly one winner and all replays lose", async () => {
    const { code, verifier } = await mintCode();
    const responses = await Promise.all([
      exchange(code, verifier),
      exchange(code, verifier),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 401,
    ]);
    expect((await exchange(code, verifier)).status).toBe(401);
  });

  test("missing signer is checked after atomic consumption, so retry cannot resurrect the code", async () => {
    const { code, verifier } = await mintCode();
    const missingSigner = await exchange(
      code,
      verifier,
      testEnv({}, ["STAGING_SESSION_EXCHANGE_SIGNING_SECRET"]),
    );
    expect(missingSigner.status).toBe(503);
    expect(((await missingSigner.json()) as { code: string }).code).toBe(
      "server_secret_missing",
    );
    expect((await exchange(code, verifier)).status).toBe(401);
  });

  test("source API-key expiry caps the derived token lifetime", async () => {
    const keyExpiry = new Date(Date.now() + 180_000);
    await dbWrite
      .update(schemas.apiKeys)
      .set({ expires_at: keyExpiry })
      .where(eq(schemas.apiKeys.id, API_KEY_ID));

    const { code, verifier } = await mintCode();
    const response = await exchange(code, verifier);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { token: string };
    const payload = decodeJwt(body.token);
    expect((payload.exp ?? 0) * 1000).toBeLessThanOrEqual(keyExpiry.getTime());
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBeLessThanOrEqual(180);
  });

  test("a signed staging binding longer than one hour is rejected by the shared verifier", async () => {
    const { code, verifier } = await mintCode();
    const exchanged = await exchange(code, verifier);
    const validToken = ((await exchanged.json()) as { token: string }).token;
    const payload = decodeJwt(validToken);
    const binding = payload.eliza_staging_session as {
      sessionIssuedAt: number;
      sessionMaxExpiresAt: number;
    };
    const overlong = await new SignJWT({
      userId: STEWARD_USER_ID,
      tenantId: TENANT_ID,
      tenant_id: TENANT_ID,
      bridged: true,
      eliza_staging_session: payload.eliza_staging_session,
    })
      .setProtectedHeader({
        alg: "HS256",
        typ: "eliza-staging-session+jwt",
        kid: SIGNING_KEY_ID,
      })
      .setSubject(STEWARD_USER_ID)
      .setIssuedAt(binding.sessionIssuedAt)
      .setExpirationTime(binding.sessionMaxExpiresAt + 1)
      .sign(new TextEncoder().encode(SIGNER_SECRET));
    expect(await verifyStewardTokenCached(BASE_ENV, overlong)).toBeNull();
  });

  test("ordinary Steward tokens remain independent of the disabled staging feature", async () => {
    const ordinary = await mintStewardTokenFromClaims(
      BASE_ENV,
      {
        userId: STEWARD_USER_ID,
        tenantId: TENANT_ID,
        issuedAt: 0,
        expiration: 0,
      },
      300,
    );
    expect(ordinary).not.toBeNull();
    const disabledEnv = testEnv({ STAGING_SESSION_EXCHANGE_ENABLED: "false" });
    expect(
      await verifyStewardTokenCached(disabledEnv, ordinary?.token ?? ""),
    ).toMatchObject({
      userId: STEWARD_USER_ID,
      tenantId: TENANT_ID,
    });
  });
});

describe("rollback and legacy downgrade isolation", () => {
  test(`QA verification/auth never populates caches trusted by rollback ${EXACT_ROLLBACK_SHA}`, async () => {
    const token = await mintDerivedToken();
    const legacyKeys = legacySessionCacheKeys(token);
    const forbiddenKeys = new Set([legacyKeys.steward, legacyKeys.user]);
    await Promise.all([
      cache.del(legacyKeys.steward),
      cache.del(legacyKeys.user),
    ]);

    const getSpy = spyOn(cache, "get");
    const setSpy = spyOn(cache, "set");
    try {
      expect(await verifyStewardTokenCached(BASE_ENV, token)).toMatchObject({
        userId: STEWARD_USER_ID,
      });
      expect(await resolveFromOuterCookieCache(token)).toMatchObject({
        id: USER_ID,
      });

      const legacyReads = (getSpy.mock.calls as unknown as unknown[][])
        .map(([key]) => key)
        .filter(
          (key): key is string =>
            typeof key === "string" && forbiddenKeys.has(key),
        );
      const legacyWrites = (setSpy.mock.calls as unknown as unknown[][])
        .map(([key]) => key)
        .filter(
          (key): key is string =>
            typeof key === "string" && forbiddenKeys.has(key),
        );
      expect(legacyReads).toEqual([]);
      expect(legacyWrites).toEqual([]);
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
    }

    expect(await cache.get(legacyKeys.steward)).toBeNull();
    expect(await cache.get(legacyKeys.user)).toBeNull();

    const rollbackGetSpy = spyOn(cache, "get");
    try {
      // Exact rollback checks the outer user cache, then the Steward cache,
      // before reaching its ordinary-key signature verification. Both misses
      // force that verifier to reject this dedicated-key token.
      expect(await authenticateWithExactRollbackCacheOrder(token)).toBeNull();
      const rollbackLegacyReads = (
        rollbackGetSpy.mock.calls as unknown as unknown[][]
      )
        .map(([key]) => key)
        .filter(
          (key): key is string =>
            typeof key === "string" && forbiddenKeys.has(key),
        );
      expect(rollbackLegacyReads).toEqual([
        legacyKeys.user,
        legacyKeys.steward,
      ]);
    } finally {
      rollbackGetSpy.mockRestore();
    }

    expect(await cache.get(legacyKeys.steward)).toBeNull();
    expect(await cache.get(legacyKeys.user)).toBeNull();
  });

  test("old Steward verifier and old SSO mint cannot accept a QA token", async () => {
    const token = await mintDerivedToken();

    await expect(
      jwtVerify(token, new TextEncoder().encode(LEGACY_SIGNER_SECRET), {
        algorithms: ["HS256"],
      }),
    ).rejects.toThrow();

    const { challenge } = await makeVerifierPair();
    const legacyMint = await callLegacySso("/mint", {
      bearer: token,
      body: { codeChallenge: challenge },
    });
    expect(legacyMint.status).toBe(401);
    expect(((await legacyMint.json()) as { code: string }).code).toBe(
      "invalid_token",
    );
  });

  test("old SSO exchange cannot recognize or burn a versioned QA code", async () => {
    const { code, verifier } = await mintCode();
    const legacyExchange = await callLegacySso("/exchange", {
      body: { code, codeVerifier: verifier },
    });
    expect(legacyExchange.status).toBe(400);
    expect(((await legacyExchange.json()) as { code: string }).code).toBe(
      "missing_code",
    );

    // Legacy refusal did not address the versioned store key; the real QA
    // exchange remains the sole consumer.
    expect((await exchange(code, verifier)).status).toBe(200);
  });

  test("bearer refresh refuses the non-renewable QA session", async () => {
    const token = await mintDerivedToken();
    const before = decodeJwt(token);
    const response = await bearerRefresh(token);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe(
      "invalid_token",
    );
    expect((before.exp ?? 0) - (before.iat ?? 0)).toBeLessThanOrEqual(3600);
  });

  test("cookie sync binds the primary QA user and clears any renewable session", async () => {
    const token = await mintDerivedToken();
    const response = await syncSessionCookie(token);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, userId: USER_ID });
    const cookies = response.headers.getSetCookie().join("\n");
    expect(cookies).toContain("steward-token-staging=");
    expect(cookies).toContain("steward-refresh-token-staging=");
    expect(cookies).not.toContain("must-not-survive-qa-session");
    expect(cookies).not.toContain("Max-Age=2592000");
  });
});

describe("full/thin verifier env and outer cookie-cache revocation", () => {
  test("fails closed in both full and thin auth when the QA and service secrets collide", async () => {
    const token = await mintDerivedToken();
    const collisionEnv = {
      ...BASE_ENV,
      ELIZA_SERVICE_JWT_SECRET: SIGNER_SECRET,
    };
    await expect(
      runWithCloudBindingsAsync(collisionEnv, async () =>
        requireAuthOrApiKey(
          new Request(`${API_ORIGIN}/api/v1/models`, {
            headers: { authorization: `Bearer ${token}` },
          }),
        ),
      ),
    ).rejects.toThrow("Invalid or expired token");

    const thin = await runWithCloudBindingsAsync(collisionEnv, async () =>
      resolveInferenceSessionAuthContext(
        new Request(`${API_ORIGIN}/api/v1/chat/completions`, {
          headers: { authorization: `Bearer ${token}` },
        }),
        { cacheOnly: true, useAuthCache: true },
      ),
    );
    expect(thin).toEqual({ kind: "rejected", status: 401 });
  });

  test("uses the signed Cloud user/org binding for bearer auth and ignores Steward identity caches", async () => {
    const token = await mintDerivedToken();
    await cache.set(
      CacheKeys.user.byStewardId(STEWARD_USER_ID),
      {
        id: OTHER_ID,
        steward_user_id: STEWARD_USER_ID,
        is_active: true,
        organization_id: OTHER_ID,
      },
      300,
    );

    const auth = await runWithCloudBindingsAsync(BASE_ENV, async () =>
      requireAuthOrApiKey(
        new Request(`${API_ORIGIN}/api/v1/models`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    );
    expect(auth.user).toMatchObject({
      id: USER_ID,
      organization_id: ORGANIZATION_ID,
      steward_user_id: STEWARD_USER_ID,
    });
  });

  test("uses the signed Cloud user/org binding in the Workers Hono auth path", async () => {
    const token = await mintDerivedToken();
    await cache.set(
      CacheKeys.user.byStewardId(STEWARD_USER_ID),
      {
        id: OTHER_ID,
        steward_user_id: STEWARD_USER_ID,
        is_active: true,
        organization_id: OTHER_ID,
      },
      300,
    );

    const variables = new Map<string, unknown>();
    const user = await runWithCloudBindingsAsync(BASE_ENV, async () =>
      getWorkersCurrentUser({
        env: BASE_ENV,
        req: {
          url: `${API_ORIGIN}/api/v1/models`,
          header: (name: string) =>
            name.toLowerCase() === "authorization"
              ? `Bearer ${token}`
              : undefined,
        },
        get: (key: string) => variables.get(key),
        set: (key: string, value: unknown) => variables.set(key, value),
      } as never),
    );
    expect(user).toMatchObject({
      id: USER_ID,
      organization_id: ORGANIZATION_ID,
      steward_id: STEWARD_USER_ID,
    });
  });

  test("refuses to launder a QA session into an ordinary OIDC authorization", async () => {
    const token = await mintDerivedToken();
    const outcome = await resolveOidcSession({
      env: BASE_ENV,
      req: {
        header: (name: string) =>
          name.toLowerCase() === "cookie"
            ? `steward-token-staging=${token}`
            : undefined,
      },
    } as never);
    expect(outcome).toEqual({ status: "signed_out" });
  });

  test("accepts a valid QA token through both full and thin shared auth paths", async () => {
    const token = await mintDerivedToken();
    await primeOuterUserCache(token);
    expect(await resolveFromOuterCookieCache(token)).toMatchObject({
      id: USER_ID,
    });

    await runWithCloudBindingsAsync(BASE_ENV, async () => {
      await writeInferenceSessionAuthDecision({
        v: INFERENCE_AUTH_CONTEXT_VERSION,
        cachedAt: Date.now(),
        userId: OTHER_ID,
        orgId: OTHER_ID,
        apiKeyId: null,
        stewardUserId: STEWARD_USER_ID,
        admission: {
          subscriptionFunded: false,
          balance: {
            balanceUsd: 100,
            balanceAt: Date.now(),
            balanceRevision: "1",
          },
          rateLimits: {
            completionsRpm: 100,
            embeddingsRpm: 100,
            standardRpm: 100,
            strictRpm: 100,
          },
        },
      });
    });
    const thin = await runWithCloudBindingsAsync(BASE_ENV, async () =>
      resolveInferenceSessionAuthContext(
        new Request(`${API_ORIGIN}/api/v1/chat/completions`, {
          headers: { authorization: `Bearer ${token}` },
        }),
        { cacheOnly: true, useAuthCache: true },
      ),
    );
    expect(thin).toMatchObject({
      kind: "authorized",
      source: "origin",
      ctx: { userId: USER_ID, orgId: ORGANIZATION_ID },
    });
  });

  const revocations: Array<{
    name: string;
    apply: () => Promise<TestEnv | undefined>;
  }> = [
    {
      name: "source API key",
      apply: async () => {
        await dbWrite
          .update(schemas.apiKeys)
          .set({ is_active: false })
          .where(eq(schemas.apiKeys.id, API_KEY_ID));
        return undefined;
      },
    },
    {
      name: "source API-key generation",
      apply: async () => {
        await dbWrite
          .update(schemas.apiKeys)
          .set({
            key_hash: createHash("sha256")
              .update(`eliza_${"01".repeat(32)}`)
              .digest("hex"),
          })
          .where(eq(schemas.apiKeys.id, API_KEY_ID));
        return undefined;
      },
    },
    {
      name: "user",
      apply: async () => {
        await dbWrite
          .update(schemas.users)
          .set({ is_active: false })
          .where(eq(schemas.users.id, USER_ID));
        return undefined;
      },
    },
    {
      name: "organization",
      apply: async () => {
        await dbWrite
          .update(schemas.organizations)
          .set({ is_active: false })
          .where(eq(schemas.organizations.id, ORGANIZATION_ID));
        return undefined;
      },
    },
    {
      name: "user allowlist",
      apply: async () =>
        testEnv({ STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS: OTHER_ID }),
    },
    {
      name: "feature gate",
      apply: async () => testEnv({ STAGING_SESSION_EXCHANGE_ENABLED: "false" }),
    },
    {
      name: "logout marker",
      apply: async () => {
        await markSsoBridgeLogout(STEWARD_USER_ID);
        return undefined;
      },
    },
  ];

  for (const revocation of revocations) {
    test(`revalidates ${revocation.name} before an already-hot outer cookie cache`, async () => {
      await resetExistingSubject();
      const token = await mintDerivedToken();
      await primeOuterUserCache(token);
      expect(await resolveFromOuterCookieCache(token)).toMatchObject({
        id: USER_ID,
      });
      const env = (await revocation.apply()) ?? BASE_ENV;
      expect(await resolveFromOuterCookieCache(token, env)).toBeNull();
    });
  }
});

describe("continuous revocation and fail-closed dependencies", () => {
  test("API-key revocation invalidates even an in-memory-cached derived token", async () => {
    const token = await mintDerivedToken();
    expect(await verifyStewardTokenCached(BASE_ENV, token)).not.toBeNull();
    await dbWrite
      .update(schemas.apiKeys)
      .set({ is_active: false })
      .where(eq(schemas.apiKeys.id, API_KEY_ID));
    expect(await verifyStewardTokenCached(BASE_ENV, token)).toBeNull();
  });

  test("regenerating the same API-key row invalidates its credential fingerprint", async () => {
    const token = await mintDerivedToken();
    expect(await verifyStewardTokenCached(BASE_ENV, token)).not.toBeNull();
    const [before] = await dbWrite
      .select({ updatedAt: schemas.apiKeys.updated_at })
      .from(schemas.apiKeys)
      .where(eq(schemas.apiKeys.id, API_KEY_ID));
    await dbWrite
      .update(schemas.apiKeys)
      .set({ key_hash: ROTATED_API_KEY_HASH })
      .where(eq(schemas.apiKeys.id, API_KEY_ID));
    const [after] = await dbWrite
      .select({ updatedAt: schemas.apiKeys.updated_at })
      .from(schemas.apiKeys)
      .where(eq(schemas.apiKeys.id, API_KEY_ID));
    expect(after?.updatedAt.getTime()).toBe(before?.updatedAt.getTime());
    expect(await verifyStewardTokenCached(BASE_ENV, token)).toBeNull();
  });

  test("user, organization, allowlist, and feature revocation all invalidate the token", async () => {
    const token = await mintDerivedToken();
    await dbWrite
      .update(schemas.users)
      .set({ is_active: false })
      .where(eq(schemas.users.id, USER_ID));
    expect(await verifyStewardTokenCached(BASE_ENV, token)).toBeNull();

    await dbWrite
      .update(schemas.users)
      .set({ is_active: true })
      .where(eq(schemas.users.id, USER_ID));
    await dbWrite
      .update(schemas.organizations)
      .set({ is_active: false })
      .where(eq(schemas.organizations.id, ORGANIZATION_ID));
    expect(await verifyStewardTokenCached(BASE_ENV, token)).toBeNull();

    await dbWrite
      .update(schemas.organizations)
      .set({ is_active: true })
      .where(eq(schemas.organizations.id, ORGANIZATION_ID));
    expect(
      await verifyStewardTokenCached(
        testEnv({ STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS: OTHER_ID }),
        token,
      ),
    ).toBeNull();
    expect(
      await verifyStewardTokenCached(
        testEnv({ STAGING_SESSION_EXCHANGE_ENABLED: "false" }),
        token,
      ),
    ).toBeNull();
  });

  test("logout marker invalidates an already verified derived token", async () => {
    const token = await mintDerivedToken();
    expect(await verifyStewardTokenCached(BASE_ENV, token)).not.toBeNull();
    await markSsoBridgeLogout(STEWARD_USER_ID);
    expect(await verifyStewardTokenCached(BASE_ENV, token)).toBeNull();
  });

  test("revocation between mint and exchange burns and refuses the code", async () => {
    const { code, verifier } = await mintCode();
    await dbWrite
      .update(schemas.apiKeys)
      .set({ is_active: false })
      .where(eq(schemas.apiKeys.id, API_KEY_ID));
    expect((await exchange(code, verifier)).status).toBe(401);
    expect((await exchange(code, verifier)).status).toBe(401);
  });

  test("missing rate-limit backing rejects before the handler", async () => {
    const { challenge } = await makeVerifierPair();
    const response = await call("/mint", {
      apiKey: RAW_API_KEY,
      body: { codeChallenge: challenge },
      env: testEnv({}, ["MOCK_REDIS"]),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe(
      "rate_limit_unavailable",
    );
    expect(await dbWrite.select().from(schemas.ssoBridgeCodes)).toHaveLength(0);
  });

  test("missing Postgres code store fails closed", async () => {
    await dbWrite.execute(
      sql.raw(
        'ALTER TABLE "sso_bridge_codes" RENAME TO "sso_bridge_codes_unavailable"',
      ),
    );
    try {
      const { challenge } = await makeVerifierPair();
      const response = await call("/mint", {
        apiKey: RAW_API_KEY,
        body: { codeChallenge: challenge },
      });
      expect(response.status).toBe(503);
      expect(((await response.json()) as { code: string }).code).toBe(
        "exchange_unavailable",
      );
    } finally {
      await dbWrite.execute(
        sql.raw(
          'ALTER TABLE "sso_bridge_codes_unavailable" RENAME TO "sso_bridge_codes"',
        ),
      );
    }
  });

  test("credential, code, verifier, and token never reach log sinks", async () => {
    const captured: unknown[][] = [];
    const originalConsole = {
      error: console.error,
      info: console.info,
      log: console.log,
      warn: console.warn,
    };
    const capture = (...args: unknown[]) => captured.push(args);
    console.error = capture;
    console.info = capture;
    console.log = capture;
    console.warn = capture;

    let code = "";
    let verifier = "";
    let token = "";
    try {
      ({ code, verifier } = await mintCode());
      const exchanged = await exchange(code, verifier);
      token = ((await exchanged.json()) as { token: string }).token;
      const missingConfig = await call("/mint", {
        apiKey: RAW_API_KEY,
        body: { codeChallenge: "00".repeat(32) },
        env: testEnv({}, ["STAGING_SESSION_EXCHANGE_ALLOWED_USER_IDS"]),
      });
      expect(missingConfig.status).toBe(503);
    } finally {
      console.error = originalConsole.error;
      console.info = originalConsole.info;
      console.log = originalConsole.log;
      console.warn = originalConsole.warn;
    }

    const logged = JSON.stringify(captured);
    expect(logged).not.toContain(RAW_API_KEY);
    expect(logged).not.toContain(code);
    expect(logged).not.toContain(verifier);
    expect(logged).not.toContain(token);
  });
});
