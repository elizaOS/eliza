/**
 * End-to-end contract for the Eliza Cloud OpenID Provider, driven through the
 * REAL route modules mounted the way `bootstrap-app.ts` and the codegen tree
 * mount them, against real PGlite and a real RS256 key ring.
 *
 * Nothing is stubbed on the paths that matter: the Steward session is a real
 * HS256 cookie verified by the production verifier, authorization codes are
 * claimed by the real single-statement `DELETE … RETURNING`, and every ID token
 * is verified the way the downstream consumer does it — fetch the discovery
 * document, require `issuer` to match byte-for-byte, fetch `jwks_uri`, then
 * `jwtVerify` with `{issuer, audience}` (see hub `services/merge-steward/
 * src/oidc-auth.js`).
 *
 * The suite is written around the failures that would only show up in
 * production: an open redirect at `/authorize`, a code redeemed twice, a
 * relying party pinned to the wrong issuer, and claims that outlive the account
 * they describe.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
  test,
} from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";

const AMBIENT_DATABASE_URL = process.env.DATABASE_URL ?? "";
const CAN_USE_ISOLATED_PGLITE =
  AMBIENT_DATABASE_URL === "" || AMBIENT_DATABASE_URL.startsWith("pglite");
process.env.DATABASE_URL ||= "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS = "1";

setDefaultTimeout(120_000);

const STEWARD_SECRET = "oidc-provider-test-secret-0123456789";
const ISSUER = "https://api.elizacloud.test";
const CONSOLE_ORIGIN = "https://console.elizacloud.test";
const FORGEJO_REDIRECT =
  "https://hub.elizacloud.test/user/oauth2/elizacloud/callback";
const FORGEJO_CLIENT_ID = "elizahub-forgejo";
const FORGEJO_SECRET = "forgejo-client-secret-value-0123456789";
const LOWTRUST_CLIENT_ID = "lowtrust-app";
const LOWTRUST_SECRET = "lowtrust-client-secret-value-0123456789";
const PERCENT_CLIENT_ID = "percent-secret-app";
/**
 * A secret containing a `%` that reads as a valid escape. RFC 6749 §2.3.1 says
 * `client_secret_basic` halves are form-encoded, so this text has two possible
 * readings and the provider has to accept the one the client meant.
 */
const PERCENT_SECRET = "percent-secret-100%2Fvalue-0123456789";
const PERCENT_REDIRECT = "https://percent.example/callback";
const STEWARD_AUDIENCE = "eliza-cloud-steward";
const CONSOLE_CLIENT_ID = "eliza-steward-console";
const CONSOLE_SECRET = "steward-console-secret-value-0123456789";
const CONSOLE_REDIRECT = "https://console.elizacloud.test/oidc/callback";

/**
 * The gates the two consumers are SHIPPED with. Forgejo's pair comes from
 * `--required-claim-name` / `--required-claim-value`; Merge Steward's lists come
 * from `MERGE_STEWARD_OIDC_*` (hub `deployment/hetzner-staging/.env.example`).
 * None of them name a value this provider produces natively, which is exactly
 * what `constant_claims` and `claims_mapping` exist to bridge.
 */
const FORGEJO_REQUIRED_CLAIM = { name: "tenant", value: "eliza" } as const;
/** `--admin-group` / `--restricted-group` on the hub's Forgejo login source. */
const FORGEJO_ADMIN_GROUP = "eliza-admins";
const FORGEJO_RESTRICTED_GROUP = "eliza-agents";
const MERGE_STEWARD_AUDIENCE = "eliza-merge-steward";
const MERGE_STEWARD_REQUIRED_ROLES = ["steward", "maintainer"];
const MERGE_STEWARD_REQUIRED_GROUPS = ["eliza-team"];
const MERGE_STEWARD_ADMIN_ROLES = ["steward-admin"];
const MERGE_STEWARD_ADMIN_GROUPS = ["eliza-admins"];

const API_ROOT = join(import.meta.dir, "..");

type MintSteward =
  typeof import("@/lib/auth/steward-client").mintStewardTokenFromClaims;
type VerifyAgainstJwks =
  typeof import("@/lib/oidc/tokens").verifyOidcTokenAgainstJwks;
type PublishedJwks = Parameters<VerifyAgainstJwks>[1]["jwks"];

let harness: Hono;
let mintStewardTokenFromClaims: MintSteward;
let verifyOidcTokenAgainstJwks: VerifyAgainstJwks;
let dbWrite: typeof import("@/db/client").dbWrite;
let schemas: typeof import("@/db/schemas");
let ENV: Record<string, string>;
let ipCounter = 0;

function sha256Hex(value: string): string {
  return require("node:crypto")
    .createHash("sha256")
    .update(value)
    .digest("hex");
}

function rsaPrivateJwk(kid: string): Record<string, unknown> {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    ...(privateKey.export({ format: "jwk" }) as object),
    kid,
    alg: "RS256",
  };
}

interface CallOptions {
  method?: string;
  cookie?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
  host?: string;
}

/** Issue a request against the mounted harness with a unique client IP. */
async function call(
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  ipCounter += 1;
  const headers: Record<string, string> = {
    "x-forwarded-for": `10.1.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`,
    ...options.headers,
  };
  if (options.cookie) headers.cookie = options.cookie;
  const origin = options.host ? `https://${options.host}` : ISSUER;
  return harness.request(
    `${origin}${path}`,
    {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      redirect: "manual",
    },
    ENV,
  );
}

function form(fields: Record<string, string>): {
  body: BodyInit;
  headers: Record<string, string>;
} {
  return {
    body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  };
}

function basicAuth(clientId: string, secret: string): string {
  return `Basic ${btoa(`${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`)}`;
}

interface SeedOptions {
  stewardUserId: string;
  email?: string | null;
  emailVerified?: boolean;
  nickname?: string | null;
  name?: string | null;
  avatar?: string | null;
  role?: string;
  isActive?: boolean;
  isAnonymous?: boolean;
  orgSlug?: string;
  stewardTenantId?: string | null;
  withOrg?: boolean;
  walletAddress?: string;
}

/** Insert a real users/organizations pair and return the ids. */
async function seedUser(
  options: SeedOptions,
): Promise<{ userId: string; orgId: string | null }> {
  let orgId: string | null = null;
  if (options.withOrg !== false) {
    const [org] = await dbWrite
      .insert(schemas.organizations)
      .values({
        name: options.orgSlug ?? "Test Org",
        slug: options.orgSlug ?? `org-${options.stewardUserId}`,
        steward_tenant_id:
          options.stewardTenantId === undefined
            ? `tenant-${options.stewardUserId}`
            : options.stewardTenantId,
      })
      .returning();
    orgId = org.id;
  }

  const [user] = await dbWrite
    .insert(schemas.users)
    .values({
      steward_user_id: options.stewardUserId,
      email:
        options.email === undefined
          ? `${options.stewardUserId}@example.com`
          : options.email,
      email_verified: options.emailVerified ?? true,
      name: options.name === undefined ? "Ada Lovelace" : options.name,
      avatar:
        options.avatar === undefined
          ? "https://cdn.example.com/ada.png"
          : options.avatar,
      nickname:
        options.nickname === undefined
          ? options.stewardUserId
          : options.nickname,
      organization_id: orgId,
      role: options.role ?? "owner",
      is_active: options.isActive ?? true,
      is_anonymous: options.isAnonymous ?? false,
      wallet_address: options.walletAddress ?? null,
    })
    .returning();

  return { userId: user.id, orgId };
}

/**
 * The REAL wallet-backed platform grant: `adminService` resolves admin status
 * from `admin_users.wallet_address`, not from a user id, and deliberately does
 * NOT treat it as the implicit `@elizalabs.ai` email grant.
 */
async function seedPlatformAdmin(
  options: SeedOptions & { adminRole?: "super_admin" | "moderator" | "viewer" },
): Promise<{ userId: string; orgId: string | null }> {
  const wallet = `0x${options.stewardUserId
    .replace(/[^a-z0-9]/g, "")
    .padEnd(40, "0")
    .slice(0, 40)}`;
  const seeded = await seedUser({ ...options, walletAddress: wallet });
  await dbWrite.insert(schemas.adminUsers).values({
    userId: seeded.userId,
    walletAddress: wallet,
    role: options.adminRole ?? "super_admin",
    isActive: true,
  });
  return seeded;
}

/** A real HS256 Steward session cookie for `stewardUserId`. */
async function sessionCookie(
  stewardUserId: string,
  ttlSeconds = 3600,
): Promise<string> {
  const minted = await mintStewardTokenFromClaims(
    ENV,
    { userId: stewardUserId, expiration: 0, issuedAt: 0 },
    ttlSeconds,
  );
  if (!minted) throw new Error("test steward mint failed");
  return `steward-token-test=${minted.token}`;
}

function authorizeUrl(
  overrides: Record<string, string | undefined> = {},
): string {
  const params: Record<string, string | undefined> = {
    client_id: FORGEJO_CLIENT_ID,
    redirect_uri: FORGEJO_REDIRECT,
    response_type: "code",
    scope: "openid email profile groups",
    state: "rp-state-value",
    ...overrides,
  };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, value);
  }
  return `/api/oidc/authorize?${search.toString()}`;
}

/** Drive `/authorize` with a live session and return the issued code. */
async function getAuthorizationCode(
  cookie: string,
  overrides: Record<string, string | undefined> = {},
): Promise<{ code: string; state: string | null; location: URL }> {
  const res = await call(authorizeUrl(overrides), { cookie });
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location") as string);
  const code = location.searchParams.get("code");
  expect(code).toMatch(/^eoc_[0-9a-f]{64}$/);
  return {
    code: code as string,
    state: location.searchParams.get("state"),
    location,
  };
}

interface TokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

async function redeem(
  code: string,
  overrides: Record<string, string> = {},
  clientId = FORGEJO_CLIENT_ID,
  secret = FORGEJO_SECRET,
): Promise<Response> {
  const fields = {
    grant_type: "authorization_code",
    code,
    redirect_uri: FORGEJO_REDIRECT,
    ...overrides,
  };
  const { body, headers } = form(fields);
  return call("/api/oidc/token", {
    method: "POST",
    body,
    headers: { ...headers, authorization: basicAuth(clientId, secret) },
  });
}

/**
 * Verify an ID token exactly the way the downstream consumer does: discovery
 * first, byte-equal issuer, then the advertised JWKS.
 */
async function verifyLikeConsumer(
  token: string,
  audience: string,
): Promise<Record<string, unknown>> {
  const discoveryRes = await call("/.well-known/openid-configuration");
  expect(discoveryRes.status).toBe(200);
  const metadata = (await discoveryRes.json()) as {
    issuer: string;
    jwks_uri: string;
  };
  if (metadata.issuer !== ISSUER) throw new Error("oidc_issuer_mismatch");

  const jwksPath = new URL(metadata.jwks_uri).pathname;
  const jwksRes = await call(jwksPath);
  expect(jwksRes.status).toBe(200);
  const jwks = (await jwksRes.json()) as PublishedJwks;

  const payload = await verifyOidcTokenAgainstJwks(token, {
    jwks,
    issuer: metadata.issuer,
    audience,
    tokenClass: "id_token",
  });
  return payload as Record<string, unknown>;
}

/** The published JWKS, fetched the way a consumer fetches it. */
async function publishedJwks(): Promise<PublishedJwks> {
  const res = await call("/.well-known/oidc/jwks.json");
  expect(res.status).toBe(200);
  return (await res.json()) as PublishedJwks;
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";

interface ParkedRequest {
  rid: string;
  /** `name=value` of the binding cookie the provider handed this browser. */
  bindingCookie: string;
  userAgent: string;
}

/**
 * Drive the signed-out leg and keep BOTH halves of what the browser was given:
 * the request id (which travels in the URL) and the binding cookie (which does
 * not). A test that presents only the first is a different browser.
 */
async function parkRequest(
  overrides: Record<string, string | undefined> = {},
  userAgent = BROWSER_UA,
): Promise<ParkedRequest> {
  const bounce = await call(authorizeUrl(overrides), {
    headers: { "user-agent": userAgent },
  });
  expect(bounce.status).toBe(302);
  const returnTo = new URL(
    bounce.headers.get("location") as string,
  ).searchParams.get("returnTo") as string;
  const rid = new URLSearchParams(returnTo.split("?")[1]).get("rid") as string;
  const bindingCookie = (bounce.headers.get("set-cookie") as string).split(
    ";",
  )[0];
  return { rid, bindingCookie, userAgent };
}

/**
 * Resume as the parking browser by default. `bindingCookie: null` is another
 * browser holding only the leaked id; a different `userAgent` is another client
 * holding both.
 */
async function resumeRequest(
  parked: ParkedRequest,
  options: {
    cookie?: string;
    bindingCookie?: string | null;
    userAgent?: string;
  },
): Promise<Response> {
  const binding =
    options.bindingCookie === undefined
      ? parked.bindingCookie
      : options.bindingCookie;
  const cookies = [options.cookie, binding].filter(Boolean).join("; ");
  return call(`/api/oidc/authorize/resume?rid=${parked.rid}`, {
    ...(cookies ? { cookie: cookies } : {}),
    headers: { "user-agent": options.userAgent ?? parked.userAgent },
  });
}

beforeAll(async () => {
  expect(CAN_USE_ISOLATED_PGLITE).toBe(true);

  const signingJwks = JSON.stringify([rsaPrivateJwk("oidc-test-key")]);
  const clients = JSON.stringify([
    {
      client_id: FORGEJO_CLIENT_ID,
      name: "Eliza Hub",
      client_secret_sha256: sha256Hex(FORGEJO_SECRET),
      redirect_uris: [FORGEJO_REDIRECT],
      allowed_scopes: ["openid", "email", "profile", "groups"],
      // Deliberately empty: the relying party's access token must NOT be
      // accepted by the steward control API.
      resource_audiences: [],
      require_pkce: false,
      require_verified_email: true,
      roles_allowlist: [],
      claims_policy: {
        groups: true,
        roles: true,
        tenant_id: true,
        eliza_agents: false,
      },
      // Forgejo maps teams from the native org groups AND decides administrator
      // and restricted status from its own two configured names, so both
      // vocabularies have to survive.
      claims_mapping: {
        mode: "extend",
        roles: {},
        groups: {
          "eliza-cloud:users": ["eliza-team"],
          "eliza-cloud:admins": [FORGEJO_ADMIN_GROUP],
          "eliza-cloud:agents": [FORGEJO_RESTRICTED_GROUP],
          "eliza-cloud:services": [FORGEJO_RESTRICTED_GROUP],
        },
      },
      constant_claims: {
        [FORGEJO_REQUIRED_CLAIM.name]: FORGEJO_REQUIRED_CLAIM.value,
      },
    },
    {
      client_id: CONSOLE_CLIENT_ID,
      name: "Eliza Steward Console",
      client_secret_sha256: sha256Hex(CONSOLE_SECRET),
      redirect_uris: [CONSOLE_REDIRECT],
      allowed_scopes: ["openid", "email", "profile", "groups"],
      // The one client whose ACCESS token the steward control API accepts.
      resource_audiences: [MERGE_STEWARD_AUDIENCE],
      require_pkce: false,
      require_verified_email: true,
      roles_allowlist: [],
      claims_policy: {
        groups: true,
        roles: true,
        tenant_id: true,
        eliza_agents: false,
      },
      // `replace`: a narrow resource server has no use for Eliza Cloud's org
      // uuids or platform-role names, and must not be handed them.
      claims_mapping: {
        mode: "replace",
        roles: {
          org_owner: ["steward", "maintainer"],
          org_admin: ["maintainer"],
          platform_super_admin: ["steward-admin"],
        },
        groups: {
          "eliza-cloud:users": ["eliza-team"],
          "eliza-cloud:admins": ["eliza-admins"],
        },
      },
      constant_claims: {
        [FORGEJO_REQUIRED_CLAIM.name]: FORGEJO_REQUIRED_CLAIM.value,
      },
    },
    {
      client_id: LOWTRUST_CLIENT_ID,
      name: "Low Trust App",
      client_secret_sha256: sha256Hex(LOWTRUST_SECRET),
      redirect_uris: ["https://lowtrust.example/callback"],
      allowed_scopes: ["openid", "email", "profile", "groups"],
      resource_audiences: [STEWARD_AUDIENCE],
      require_pkce: true,
      require_verified_email: false,
      roles_allowlist: ["org_member"],
      claims_policy: {
        groups: false,
        roles: true,
        tenant_id: false,
        eliza_agents: false,
      },
    },
    {
      client_id: PERCENT_CLIENT_ID,
      name: "Percent Secret App",
      client_secret_sha256: sha256Hex(PERCENT_SECRET),
      redirect_uris: [PERCENT_REDIRECT],
      allowed_scopes: ["openid", "email"],
      resource_audiences: [],
      require_pkce: false,
      require_verified_email: false,
      roles_allowlist: [],
      claims_policy: {
        groups: false,
        roles: false,
        tenant_id: false,
        eliza_agents: false,
      },
    },
  ]);

  ENV = {
    NODE_ENV: "test",
    ENVIRONMENT: "test",
    STEWARD_SESSION_SECRET: STEWARD_SECRET,
    STEWARD_TENANT_ID: "elizacloud-test",
    RATE_LIMIT_MULTIPLIER: "500",
    ELIZA_CLOUD_URL: CONSOLE_ORIGIN,
    OIDC_ENABLED: "true",
    OIDC_ISSUER_URL: ISSUER,
    OIDC_SIGNING_JWKS: signingJwks,
    OIDC_CLIENTS: clients,
  };

  const { pushSchema } = await import("@/db/push-schema-for-tests");
  schemas = await import("@/db/schemas");
  ({ dbWrite } = await import("@/db/client"));
  const { apply } = await pushSchema(
    {
      users: schemas.users,
      organizations: schemas.organizations,
      userIdentities: schemas.userIdentities,
      adminRoleEnum: schemas.adminRoleEnum,
      adminUsers: schemas.adminUsers,
      ssoBridgeCodes: schemas.ssoBridgeCodes,
      ssoBridgeLogoutMarkers: schemas.ssoBridgeLogoutMarkers,
      oidcAuthorizationCodes: schemas.oidcAuthorizationCodes,
      oidcAuthorizationRequests: schemas.oidcAuthorizationRequests,
      oidcUserProfiles: schemas.oidcUserProfiles,
    } as never,
    dbWrite as never,
  );
  await apply();

  ({ mintStewardTokenFromClaims } = await import("@/lib/auth/steward-client"));
  ({ verifyOidcTokenAgainstJwks } = await import("@/lib/oidc/tokens"));
  const { runWithCloudBindingsAsync } = await import(
    "@/lib/runtime/cloud-bindings"
  );

  const [discovery, oidcJwks, authorize, token, userinfo] = await Promise.all([
    import("../.well-known/openid-configuration/route"),
    import("../.well-known/oidc/jwks.json/route"),
    import("../oidc/authorize/route"),
    import("../oidc/token/route"),
    import("../oidc/userinfo/route"),
  ]);

  harness = new Hono();
  // Mirrors bootstrap-app: shared library code reads secrets through
  // getCloudAwareEnv(), which is backed by this AsyncLocalStorage store.
  harness.use("*", async (c, next) =>
    runWithCloudBindingsAsync(c.env as Record<string, unknown>, () => next()),
  );
  harness.route("/.well-known/openid-configuration", discovery.default);
  harness.route("/.well-known/oidc/jwks.json", oidcJwks.default);
  harness.route("/api/oidc/authorize", authorize.default);
  harness.route("/api/oidc/token", token.default);
  harness.route("/api/oidc/userinfo", userinfo.default);
});

afterAll(async () => {
  setSystemTime();
  const { closeDatabaseConnectionsForTests } = await import("@/db/client");
  await closeDatabaseConnectionsForTests();
});

describe("discovery document", () => {
  test("issuer byte-equals OIDC_ISSUER_URL — the check the consumer hard-fails on", async () => {
    const res = await call("/.well-known/openid-configuration");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc.issuer).toBe(ISSUER);
    expect(doc.issuer).not.toBe(`${ISSUER}/`);
  });

  test("advertises the shape the authorization-code flow actually implements", async () => {
    const doc = (await (
      await call("/.well-known/openid-configuration")
    ).json()) as Record<string, unknown>;
    expect(doc.response_types_supported).toEqual(["code"]);
    expect(doc.grant_types_supported).toEqual(["authorization_code"]);
    expect(doc.subject_types_supported).toEqual(["public"]);
    expect(doc.code_challenge_methods_supported).toEqual(["S256"]);
    expect(doc.id_token_signing_alg_values_supported).toEqual(["RS256"]);
    expect(doc.token_endpoint_auth_methods_supported).toEqual([
      "client_secret_basic",
      "client_secret_post",
    ]);
    // Nothing unimplemented is advertised: a relying party that sees these
    // would build a flow that silently never works.
    for (const absent of [
      "registration_endpoint",
      "end_session_endpoint",
      "revocation_endpoint",
      "introspection_endpoint",
      "check_session_iframe",
    ]) {
      expect(doc).not.toHaveProperty(absent);
    }
  });

  test("every claim in the SSO contract is advertised", async () => {
    const doc = (await (
      await call("/.well-known/openid-configuration")
    ).json()) as {
      claims_supported: string[];
    };
    for (const claim of [
      "sub",
      "email",
      "email_verified",
      "preferred_username",
      "nickname",
      "name",
      "picture",
      "groups",
      "roles",
      "tenant_id",
      "eliza_agent_id",
      "eliza_agent_ids",
      "eliza_actor_id",
      "eliza_account_kind",
    ]) {
      expect(doc.claims_supported).toContain(claim);
    }
  });

  test("every advertised endpoint is on the issuer origin and is a MOUNTED route", async () => {
    const doc = (await (
      await call("/.well-known/openid-configuration")
    ).json()) as Record<string, string>;
    const generated = readFileSync(
      join(API_ROOT, "src/_router.generated.ts"),
      "utf8",
    );
    const bootstrap = readFileSync(
      join(API_ROOT, "src/bootstrap-app.ts"),
      "utf8",
    );
    const mounted = `${generated}\n${bootstrap}`;

    for (const key of [
      "authorization_endpoint",
      "token_endpoint",
      "userinfo_endpoint",
      "jwks_uri",
    ]) {
      const url = new URL(doc[key]);
      expect(url.origin).toBe(ISSUER);
      // Proven mounted in the real router, not only in this test's harness.
      expect(mounted).toContain(`"${url.pathname}"`);
    }
  });

  test("the JWKS publishes only public key material", async () => {
    const res = await call("/.well-known/oidc/jwks.json");
    expect(res.status).toBe(200);
    const { keys } = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(keys).toHaveLength(1);
    expect(keys[0].kid).toBe("oidc-test-key");
    expect(keys[0].alg).toBe("RS256");
    for (const member of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]) {
      expect(keys[0]).not.toHaveProperty(member);
    }
  });

  test("neither document is served on a non-issuer host", async () => {
    // The Worker answers *.elizacloud.ai, including hosts that serve
    // user-controlled content; only the issuer host may advertise this OP.
    for (const path of [
      "/.well-known/openid-configuration",
      "/.well-known/oidc/jwks.json",
    ]) {
      const res = await call(path, { host: "abc123.apps.elizacloud.test" });
      expect(res.status).toBe(404);
    }
  });
});

describe("authorize — validation that must never redirect", () => {
  test("an unknown client renders an error page with NO Location header", async () => {
    const cookie = await sessionCookie("u-unknown-client");
    await seedUser({ stewardUserId: "u-unknown-client" });
    const res = await call(authorizeUrl({ client_id: "not-registered" }), {
      cookie,
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  test("a near-miss redirect_uri is refused in place — the open-redirect guard", async () => {
    await seedUser({ stewardUserId: "u-redirect" });
    const cookie = await sessionCookie("u-redirect");
    for (const redirect of [
      "https://hub.elizacloud.test/user/oauth2/elizacloud/callback/",
      "https://hub.elizacloud.test/user/oauth2/elizacloud/callback?x=1",
      "https://hub.elizacloud.test.evil.example/user/oauth2/elizacloud/callback",
      "https://evil.example/steal",
      "HTTPS://hub.elizacloud.test/user/oauth2/elizacloud/callback",
    ]) {
      const res = await call(authorizeUrl({ redirect_uri: redirect }), {
        cookie,
      });
      expect(res.status).toBe(400);
      expect(res.headers.get("location")).toBeNull();
    }
  });

  test("a missing redirect_uri is refused in place", async () => {
    const res = await call(authorizeUrl({ redirect_uri: undefined }));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("authorize — protocol errors redirect to the validated URI", () => {
  test("a non-code response_type is refused with state echoed", async () => {
    const res = await call(authorizeUrl({ response_type: "token" }));
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") as string);
    expect(location.origin + location.pathname).toBe(FORGEJO_REDIRECT);
    expect(location.searchParams.get("error")).toBe(
      "unsupported_response_type",
    );
    expect(location.searchParams.get("state")).toBe("rp-state-value");
    expect(location.searchParams.get("code")).toBeNull();
  });

  test("a request without the openid scope is refused", async () => {
    const res = await call(authorizeUrl({ scope: "email profile" }));
    const location = new URL(res.headers.get("location") as string);
    expect(location.searchParams.get("error")).toBe("invalid_scope");
  });

  test("a plain PKCE challenge is refused — S256 only", async () => {
    const res = await call(
      authorizeUrl({ code_challenge: "abc", code_challenge_method: "plain" }),
    );
    const location = new URL(res.headers.get("location") as string);
    expect(location.searchParams.get("error")).toBe("invalid_request");
  });

  test("a client marked require_pkce is refused without a challenge", async () => {
    const res = await call(
      `/api/oidc/authorize?${new URLSearchParams({
        client_id: LOWTRUST_CLIENT_ID,
        redirect_uri: "https://lowtrust.example/callback",
        response_type: "code",
        scope: "openid",
        state: "s",
      })}`,
    );
    const location = new URL(res.headers.get("location") as string);
    expect(location.searchParams.get("error")).toBe("invalid_request");
  });

  test("a request with neither state nor PKCE is refused", async () => {
    const res = await call(authorizeUrl({ state: undefined }));
    const location = new URL(res.headers.get("location") as string);
    expect(location.searchParams.get("error")).toBe("invalid_request");
  });

  test("prompt=none without a session returns login_required instead of bouncing", async () => {
    const res = await call(authorizeUrl({ prompt: "none" }));
    const location = new URL(res.headers.get("location") as string);
    expect(location.searchParams.get("error")).toBe("login_required");
  });
});

describe("authorize — session gating", () => {
  test("a signed-out browser parks the request and bounces through the console login", async () => {
    const res = await call(authorizeUrl(), {
      headers: { "user-agent": BROWSER_UA },
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") as string);
    expect(location.origin).toBe(CONSOLE_ORIGIN);
    expect(location.pathname).toBe("/login");
    // returnTo must be a SAME-ORIGIN PATH: the console's sanitizer silently
    // drops an absolute URL, which is why the request is parked by id.
    const returnTo = location.searchParams.get("returnTo") as string;
    expect(returnTo.startsWith("/")).toBe(true);
    expect(returnTo.startsWith("//")).toBe(false);
    expect(returnTo).toMatch(/^\/oidc\/continue\?rid=eoq_[0-9a-f]{64}$/);

    // The parked request is bound to THIS browser by a cookie only it holds,
    // scoped to the resume path and unreadable from script.
    const setCookie = res.headers.get("set-cookie") as string;
    expect(setCookie).toMatch(/^eliza-oidc-bind_[0-9a-f]{16}=[0-9a-f]{64}/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/api/oidc/authorize/resume");
    expect(setCookie).toContain("Max-Age=600");
  });

  test("a garbage cookie is treated as signed out, not as an error", async () => {
    const res = await call(authorizeUrl(), {
      cookie: "steward-token-test=not-a-jwt",
    });
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location") as string).pathname).toBe(
      "/login",
    );
  });

  test("a valid session whose user row does not exist does NOT provision an account", async () => {
    // getCurrentUser would JIT-create here; account creation must never be a
    // side effect of a relying party sending a browser to /authorize.
    const cookie = await sessionCookie("u-never-provisioned");
    const res = await call(authorizeUrl(), { cookie });
    expect(new URL(res.headers.get("location") as string).pathname).toBe(
      "/login",
    );

    const rows = await dbWrite
      .select()
      .from(schemas.users)
      .where(
        require("drizzle-orm").eq(
          schemas.users.steward_user_id,
          "u-never-provisioned",
        ),
      );
    expect(rows).toHaveLength(0);
  });

  test("the resume leg completes a parked request once the session exists", async () => {
    const parked = await parkRequest({ state: "resume-state" });

    await seedUser({ stewardUserId: "u-resume" });
    const cookie = await sessionCookie("u-resume");
    const resumed = await resumeRequest(parked, { cookie });
    expect(resumed.status).toBe(302);
    const location = new URL(resumed.headers.get("location") as string);
    expect(location.origin + location.pathname).toBe(FORGEJO_REDIRECT);
    expect(location.searchParams.get("code")).toMatch(/^eoc_[0-9a-f]{64}$/);
    expect(location.searchParams.get("state")).toBe("resume-state");

    // Parked requests are single use.
    const replay = await resumeRequest(parked, { cookie });
    expect(replay.status).toBe(400);
  });

  test("resuming while still signed out shows a terminal page rather than looping", async () => {
    const parked = await parkRequest();
    const res = await resumeRequest(parked, {});
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("authorize — the parked request is bound to one browser", () => {
  test("a leaked rid is useless to a browser that never parked it", async () => {
    // The whole attack this binding exists for: the id travels in a URL —
    // through returnTo, history, a Referer, an access log — so a second browser
    // that learns it must not be able to finish the first one's sign-in.
    const parked = await parkRequest({ state: "victim-state" });
    await seedUser({ stewardUserId: "u-bind-attacker" });
    const attackerCookie = await sessionCookie("u-bind-attacker");

    const stolen = await resumeRequest(parked, {
      cookie: attackerCookie,
      bindingCookie: null,
    });
    expect(stolen.status).toBe(400);
    expect(stolen.headers.get("location")).toBeNull();
    // No code was minted for anybody.
    expect(await stolen.text()).not.toContain("eoc_");
  });

  test("a guessed or borrowed binding cookie does not help either", async () => {
    const parked = await parkRequest();
    await seedUser({ stewardUserId: "u-bind-guess" });
    const cookie = await sessionCookie("u-bind-guess");

    const forged = `${parked.bindingCookie.split("=")[0]}=${"9".repeat(64)}`;
    const res = await resumeRequest(parked, { cookie, bindingCookie: forged });
    expect(res.status).toBe(400);
  });

  test("the same cookie from a different client is refused: the user agent is bound too", async () => {
    const parked = await parkRequest();
    await seedUser({ stewardUserId: "u-bind-ua" });
    const cookie = await sessionCookie("u-bind-ua");

    const res = await resumeRequest(parked, {
      cookie,
      userAgent: "curl/8.7.1",
    });
    expect(res.status).toBe(400);
  });

  test("a refused resume burns the parked request, so the id cannot be probed twice", async () => {
    const parked = await parkRequest();
    await seedUser({ stewardUserId: "u-bind-burn" });
    const cookie = await sessionCookie("u-bind-burn");

    expect(
      (await resumeRequest(parked, { cookie, bindingCookie: null })).status,
    ).toBe(400);
    // Even the rightful browser now gets nothing: the row is gone.
    expect((await resumeRequest(parked, { cookie })).status).toBe(400);
  });

  test("two sign-ins started in one browser both resume: the cookie is per request", async () => {
    const first = await parkRequest({ state: "first" });
    const second = await parkRequest({ state: "second" });
    expect(first.bindingCookie.split("=")[0]).not.toBe(
      second.bindingCookie.split("=")[0],
    );

    await seedUser({ stewardUserId: "u-bind-parallel" });
    const cookie = await sessionCookie("u-bind-parallel");
    // Both binding cookies are present, exactly as a real browser would send
    // them; each resume must pick its own.
    const both = `${first.bindingCookie}; ${second.bindingCookie}`;
    for (const [parked, state] of [
      [second, "second"],
      [first, "first"],
    ] as const) {
      const res = await resumeRequest(parked, { cookie, bindingCookie: both });
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") as string);
      expect(location.searchParams.get("state")).toBe(state);
      expect(location.searchParams.get("code")).toMatch(/^eoc_[0-9a-f]{64}$/);
    }
  });

  test("a successful resume clears the binding cookie it consumed", async () => {
    const parked = await parkRequest();
    await seedUser({ stewardUserId: "u-bind-clear" });
    const res = await resumeRequest(parked, {
      cookie: await sessionCookie("u-bind-clear"),
    });
    expect(res.status).toBe(302);
    const cleared = res.headers.get("set-cookie") as string;
    expect(cleared).toContain(parked.bindingCookie.split("=")[0]);
    expect(cleared).toContain("Max-Age=0");
  });
});

describe("authorize — subject eligibility", () => {
  test("an anonymous account cannot become a relying-party identity", async () => {
    await seedUser({ stewardUserId: "u-anon", isAnonymous: true });
    const res = await call(authorizeUrl(), {
      cookie: await sessionCookie("u-anon"),
    });
    const location = new URL(res.headers.get("location") as string);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("error_description")).toBe(
      "user_anonymous",
    );
  });

  test("a deactivated account is refused", async () => {
    await seedUser({ stewardUserId: "u-inactive", isActive: false });
    const res = await call(authorizeUrl(), {
      cookie: await sessionCookie("u-inactive"),
    });
    expect(
      new URL(res.headers.get("location") as string).searchParams.get("error"),
    ).toBe("access_denied");
  });

  test("an unverified email is refused — the gate before automatic account creation", async () => {
    await seedUser({ stewardUserId: "u-unverified", emailVerified: false });
    const res = await call(authorizeUrl(), {
      cookie: await sessionCookie("u-unverified"),
    });
    const location = new URL(res.headers.get("location") as string);
    expect(location.searchParams.get("error_description")).toBe(
      "email_unverified",
    );
  });

  test("a verified flag with NO address is refused, not silently allowed", async () => {
    // The plaintext email column is nullable through the field-encryption
    // rollout; a relying party set to auto-create accounts would otherwise
    // start creating them with no address at all.
    await seedUser({
      stewardUserId: "u-nullemail",
      email: null,
      emailVerified: true,
    });
    const res = await call(authorizeUrl(), {
      cookie: await sessionCookie("u-nullemail"),
    });
    const location = new URL(res.headers.get("location") as string);
    expect(location.searchParams.get("error_description")).toBe(
      "email_unverified",
    );
  });

  test("an explicit sign-out blocks a still-unexpired cookie from starting a new login", async () => {
    await seedUser({ stewardUserId: "u-loggedout" });
    const cookie = await sessionCookie("u-loggedout");
    const { markSsoBridgeLogout } = await import(
      "@/lib/services/sso-bridge-codes"
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await markSsoBridgeLogout("u-loggedout");

    const res = await call(authorizeUrl(), { cookie });
    // Treated as signed out: a fresh login works again immediately.
    expect(new URL(res.headers.get("location") as string).pathname).toBe(
      "/login",
    );
  });
});

describe("code redemption", () => {
  test("the full authorize → token → userinfo round trip", async () => {
    const { userId } = await seedUser({
      stewardUserId: "u-happy",
      nickname: "ada",
      orgSlug: "happy-org",
    });
    const cookie = await sessionCookie("u-happy");
    const { code, state } = await getAuthorizationCode(cookie);
    expect(state).toBe("rp-state-value");

    const res = await redeem(code);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as TokenResponse;
    expect(body.token_type).toBe("Bearer");
    expect(body.scope).toBe("openid email profile groups");
    expect(body).not.toHaveProperty("refresh_token");

    const idClaims = await verifyLikeConsumer(body.id_token, FORGEJO_CLIENT_ID);
    expect(idClaims.sub).toBe(userId);
    expect(idClaims.email).toBe("u-happy@example.com");
    expect(idClaims.email_verified).toBe(true);
    expect(idClaims.preferred_username).toBe("ada");
    expect(idClaims.nickname).toBe("ada");
    expect(idClaims.name).toBe("Ada Lovelace");
    expect(idClaims.picture).toBe("https://cdn.example.com/ada.png");
    expect(idClaims.groups).toContain("eliza-cloud:users");
    expect(idClaims.groups).toContain("org:happy-org");
    expect(idClaims.roles).toEqual(["org_owner"]);
    expect(idClaims.tenant_id).toBe("tenant-u-happy");
    expect(idClaims.eliza_account_kind).toBe("human");
    expect(idClaims.eliza_actor_id).toBe(userId);
    expect(idClaims.azp).toBe(FORGEJO_CLIENT_ID);
    // No auth_time: this provider never authenticates anyone and the Steward
    // token's `iat` moves on every refresh, so any value here would claim an
    // authentication that did not happen. It is also absent from discovery.
    expect(idClaims).not.toHaveProperty("auth_time");
    const discovery = (await (
      await call("/.well-known/openid-configuration")
    ).json()) as { claims_supported: string[] };
    expect(discovery.claims_supported).not.toContain("auth_time");

    const userinfo = await call("/api/oidc/userinfo", {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(userinfo.status).toBe(200);
    const info = (await userinfo.json()) as Record<string, unknown>;
    expect(info.sub).toBe(userId);
    expect(info.preferred_username).toBe("ada");
    expect(info.email).toBe("u-happy@example.com");
  });

  test("the nonce is echoed into the ID token and nowhere else", async () => {
    await seedUser({ stewardUserId: "u-nonce" });
    const cookie = await sessionCookie("u-nonce");
    const { code } = await getAuthorizationCode(cookie, {
      nonce: "rp-nonce-42",
    });
    const body = (await (await redeem(code)).json()) as TokenResponse;
    const claims = await verifyLikeConsumer(body.id_token, FORGEJO_CLIENT_ID);
    expect(claims.nonce).toBe("rp-nonce-42");
  });

  test("client_secret_post authenticates too — Go's oauth2 client probes both", async () => {
    await seedUser({ stewardUserId: "u-postauth" });
    const cookie = await sessionCookie("u-postauth");
    const { code } = await getAuthorizationCode(cookie);
    const { body, headers } = form({
      grant_type: "authorization_code",
      code,
      redirect_uri: FORGEJO_REDIRECT,
      client_id: FORGEJO_CLIENT_ID,
      client_secret: FORGEJO_SECRET,
    });
    const res = await call("/api/oidc/token", {
      method: "POST",
      body,
      headers,
    });
    expect(res.status).toBe(200);
  });

  test("a wrong client secret fails as invalid_client WITHOUT burning the code", async () => {
    await seedUser({ stewardUserId: "u-badsecret" });
    const cookie = await sessionCookie("u-badsecret");
    const { code } = await getAuthorizationCode(cookie);

    const bad = await redeem(code, {}, FORGEJO_CLIENT_ID, "wrong-secret");
    expect(bad.status).toBe(401);
    expect(((await bad.json()) as { error: string }).error).toBe(
      "invalid_client",
    );
    expect(bad.headers.get("www-authenticate")).toContain("Basic");

    // Client auth runs BEFORE the claim, so an unauthenticated caller cannot
    // destroy a pending authorization it does not own.
    const good = await redeem(code);
    expect(good.status).toBe(200);
  });

  test("a code issued to one client cannot be redeemed by another", async () => {
    await seedUser({ stewardUserId: "u-crossclient" });
    const cookie = await sessionCookie("u-crossclient");
    const { code } = await getAuthorizationCode(cookie);
    const res = await redeem(code, {}, LOWTRUST_CLIENT_ID, LOWTRUST_SECRET);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  test("a mismatched redirect_uri at redemption fails as invalid_grant", async () => {
    await seedUser({ stewardUserId: "u-redirectmismatch" });
    const cookie = await sessionCookie("u-redirectmismatch");
    const { code } = await getAuthorizationCode(cookie);
    const res = await redeem(code, {
      redirect_uri: "https://lowtrust.example/callback",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  test("a replayed code fails — single use", async () => {
    await seedUser({ stewardUserId: "u-replay" });
    const cookie = await sessionCookie("u-replay");
    const { code } = await getAuthorizationCode(cookie);
    expect((await redeem(code)).status).toBe(200);
    const replay = await redeem(code);
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  test("RACE: two concurrent redemptions of one code yield exactly one token", async () => {
    await seedUser({ stewardUserId: "u-race" });
    const cookie = await sessionCookie("u-race");
    const { code } = await getAuthorizationCode(cookie);
    const [a, b] = await Promise.all([redeem(code), redeem(code)]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
  });

  test("an expired code fails", async () => {
    await seedUser({ stewardUserId: "u-expired" });
    const cookie = await sessionCookie("u-expired");
    const { code } = await getAuthorizationCode(cookie);
    const realNow = Date.now();
    try {
      setSystemTime(new Date(realNow + 61_000));
      const res = await redeem(code);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "invalid_grant",
      );
    } finally {
      setSystemTime();
    }
  });

  test("an unknown code fails without an oracle", async () => {
    const res = await redeem(`eoc_${"f".repeat(64)}`);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  test("only authorization_code is granted", async () => {
    const res = await redeem("eoc_x", { grant_type: "refresh_token" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "unsupported_grant_type",
    );
  });

  test("a user deactivated inside the code window cannot complete the exchange", async () => {
    const { userId } = await seedUser({ stewardUserId: "u-deactivated" });
    const cookie = await sessionCookie("u-deactivated");
    const { code } = await getAuthorizationCode(cookie);

    const { eq } = await import("drizzle-orm");
    await dbWrite
      .update(schemas.users)
      .set({ is_active: false })
      .where(eq(schemas.users.id, userId));

    const res = await redeem(code);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });
});

describe("PKCE", () => {
  const VERIFIER = "pkce-verifier-0123456789-abcdefghijklmnopqrstuvwxyz";

  async function challengeFor(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    return Buffer.from(new Uint8Array(digest)).toString("base64url");
  }

  test("a correct verifier completes the exchange", async () => {
    await seedUser({ stewardUserId: "u-pkce-ok" });
    const cookie = await sessionCookie("u-pkce-ok");
    const { code } = await getAuthorizationCode(cookie, {
      code_challenge: await challengeFor(VERIFIER),
      code_challenge_method: "S256",
    });
    const res = await redeem(code, { code_verifier: VERIFIER });
    expect(res.status).toBe(200);
  });

  test("a wrong verifier fails and the code is already burned", async () => {
    await seedUser({ stewardUserId: "u-pkce-bad" });
    const cookie = await sessionCookie("u-pkce-bad");
    const { code } = await getAuthorizationCode(cookie, {
      code_challenge: await challengeFor(VERIFIER),
      code_challenge_method: "S256",
    });

    const wrong = await redeem(code, { code_verifier: "not-the-verifier" });
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );

    // The atomic claim already destroyed it, so the real verifier loses too —
    // a stolen code presented first cannot leave a live handshake behind.
    const right = await redeem(code, { code_verifier: VERIFIER });
    expect(right.status).toBe(400);
  });

  test("a missing verifier fails when the code was bound to a challenge", async () => {
    await seedUser({ stewardUserId: "u-pkce-missing" });
    const cookie = await sessionCookie("u-pkce-missing");
    const { code } = await getAuthorizationCode(cookie, {
      code_challenge: await challengeFor(VERIFIER),
      code_challenge_method: "S256",
    });
    const res = await redeem(code);
    expect(res.status).toBe(400);
  });

  test("a challenge that is not a SHA-256 digest is refused at authorize", async () => {
    // Declaring S256 does not make the value one. Redemption compares it to
    // `base64url(sha256(verifier))`, so any other shape can only fail there —
    // after the user has signed in and the code is already burned. The relying
    // party must learn while it still has an error it can act on.
    const challenge = await challengeFor(VERIFIER);
    for (const bad of [
      "abc",
      challenge.slice(0, 42),
      `${challenge}A`,
      `${challenge.slice(0, 42)}=`,
      `${challenge.slice(0, 42)}+`,
      `${challenge.slice(0, 42)}/`,
      `${challenge.slice(0, 41)}%20`,
      "A".repeat(128),
    ]) {
      const res = await call(
        authorizeUrl({ code_challenge: bad, code_challenge_method: "S256" }),
      );
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") as string);
      expect(location.origin + location.pathname).toBe(FORGEJO_REDIRECT);
      expect(location.searchParams.get("error")).toBe("invalid_request");
      expect(location.searchParams.get("code")).toBeNull();
    }
  });

  test("a require_pkce client cannot satisfy the requirement with junk", async () => {
    // Otherwise the flag reads as satisfied while the code is bound to a
    // challenge no verifier can ever produce.
    const res = await call(
      `/api/oidc/authorize?${new URLSearchParams({
        client_id: LOWTRUST_CLIENT_ID,
        redirect_uri: "https://lowtrust.example/callback",
        response_type: "code",
        scope: "openid",
        state: "s",
        code_challenge: "not-a-digest",
        code_challenge_method: "S256",
      })}`,
    );
    const location = new URL(res.headers.get("location") as string);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("code")).toBeNull();
  });

  test("the 43-character digest a real client sends is still accepted", async () => {
    const challenge = await challengeFor(VERIFIER);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await seedUser({ stewardUserId: "u-pkce-shape-ok" });
    const { code } = await getAuthorizationCode(
      await sessionCookie("u-pkce-shape-ok"),
      { code_challenge: challenge, code_challenge_method: "S256" },
    );
    const res = await redeem(code, { code_verifier: VERIFIER });
    expect(res.status).toBe(200);
  });
});

/**
 * Reproduces `assertRequiredClaimIntersection` from hub
 * `services/merge-steward/src/oidc-auth.js` — the verifier throws
 * `oidc_missing_<claim>` unless the token's list intersects the configured one.
 */
function intersects(value: unknown, required: string[]): boolean {
  if (required.length === 0) return true;
  const actual = new Set(
    Array.isArray(value)
      ? value.map(String)
      : typeof value === "string"
        ? value.split(/[,\s]+/).filter(Boolean)
        : [],
  );
  return required.some((item) => actual.has(item));
}

/** Drive the full flow for the steward-console client and return its tokens. */
async function redeemAsConsole(
  stewardUserId: string,
  overrides: Record<string, string | undefined> = {},
): Promise<TokenResponse> {
  const cookie = await sessionCookie(stewardUserId);
  const res = await call(
    authorizeUrl({
      client_id: CONSOLE_CLIENT_ID,
      redirect_uri: CONSOLE_REDIRECT,
      ...overrides,
    }),
    { cookie },
  );
  expect(res.status).toBe(302);
  const code = new URL(res.headers.get("location") as string).searchParams.get(
    "code",
  ) as string;
  const tokenRes = await redeem(
    code,
    { redirect_uri: CONSOLE_REDIRECT },
    CONSOLE_CLIENT_ID,
    CONSOLE_SECRET,
  );
  expect(tokenRes.status).toBe(200);
  return (await tokenRes.json()) as TokenResponse;
}

describe("Forgejo login gate", () => {
  test("the required claim carries ONE fixed value every admitted user shares", async () => {
    // `forgejo admin auth add-oauth --required-claim-name tenant
    // --required-claim-value eliza` reads gothUser.RawData["tenant"] and rejects
    // the login unless it equals that single value. A per-user or per-org claim
    // can never satisfy it.
    const first = await seedUser({
      stewardUserId: "u-claim-a",
      orgSlug: "org-a",
    });
    const second = await seedUser({
      stewardUserId: "u-claim-b",
      orgSlug: "org-b",
    });
    expect(first.orgId).not.toBe(second.orgId);

    const claims = await Promise.all(
      ["u-claim-a", "u-claim-b"].map(async (stewardUserId) => {
        const cookie = await sessionCookie(stewardUserId);
        const { code } = await getAuthorizationCode(cookie);
        const body = (await (await redeem(code)).json()) as TokenResponse;
        return verifyLikeConsumer(body.id_token, FORGEJO_CLIENT_ID);
      }),
    );

    for (const claim of claims) {
      expect(claim[FORGEJO_REQUIRED_CLAIM.name]).toBe(
        FORGEJO_REQUIRED_CLAIM.value,
      );
    }
    // tenant_id stays what it is: the per-organization Steward tenant. It is
    // NOT interchangeable with the login gate, which is the whole point.
    expect(claims[0]?.tenant_id).not.toBe(claims[1]?.tenant_id);
  });

  test("userinfo carries it too — goth reads RawData from that response", async () => {
    await seedUser({ stewardUserId: "u-claim-userinfo" });
    const cookie = await sessionCookie("u-claim-userinfo");
    const { code } = await getAuthorizationCode(cookie);
    const body = (await (await redeem(code)).json()) as TokenResponse;

    const info = (await (
      await call("/api/oidc/userinfo", {
        headers: { authorization: `Bearer ${body.access_token}` },
      })
    ).json()) as Record<string, unknown>;
    expect(info[FORGEJO_REQUIRED_CLAIM.name]).toBe(
      FORGEJO_REQUIRED_CLAIM.value,
    );
  });

  test("the admin group Forgejo is configured with is emitted for an admin", async () => {
    await seedPlatformAdmin({ stewardUserId: "u-fj-admin" });

    const cookie = await sessionCookie("u-fj-admin");
    const { code } = await getAuthorizationCode(cookie);
    const body = (await (await redeem(code)).json()) as TokenResponse;
    const claims = await verifyLikeConsumer(body.id_token, FORGEJO_CLIENT_ID);

    expect(claims.groups).toContain(FORGEJO_ADMIN_GROUP);
    // `extend` keeps the native vocabulary the team-sync job reads.
    expect(claims.groups).toContain("eliza-cloud:admins");
  });

  test("the restricted group is emitted for an agent account and for nobody else", async () => {
    // `--restricted-group eliza-agents` is the only knob Forgejo has for
    // admitting a non-human account on narrower terms, and it reads a GROUP —
    // `eliza_account_kind` is a claim it never looks at.
    const agent = await seedUser({
      stewardUserId: "u-fj-agent",
      orgSlug: "fj-agent-org",
    });
    await dbWrite.insert(schemas.oidcUserProfiles).values({
      user_id: agent.userId,
      username: "u-fj-agent",
      account_kind: "agent",
      agent_id: "agent-7",
    });

    const agentCode = await getAuthorizationCode(
      await sessionCookie("u-fj-agent"),
    );
    const agentTokens = (await (
      await redeem(agentCode.code)
    ).json()) as TokenResponse;
    const agentClaims = await verifyLikeConsumer(
      agentTokens.id_token,
      FORGEJO_CLIENT_ID,
    );
    expect(agentClaims.groups).toContain(FORGEJO_RESTRICTED_GROUP);
    expect(agentClaims.groups).not.toContain(FORGEJO_ADMIN_GROUP);
    expect(agentClaims.eliza_account_kind).toBe("agent");

    await seedUser({ stewardUserId: "u-fj-human", orgSlug: "fj-human-org" });
    const humanCode = await getAuthorizationCode(
      await sessionCookie("u-fj-human"),
    );
    const humanTokens = (await (
      await redeem(humanCode.code)
    ).json()) as TokenResponse;
    const humanClaims = await verifyLikeConsumer(
      humanTokens.id_token,
      FORGEJO_CLIENT_ID,
    );
    expect(humanClaims.groups).toContain("eliza-team");
    expect(humanClaims.groups).not.toContain(FORGEJO_RESTRICTED_GROUP);
  });

  test("the discovery document advertises the constant claim", async () => {
    const doc = (await (
      await call("/.well-known/openid-configuration")
    ).json()) as { claims_supported: string[] };
    expect(doc.claims_supported).toContain(FORGEJO_REQUIRED_CLAIM.name);
    expect(doc.claims_supported).toContain("tenant_id");
  });
});

describe("Merge Steward consumer contract", () => {
  test("an access token passes audience, roles, and groups as shipped", async () => {
    await seedUser({ stewardUserId: "u-ms-owner", orgSlug: "ms-org" });
    const tokens = await redeemAsConsole("u-ms-owner");

    const jwks = (await (
      await call("/.well-known/oidc/jwks.json")
    ).json()) as PublishedJwks;
    // Exactly what createOidcVerifier does: remote JWKS, pinned issuer, pinned
    // audience — then the two claim intersections.
    const payload = await verifyOidcTokenAgainstJwks(tokens.access_token, {
      jwks,
      issuer: ISSUER,
      audience: MERGE_STEWARD_AUDIENCE,
      tokenClass: "access_token",
    });

    expect(intersects(payload.roles, MERGE_STEWARD_REQUIRED_ROLES)).toBe(true);
    expect(intersects(payload.groups, MERGE_STEWARD_REQUIRED_GROUPS)).toBe(
      true,
    );
    expect(payload.roles).toEqual(["steward", "maintainer"]);
    expect(payload.groups).toEqual(["eliza-team"]);
  });

  test("replace mode keeps org uuids and platform role names out of the token", async () => {
    const { orgId } = await seedUser({
      stewardUserId: "u-ms-leak",
      orgSlug: "ms-leak",
    });
    const tokens = await redeemAsConsole("u-ms-leak");
    const claims = await verifyLikeConsumer(tokens.id_token, CONSOLE_CLIENT_ID);

    expect(JSON.stringify(claims.groups)).not.toContain(orgId);
    expect(claims.groups).not.toContain("eliza-cloud:users");
    expect(claims.roles).not.toContain("org_owner");
  });

  test("a platform admin clears the privileged-operator gate; a plain member does not", async () => {
    await seedPlatformAdmin({
      stewardUserId: "u-ms-admin",
      orgSlug: "ms-admin-org",
    });
    const adminTokens = await redeemAsConsole("u-ms-admin");
    const admin = await verifyLikeConsumer(
      adminTokens.id_token,
      CONSOLE_CLIENT_ID,
    );
    expect(intersects(admin.roles, MERGE_STEWARD_ADMIN_ROLES)).toBe(true);
    expect(intersects(admin.groups, MERGE_STEWARD_ADMIN_GROUPS)).toBe(true);

    await seedUser({
      stewardUserId: "u-ms-member",
      orgSlug: "ms-member-org",
      role: "member",
    });
    const memberTokens = await redeemAsConsole("u-ms-member");
    const member = await verifyLikeConsumer(
      memberTokens.id_token,
      CONSOLE_CLIENT_ID,
    );
    // org_member has no mapping, and `replace` drops what it cannot map: the
    // member is admitted to nothing rather than silently to everything.
    expect(member.roles).toEqual([]);
    expect(intersects(member.roles, MERGE_STEWARD_REQUIRED_ROLES)).toBe(false);
    expect(intersects(member.roles, MERGE_STEWARD_ADMIN_ROLES)).toBe(false);
    // The group gate is org-membership-wide and still passes.
    expect(intersects(member.groups, MERGE_STEWARD_REQUIRED_GROUPS)).toBe(true);
    expect(intersects(member.groups, MERGE_STEWARD_ADMIN_GROUPS)).toBe(false);
  });

  test("the Forgejo login client's token is still refused at the steward audience", async () => {
    await seedUser({ stewardUserId: "u-ms-crossuse" });
    const cookie = await sessionCookie("u-ms-crossuse");
    const { code } = await getAuthorizationCode(cookie);
    const body = (await (await redeem(code)).json()) as TokenResponse;

    const jwks = (await (
      await call("/.well-known/oidc/jwks.json")
    ).json()) as PublishedJwks;
    await expect(
      verifyOidcTokenAgainstJwks(body.access_token, {
        jwks,
        issuer: ISSUER,
        audience: MERGE_STEWARD_AUDIENCE,
        tokenClass: "access_token",
      }),
    ).rejects.toThrow();
  });
});

describe("token audiences", () => {
  test("the relying party's access token is NOT accepted as a steward credential", async () => {
    await seedUser({ stewardUserId: "u-aud" });
    const cookie = await sessionCookie("u-aud");
    const { code } = await getAuthorizationCode(cookie);
    const body = (await (await redeem(code)).json()) as TokenResponse;

    const jwks = (await (
      await call("/.well-known/oidc/jwks.json")
    ).json()) as PublishedJwks;

    const payload = await verifyOidcTokenAgainstJwks(body.access_token, {
      jwks,
      issuer: ISSUER,
      audience: FORGEJO_CLIENT_ID,
      tokenClass: "access_token",
    });
    expect(payload.aud).toEqual([FORGEJO_CLIENT_ID]);

    // A steward-audience verifier must reject it — the relying party holds this
    // token, so an audience leak would make it a cross-system credential.
    await expect(
      verifyOidcTokenAgainstJwks(body.access_token, {
        jwks,
        issuer: ISSUER,
        audience: STEWARD_AUDIENCE,
        tokenClass: "access_token",
      }),
    ).rejects.toThrow();
  });

  test("a client that declares a resource audience gets it, additively", async () => {
    await seedUser({ stewardUserId: "u-resource", role: "member" });
    const cookie = await sessionCookie("u-resource");
    const verifier = "resource-verifier-0123456789-abcdefghijklmnop";
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
    const challenge = Buffer.from(new Uint8Array(digest)).toString("base64url");

    const res = await call(
      `/api/oidc/authorize?${new URLSearchParams({
        client_id: LOWTRUST_CLIENT_ID,
        redirect_uri: "https://lowtrust.example/callback",
        response_type: "code",
        scope: "openid email profile groups",
        state: "s",
        code_challenge: challenge,
        code_challenge_method: "S256",
      })}`,
      { cookie },
    );
    const code = new URL(
      res.headers.get("location") as string,
    ).searchParams.get("code") as string;

    const { body, headers } = form({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://lowtrust.example/callback",
      code_verifier: verifier,
    });
    const tokenRes = await call("/api/oidc/token", {
      method: "POST",
      body,
      headers: {
        ...headers,
        authorization: basicAuth(LOWTRUST_CLIENT_ID, LOWTRUST_SECRET),
      },
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as TokenResponse;

    const jwks = (await (
      await call("/.well-known/oidc/jwks.json")
    ).json()) as PublishedJwks;
    const payload = await verifyOidcTokenAgainstJwks(tokens.access_token, {
      jwks,
      issuer: ISSUER,
      audience: STEWARD_AUDIENCE,
      tokenClass: "access_token",
    });
    expect(payload.aud).toEqual([LOWTRUST_CLIENT_ID, STEWARD_AUDIENCE]);

    // Per-client claims policy: this client is denied groups and tenant, and
    // its roles allowlist keeps it to the one role it is entitled to see.
    const idClaims = await verifyLikeConsumer(
      tokens.id_token,
      LOWTRUST_CLIENT_ID,
    );
    expect(idClaims).not.toHaveProperty("groups");
    expect(idClaims).not.toHaveProperty("tenant_id");
    expect(idClaims.roles).toEqual(["org_member"]);
  });
});

describe("token classes are not interchangeable", () => {
  test("an ID token is refused where an access token is expected, and the reverse", async () => {
    // Both tokens carry aud=client_id, so `{issuer, audience}` alone accepts
    // either one. The class is what separates them: the `typ` header and the
    // access-token-only `client_id`/`scope` members.
    await seedUser({ stewardUserId: "u-class" });
    const cookie = await sessionCookie("u-class");
    const { code } = await getAuthorizationCode(cookie);
    const body = (await (await redeem(code)).json()) as TokenResponse;
    const jwks = await publishedJwks();

    await expect(
      verifyOidcTokenAgainstJwks(body.id_token, {
        jwks,
        issuer: ISSUER,
        audience: FORGEJO_CLIENT_ID,
        tokenClass: "access_token",
      }),
    ).rejects.toThrow();

    await expect(
      verifyOidcTokenAgainstJwks(body.access_token, {
        jwks,
        issuer: ISSUER,
        audience: FORGEJO_CLIENT_ID,
        tokenClass: "id_token",
      }),
    ).rejects.toThrow();

    // Each still verifies as what it is.
    expect(
      (
        await verifyOidcTokenAgainstJwks(body.id_token, {
          jwks,
          issuer: ISSUER,
          audience: FORGEJO_CLIENT_ID,
          tokenClass: "id_token",
        })
      ).azp,
    ).toBe(FORGEJO_CLIENT_ID);
    expect(
      (
        await verifyOidcTokenAgainstJwks(body.access_token, {
          jwks,
          issuer: ISSUER,
          audience: FORGEJO_CLIENT_ID,
          tokenClass: "access_token",
        })
      ).client_id,
    ).toBe(FORGEJO_CLIENT_ID);
  });

  test("the two classes are separated in the header a bare JWT reader sees", async () => {
    await seedUser({ stewardUserId: "u-class-typ" });
    const cookie = await sessionCookie("u-class-typ");
    const { code } = await getAuthorizationCode(cookie);
    const body = (await (await redeem(code)).json()) as TokenResponse;

    const header = (token: string) =>
      JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
    expect(header(body.id_token).typ).toBe("JWT");
    expect(header(body.access_token).typ).toBe("at+jwt");
  });

  test("a registry whose client_id is another client's resource audience refuses to load", async () => {
    // The collision that would make the class check moot for a consumer that
    // pins only {issuer, audience}: the ID token of client X is a token for
    // audience X, and X is somebody's resource server.
    const colliding = { ...ENV };
    colliding.OIDC_CLIENTS = JSON.stringify([
      {
        client_id: MERGE_STEWARD_AUDIENCE,
        client_secret_sha256: sha256Hex(CONSOLE_SECRET),
        redirect_uris: [CONSOLE_REDIRECT],
        allowed_scopes: ["openid", "email", "profile", "groups"],
        resource_audiences: [],
        claims_policy: {
          groups: true,
          roles: true,
          tenant_id: true,
          eliza_agents: false,
        },
      },
      {
        client_id: CONSOLE_CLIENT_ID,
        client_secret_sha256: sha256Hex(CONSOLE_SECRET),
        redirect_uris: [CONSOLE_REDIRECT],
        allowed_scopes: ["openid", "email", "profile", "groups"],
        resource_audiences: [MERGE_STEWARD_AUDIENCE],
        claims_policy: {
          groups: true,
          roles: true,
          tenant_id: true,
          eliza_agents: false,
        },
      },
    ]);

    const res = await harness.request(
      `${ISSUER}${authorizeUrl()}`,
      { headers: { "x-forwarded-for": "10.8.8.8" } },
      colliding,
    );
    // The registry refuses to load, so sign-in is unavailable rather than
    // silently issuing cross-audience tokens.
    expect(res.status).toBe(503);
  });
});

describe("userinfo", () => {
  test("an ID token cannot be replayed as an access token", async () => {
    await seedUser({ stewardUserId: "u-typ" });
    const cookie = await sessionCookie("u-typ");
    const { code } = await getAuthorizationCode(cookie);
    const body = (await (await redeem(code)).json()) as TokenResponse;

    const res = await call("/api/oidc/userinfo", {
      headers: { authorization: `Bearer ${body.id_token}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
  });

  test("a missing or garbage bearer is refused", async () => {
    expect((await call("/api/oidc/userinfo")).status).toBe(401);
    const res = await call("/api/oidc/userinfo", {
      headers: { authorization: "Bearer not-a-jwt" },
    });
    expect(res.status).toBe(401);
  });

  test("claims come from LIVE rows — a role change is visible before the token expires", async () => {
    const { userId } = await seedUser({
      stewardUserId: "u-live",
      role: "owner",
    });
    const cookie = await sessionCookie("u-live");
    const { code } = await getAuthorizationCode(cookie);
    const body = (await (await redeem(code)).json()) as TokenResponse;

    const before = (await (
      await call("/api/oidc/userinfo", {
        headers: { authorization: `Bearer ${body.access_token}` },
      })
    ).json()) as Record<string, unknown>;
    expect(before.roles).toEqual(["org_owner"]);

    const { eq } = await import("drizzle-orm");
    await dbWrite
      .update(schemas.users)
      .set({ role: "member" })
      .where(eq(schemas.users.id, userId));

    const after = (await (
      await call("/api/oidc/userinfo", {
        headers: { authorization: `Bearer ${body.access_token}` },
      })
    ).json()) as Record<string, unknown>;
    expect(after.roles).toEqual(["org_member"]);
  });

  test("a deactivated account cannot use a still-live access token", async () => {
    const { userId } = await seedUser({ stewardUserId: "u-revoked" });
    const cookie = await sessionCookie("u-revoked");
    const { code } = await getAuthorizationCode(cookie);
    const body = (await (await redeem(code)).json()) as TokenResponse;

    const { eq } = await import("drizzle-orm");
    await dbWrite
      .update(schemas.users)
      .set({ is_active: false })
      .where(eq(schemas.users.id, userId));

    const res = await call("/api/oidc/userinfo", {
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("userinfo — signature enforcement and key-ring separation", () => {
  /**
   * The class-separation and key-ring-separation claims both reduce to one
   * thing: a bearer that verifies is a bearer this provider's private ring
   * signed. A token wearing the ring's real `kid` but signed by ANY other key
   * — the internal-service `JWT_SIGNING_*` pair, a relying party's own key, an
   * attacker's fresh key — must fail signature verification, not be trusted on
   * the strength of the `kid` header alone. Without that, publishing the `kid`
   * would be publishing a forgery template.
   */
  /**
   * Mint an access token from a DIFFERENT key ring, then hand it to a
   * `/userinfo` that runs under the real ring. `kidInForeignRing` controls
   * whether the forgery even names a key the real ring publishes.
   */
  async function foreignSignedAccessToken(
    userId: string,
    kidInForeignRing: string,
  ): Promise<string> {
    const { runWithCloudBindingsAsync } = await import(
      "@/lib/runtime/cloud-bindings"
    );
    const { mintOidcAccessToken } = await import("@/lib/oidc/tokens");
    const { _resetOidcKeyCacheForTests } = await import("@/lib/oidc/keys");
    const foreignEnv = {
      ...ENV,
      OIDC_SIGNING_JWKS: JSON.stringify([rsaPrivateJwk(kidInForeignRing)]),
    };
    const token = await runWithCloudBindingsAsync(foreignEnv, () =>
      mintOidcAccessToken({
        issuer: ISSUER,
        clientId: FORGEJO_CLIENT_ID,
        subject: userId,
        audiences: [],
        scope: "openid email profile groups",
        ttlSeconds: 300,
        claims: { sub: userId },
        now: new Date(),
      }),
    );
    // Drop the foreign ring from the module cache so the endpoint call below
    // re-reads the real `OIDC_SIGNING_JWKS`.
    _resetOidcKeyCacheForTests();
    return token;
  }

  test("a token bearing the ring's kid but signed by a FOREIGN key is refused", async () => {
    // The class-separation and key-ring-separation claims both reduce to one
    // thing: a bearer that verifies is a bearer this provider's private ring
    // signed. A token wearing the ring's REAL kid but signed by any other key
    // — the internal-service JWT_SIGNING_* pair, a relying party's own key, an
    // attacker's fresh key — must fail signature verification, not be trusted
    // on the strength of the kid header alone.
    const { userId } = await seedUser({ stewardUserId: "u-forged-sig" });
    const forged = await foreignSignedAccessToken(userId, "oidc-test-key");

    const res = await call("/api/oidc/userinfo", {
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
  });

  test("a token whose kid is not in the ring is refused without an oracle", async () => {
    const { userId } = await seedUser({ stewardUserId: "u-unknown-kid" });
    const forged = await foreignSignedAccessToken(userId, "no-such-kid");

    const res = await call("/api/oidc/userinfo", {
      headers: { authorization: `Bearer ${forged}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("invalid_token");
  });
});

describe("username allocation", () => {
  test("the allocated username is frozen — a later nickname change does not move it", async () => {
    const { userId } = await seedUser({
      stewardUserId: "u-frozen",
      nickname: "original",
    });
    const cookie = await sessionCookie("u-frozen");
    const first = (await (
      await redeem((await getAuthorizationCode(cookie)).code)
    ).json()) as TokenResponse;
    expect(
      (await verifyLikeConsumer(first.id_token, FORGEJO_CLIENT_ID))
        .preferred_username,
    ).toBe("original");

    const { eq } = await import("drizzle-orm");
    await dbWrite
      .update(schemas.users)
      .set({ nickname: "renamed" })
      .where(eq(schemas.users.id, userId));

    const second = (await (
      await redeem((await getAuthorizationCode(cookie)).code)
    ).json()) as TokenResponse;
    expect(
      (await verifyLikeConsumer(second.id_token, FORGEJO_CLIENT_ID))
        .preferred_username,
    ).toBe("original");
  });

  test("a collision on the preferred name allocates a distinct suffixed one", async () => {
    await seedUser({ stewardUserId: "u-collide-a", nickname: "shared-name" });
    await seedUser({ stewardUserId: "u-collide-b", nickname: "shared-name" });

    const a = (await (
      await redeem(
        (
          await getAuthorizationCode(await sessionCookie("u-collide-a"))
        ).code,
      )
    ).json()) as TokenResponse;
    const b = (await (
      await redeem(
        (
          await getAuthorizationCode(await sessionCookie("u-collide-b"))
        ).code,
      )
    ).json()) as TokenResponse;

    const nameA = (await verifyLikeConsumer(a.id_token, FORGEJO_CLIENT_ID))
      .preferred_username;
    const nameB = (await verifyLikeConsumer(b.id_token, FORGEJO_CLIENT_ID))
      .preferred_username;
    expect(nameA).toBe("shared-name");
    expect(nameB).toBe("shared-name-2");
  });

  test("a reserved nickname cannot be squatted", async () => {
    await seedUser({
      stewardUserId: "u-reserved",
      nickname: "eliza-merge-steward",
    });
    const cookie = await sessionCookie("u-reserved");
    const body = (await (
      await redeem((await getAuthorizationCode(cookie)).code)
    ).json()) as TokenResponse;
    const claims = await verifyLikeConsumer(body.id_token, FORGEJO_CLIENT_ID);
    expect(claims.preferred_username).not.toBe("eliza-merge-steward");
    expect(claims.preferred_username).toBe("u-reserved");
  });

  test("a name Forgejo itself reserves is never frozen for a user", async () => {
    // Frozen here, created there: a name Forgejo refuses would leave the
    // account uncreatable and the user permanently unable to sign in.
    await seedUser({ stewardUserId: "u-gitea-reserved", nickname: "ssh_info" });
    const body = (await (
      await redeem(
        (
          await getAuthorizationCode(await sessionCookie("u-gitea-reserved"))
        ).code,
      )
    ).json()) as TokenResponse;
    const claims = await verifyLikeConsumer(body.id_token, FORGEJO_CLIENT_ID);
    expect(claims.preferred_username).not.toBe("ssh_info");
    expect(claims.preferred_username).toBe("u-gitea-reserved");
  });

  test("a dotted nickname freezes as a dashed name Forgejo will accept", async () => {
    // `ada.rss` matches Forgejo's `*.rss` reserved pattern; the dot never
    // survives normalization, so no candidate can reach that class at all.
    await seedUser({ stewardUserId: "u-dotted", nickname: "Ada.RSS" });
    const body = (await (
      await redeem(
        (
          await getAuthorizationCode(await sessionCookie("u-dotted"))
        ).code,
      )
    ).json()) as TokenResponse;
    const claims = await verifyLikeConsumer(body.id_token, FORGEJO_CLIENT_ID);
    expect(claims.preferred_username).toBe("ada-rss");
    expect(claims.preferred_username).not.toContain(".");
  });
});

describe("kill switch", () => {
  test("with OIDC_ENABLED off every endpoint is 404 and no document leaks", async () => {
    const disabled = { ...ENV, OIDC_ENABLED: "false" };
    for (const path of [
      "/.well-known/openid-configuration",
      "/.well-known/oidc/jwks.json",
      "/api/oidc/authorize",
      "/api/oidc/userinfo",
    ]) {
      const res = await harness.request(
        `${ISSUER}${path}`,
        { headers: { "x-forwarded-for": "10.9.9.9" } },
        disabled,
      );
      expect(res.status).toBe(404);
    }
  });
});

describe("issuer configuration", () => {
  test("an issuer carrying a path serves nothing rather than URLs that drop it", async () => {
    // Every endpoint path is concatenated onto the issuer, so
    // `https://api.elizacloud.test/oidc` would advertise
    // `https://api.elizacloud.test/api/oidc/token` — the path silently gone.
    // Refusing the whole configuration is the only answer that cannot mislead
    // a relying party that caches the document.
    const pathIssuer = { ...ENV, OIDC_ISSUER_URL: `${ISSUER}/oidc` };
    for (const [path, expected] of [
      ["/.well-known/openid-configuration", 503],
      ["/.well-known/oidc/jwks.json", 404],
      ["/api/oidc/userinfo", 404],
    ] as const) {
      const res = await harness.request(
        `${ISSUER}${path}`,
        { headers: { "x-forwarded-for": "10.9.8.7" } },
        pathIssuer,
      );
      expect(res.status).toBe(expected);
    }

    const authorizeRes = await harness.request(
      `${ISSUER}${authorizeUrl()}`,
      { headers: { "x-forwarded-for": "10.9.8.6" } },
      pathIssuer,
    );
    expect(authorizeRes.status).toBe(503);
  });

  test("a loopback issuer serves the whole flow over http", async () => {
    // The local stack has no TLS, and the console SPA sends the signed-out
    // login bounce to this same origin: a provider that refused http here could
    // not be run locally at all.
    const loopbackIssuer = "http://127.0.0.1:8787";
    const loopbackEnv = { ...ENV, OIDC_ISSUER_URL: loopbackIssuer };

    const discoveryRes = await harness.request(
      `${loopbackIssuer}/.well-known/openid-configuration`,
      { headers: { "x-forwarded-for": "10.9.7.5" } },
      loopbackEnv,
    );
    expect(discoveryRes.status).toBe(200);
    const document = (await discoveryRes.json()) as {
      issuer: string;
      token_endpoint: string;
      jwks_uri: string;
    };
    expect(document.issuer).toBe(loopbackIssuer);
    expect(document.token_endpoint).toBe(`${loopbackIssuer}/api/oidc/token`);

    const jwksRes = await harness.request(
      new URL(document.jwks_uri).toString(),
      { headers: { "x-forwarded-for": "10.9.7.4" } },
      loopbackEnv,
    );
    expect(jwksRes.status).toBe(200);

    // …and only on the loopback name it was configured with: the same document
    // must not be served on the https host, or two issuers would answer at once.
    const otherHostRes = await harness.request(
      `${ISSUER}/.well-known/openid-configuration`,
      { headers: { "x-forwarded-for": "10.9.7.3" } },
      loopbackEnv,
    );
    expect(otherHostRes.status).toBe(404);
  });
});

/**
 * OpenID Connect Core 3.1.2.1 requires BOTH methods at the authorization
 * endpoint. A relying party that picks POST — to keep parameters out of proxy
 * logs, or because its request outgrew a URL limit — would otherwise get a 404
 * from a provider whose discovery document told it the endpoint exists.
 */
describe("authorize — POST", () => {
  function authorizeForm(overrides: Record<string, string | undefined> = {}): {
    body: BodyInit;
    headers: Record<string, string>;
  } {
    const fields: Record<string, string | undefined> = {
      client_id: FORGEJO_CLIENT_ID,
      redirect_uri: FORGEJO_REDIRECT,
      response_type: "code",
      scope: "openid email profile groups",
      state: "post-state-value",
      ...overrides,
    };
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) params.set(key, value);
    }
    return {
      body: params.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
    };
  }

  test("a form-serialized POST issues a code the token endpoint accepts", async () => {
    await seedUser({ stewardUserId: "u-post-authorize" });
    const cookie = await sessionCookie("u-post-authorize");
    const res = await call("/api/oidc/authorize", {
      method: "POST",
      cookie,
      ...authorizeForm(),
    });
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location") as string);
    expect(location.origin + location.pathname).toBe(FORGEJO_REDIRECT);
    expect(location.searchParams.get("state")).toBe("post-state-value");
    const code = location.searchParams.get("code") as string;
    expect(code).toMatch(/^eoc_[0-9a-f]{64}$/);
    // Proof it is a real grant, not just a well-shaped redirect.
    expect((await redeem(code)).status).toBe(200);
  });

  test("POST validation is the same validation — an unregistered redirect_uri never redirects", async () => {
    await seedUser({ stewardUserId: "u-post-openredirect" });
    const cookie = await sessionCookie("u-post-openredirect");
    const res = await call("/api/oidc/authorize", {
      method: "POST",
      cookie,
      ...authorizeForm({ redirect_uri: "https://evil.example/steal" }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  test("POST protocol errors still redirect to the validated URI", async () => {
    const res = await call("/api/oidc/authorize", {
      method: "POST",
      ...authorizeForm({ response_type: "token" }),
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") as string);
    expect(location.searchParams.get("error")).toBe(
      "unsupported_response_type",
    );
  });

  test("a POST that is not form-serialized is refused in place", async () => {
    // Form Serialization is the only encoding 3.1.2.1 defines for the POST
    // leg; a JSON body names no client, so there is no proven URI to answer to.
    const res = await call("/api/oidc/authorize", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: FORGEJO_CLIENT_ID }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  test("query parameters are ignored on the POST leg", async () => {
    // Reading both would let a link's query string override the body a relying
    // party posted.
    const res = await call(
      `/api/oidc/authorize?${new URLSearchParams({
        client_id: FORGEJO_CLIENT_ID,
        redirect_uri: FORGEJO_REDIRECT,
        response_type: "code",
        scope: "openid",
        state: "from-query",
      })}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      },
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });

  test("an oversized POST body is refused before anything is parsed or stored", async () => {
    // The GET leg is bounded by the edge's URL limit; the POST leg has none of
    // its own, and a signed-out request is PERSISTED — so an unauthenticated
    // caller could otherwise park rows of arbitrary size.
    const res = await call("/api/oidc/authorize", {
      method: "POST",
      ...authorizeForm({ nonce: "n".repeat(64 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("location")).toBeNull();
  });

  test("an oversized body is refused even when its length is not declared", async () => {
    const { headers } = authorizeForm();
    const params = new URLSearchParams({
      client_id: FORGEJO_CLIENT_ID,
      redirect_uri: FORGEJO_REDIRECT,
      response_type: "code",
      scope: "openid",
      state: "s".repeat(32 * 1024),
    });
    const res = await call("/api/oidc/authorize", {
      method: "POST",
      headers,
      // A ReadableStream body is sent chunked, so there is no content-length
      // to check and the decoded text has to be re-measured.
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(params.toString()));
          controller.close();
        },
      }),
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("location")).toBeNull();
  });

  test("a body under the cap still parks a signed-out request", async () => {
    // The bound must not cost the ordinary flow: this is the same signed-out
    // POST a relying party makes, with a realistically sized state.
    const res = await call("/api/oidc/authorize", {
      method: "POST",
      ...authorizeForm({ state: "s".repeat(512) }),
    });
    expect(res.status).toBe(302);
    const login = new URL(res.headers.get("location") as string);
    expect(login.origin).toBe(CONSOLE_ORIGIN);
    expect(login.pathname).toBe("/login");
    expect(
      (login.searchParams.get("returnTo") as string).startsWith(
        "/oidc/continue?rid=eoq_",
      ),
    ).toBe(true);
  });
});

/**
 * Every free-text parameter reaches the parked-request row verbatim, so each one
 * an unauthenticated caller controls is bounded once the destination is proven.
 */
describe("authorize — parameter bounds", () => {
  test("an over-long state or nonce is an invalid_request the relying party sees", async () => {
    for (const parameter of ["state", "nonce", "scope", "prompt", "max_age"]) {
      const res = await call(authorizeUrl({ [parameter]: "x".repeat(4096) }));
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get("location") as string);
      // Proven-registered destination, so this redirects rather than
      // terminating: the relying party gets an error it can act on.
      expect(location.origin + location.pathname).toBe(FORGEJO_REDIRECT);
      expect(location.searchParams.get("error")).toBe("invalid_request");
      expect(location.searchParams.get("code")).toBeNull();
    }
  });

  test("an over-long parameter never parks a row, even signed out", async () => {
    const res = await call(authorizeUrl({ state: "x".repeat(4096) }));
    const location = new URL(res.headers.get("location") as string);
    // The signed-out leg would otherwise bounce to /login and store the value.
    expect(location.origin).not.toBe(CONSOLE_ORIGIN);
    expect(location.searchParams.get("error")).toBe("invalid_request");
  });

  test("an oversized client_id or redirect_uri is simply unregistered", async () => {
    // Both are exact-matched against the registry, so neither needs a length
    // rule — and neither may redirect, because no destination is proven.
    const bigClient = await call(authorizeUrl({ client_id: "c".repeat(8192) }));
    expect(bigClient.status).toBe(400);
    expect(bigClient.headers.get("location")).toBeNull();

    const bigRedirect = await call(
      authorizeUrl({ redirect_uri: `https://hub.example/${"p".repeat(8192)}` }),
    );
    expect(bigRedirect.status).toBe(400);
    expect(bigRedirect.headers.get("location")).toBeNull();
  });

  test("a state at the documented ceiling is still accepted", async () => {
    await seedUser({ stewardUserId: "u-bound-ok" });
    const cookie = await sessionCookie("u-bound-ok");
    const state = "s".repeat(2048);
    const res = await call(authorizeUrl({ state }), { cookie });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") as string);
    expect(location.searchParams.get("state")).toBe(state);
    expect(location.searchParams.get("code")).toMatch(/^eoc_[0-9a-f]{64}$/);
  });
});

/**
 * `prompt` and `max_age` are how a relying party asks for a FRESH login. This
 * provider cannot run one, so the only two acceptable outcomes are honoring the
 * request or refusing it — never a 302 carrying a code minted from the session
 * the relying party asked to bypass.
 */
describe("authorize — forced re-authentication", () => {
  async function authorizeWith(
    stewardUserId: string,
    overrides: Record<string, string>,
  ): Promise<URL> {
    await seedUser({ stewardUserId });
    const cookie = await sessionCookie(stewardUserId);
    const res = await call(authorizeUrl(overrides), { cookie });
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location") as string);
  }

  test("prompt=login is refused with login_required and issues NO code", async () => {
    const location = await authorizeWith("u-prompt-login", {
      prompt: "login",
    });
    expect(location.origin + location.pathname).toBe(FORGEJO_REDIRECT);
    expect(location.searchParams.get("error")).toBe("login_required");
    expect(location.searchParams.get("code")).toBeNull();
    expect(location.searchParams.get("state")).toBe("rp-state-value");
  });

  test("prompt=consent and prompt=select_account name what is missing", async () => {
    const consent = await authorizeWith("u-prompt-consent", {
      prompt: "consent",
    });
    expect(consent.searchParams.get("error")).toBe("consent_required");

    const chooser = await authorizeWith("u-prompt-chooser", {
      prompt: "select_account",
    });
    expect(chooser.searchParams.get("error")).toBe(
      "account_selection_required",
    );
  });

  test("max_age is refused with login_required rather than silently ignored", async () => {
    // Nothing this provider reads says when the user authenticated, so an
    // answer here would be a freshness claim it cannot support.
    const location = await authorizeWith("u-maxage", { max_age: "300" });
    expect(location.searchParams.get("error")).toBe("login_required");
    expect(location.searchParams.get("code")).toBeNull();
  });

  test("a malformed prompt or max_age is invalid_request", async () => {
    const badPrompt = await authorizeWith("u-prompt-typo", {
      prompt: "Login",
    });
    expect(badPrompt.searchParams.get("error")).toBe("invalid_request");

    const combined = await authorizeWith("u-prompt-combined", {
      prompt: "none login",
    });
    expect(combined.searchParams.get("error")).toBe("invalid_request");

    const badMaxAge = await authorizeWith("u-maxage-bad", {
      max_age: "-30",
    });
    expect(badMaxAge.searchParams.get("error")).toBe("invalid_request");
  });

  test("prompt=none still completes against a live session", async () => {
    // The one value this provider CAN satisfy must keep working: nothing about
    // an existing session requires interaction.
    const location = await authorizeWith("u-prompt-none-ok", {
      prompt: "none",
    });
    expect(location.searchParams.get("code")).toMatch(/^eoc_[0-9a-f]{64}$/);
  });

  test("the discovery document says which prompt values are honored", async () => {
    const doc = (await (
      await call("/.well-known/openid-configuration")
    ).json()) as { prompt_values_supported: string[] };
    expect(doc.prompt_values_supported).toEqual(["none"]);
  });
});

describe("authorize — response caching", () => {
  test("the 302 carrying the code is not storable", async () => {
    // The authorization code is IN the Location URL. A shared cache or a
    // back-forward replay that retains it hands out a live credential.
    await seedUser({ stewardUserId: "u-nostore" });
    const cookie = await sessionCookie("u-nostore");
    const res = await call(authorizeUrl(), { cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("code=eoc_");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  test("the error redirect is not storable either", async () => {
    const res = await call(authorizeUrl({ response_type: "token" }));
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

/**
 * RFC 6749 §5.2 gives `invalid_request` and `invalid_grant` opposite meanings:
 * one says the relying party's own call is malformed, the other says the code
 * it holds is dead and it should start over at /authorize. Answering a missing
 * parameter with `invalid_grant` sends a client round that loop forever.
 */
describe("token — RFC 6749 5.2 error codes", () => {
  async function codeFor(stewardUserId: string): Promise<string> {
    await seedUser({ stewardUserId });
    return (await getAuthorizationCode(await sessionCookie(stewardUserId)))
      .code;
  }

  async function post(
    fields: Record<string, string>,
    clientId = FORGEJO_CLIENT_ID,
    secret = FORGEJO_SECRET,
  ): Promise<Response> {
    const { body, headers } = form(fields);
    return call("/api/oidc/token", {
      method: "POST",
      body,
      headers: { ...headers, authorization: basicAuth(clientId, secret) },
    });
  }

  test("a missing grant_type is invalid_request, not unsupported_grant_type", async () => {
    const res = await post({
      code: "eoc_x",
      redirect_uri: FORGEJO_REDIRECT,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_request",
    );
  });

  test("a missing code is invalid_request and leaves the grant alive", async () => {
    const code = await codeFor("u-missing-code");
    const res = await post({
      grant_type: "authorization_code",
      redirect_uri: FORGEJO_REDIRECT,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_request",
    );
    // A malformed call must not destroy a pending authorization.
    expect((await redeem(code)).status).toBe(200);
  });

  test("a missing redirect_uri is invalid_request while a WRONG one stays invalid_grant", async () => {
    const code = await codeFor("u-missing-redirect");
    const missing = await post({ grant_type: "authorization_code", code });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe(
      "invalid_request",
    );

    // The code survived the malformed call…
    const wrong = await redeem(code, {
      redirect_uri: "https://lowtrust.example/callback",
    });
    // …and a mismatch is still the opaque binding failure, because that answer
    // is about a code the caller may have stolen.
    expect(((await wrong.json()) as { error: string }).error).toBe(
      "invalid_grant",
    );
  });

  test("a present but unsupported grant_type is still unsupported_grant_type", async () => {
    const res = await post({
      grant_type: "refresh_token",
      code: "eoc_x",
      redirect_uri: FORGEJO_REDIRECT,
    });
    expect(((await res.json()) as { error: string }).error).toBe(
      "unsupported_grant_type",
    );
  });

  test("an unavailable provider answers 503 with no OAuth error code at all", async () => {
    // RFC 6749 §5.2 closes the token-endpoint code set and none of its members
    // means "retry later". A relying party matching that set against
    // `temporarily_unavailable` treats a transient outage as permanent.
    const { body, headers } = form({
      grant_type: "authorization_code",
      code: "eoc_x",
      redirect_uri: FORGEJO_REDIRECT,
    });
    const res = await harness.request(
      `${ISSUER}/api/oidc/token`,
      {
        method: "POST",
        body,
        headers: {
          ...headers,
          "x-forwarded-for": "10.8.8.1",
          authorization: basicAuth(FORGEJO_CLIENT_ID, FORGEJO_SECRET),
        },
      },
      { ...ENV, OIDC_SIGNING_JWKS: "" },
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    const payload = (await res.json()) as Record<string, unknown>;
    expect(payload).not.toHaveProperty("error");
    expect(payload.error_description).toBeString();
  });
});

/**
 * RFC 6749 §2.3.1 form-encodes both halves of `client_secret_basic`, but only
 * some clients do it. A secret containing `%` therefore arrives in one of two
 * readings, and decoding unconditionally corrupts the other one into a
 * permanent `invalid_client`.
 */
describe("token — client_secret_basic decoding", () => {
  async function percentCode(stewardUserId: string): Promise<string> {
    await seedUser({ stewardUserId });
    const cookie = await sessionCookie(stewardUserId);
    const res = await call(
      `/api/oidc/authorize?${new URLSearchParams({
        client_id: PERCENT_CLIENT_ID,
        redirect_uri: PERCENT_REDIRECT,
        response_type: "code",
        scope: "openid email",
        state: "percent-state",
      })}`,
      { cookie },
    );
    expect(res.status).toBe(302);
    return new URL(res.headers.get("location") as string).searchParams.get(
      "code",
    ) as string;
  }

  async function redeemWithHeader(
    code: string,
    authorization: string,
  ): Promise<Response> {
    const { body, headers } = form({
      grant_type: "authorization_code",
      code,
      redirect_uri: PERCENT_REDIRECT,
    });
    return call("/api/oidc/token", {
      method: "POST",
      body,
      headers: { ...headers, authorization },
    });
  }

  test("a secret containing % authenticates when sent verbatim", async () => {
    // curl and most shell clients base64 the raw text. Decoding it would turn
    // `…100%2Fvalue…` into `…100/value…` and never match the stored hash.
    const code = await percentCode("u-percent-raw");
    const header = `Basic ${btoa(`${PERCENT_CLIENT_ID}:${PERCENT_SECRET}`)}`;
    expect((await redeemWithHeader(code, header)).status).toBe(200);
  });

  test("the same secret authenticates when form-encoded, as Go's oauth2 sends it", async () => {
    const code = await percentCode("u-percent-encoded");
    const header = `Basic ${btoa(
      `${encodeURIComponent(PERCENT_CLIENT_ID)}:${encodeURIComponent(PERCENT_SECRET)}`,
    )}`;
    expect((await redeemWithHeader(code, header)).status).toBe(200);
  });

  test("the scheme is matched case-insensitively, per RFC 7235", async () => {
    const code = await percentCode("u-percent-lowercase");
    const header = `basic ${btoa(`${PERCENT_CLIENT_ID}:${PERCENT_SECRET}`)}`;
    expect((await redeemWithHeader(code, header)).status).toBe(200);
  });

  test("a wrong secret is still refused under both readings", async () => {
    const code = await percentCode("u-percent-wrong");
    const header = `Basic ${btoa(`${PERCENT_CLIENT_ID}:not-the-secret`)}`;
    const res = await redeemWithHeader(code, header);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe(
      "invalid_client",
    );
  });
});

/**
 * `/userinfo` is a bearer-protected resource, so RFC 6750 governs it: the
 * scheme is case-insensitive and every refusal carries a challenge naming the
 * error. Those two are what let a client tell "get a new token" apart from
 * "that token will never be enough".
 */
describe("userinfo — RFC 6750 conformance", () => {
  async function accessTokenFor(stewardUserId: string): Promise<string> {
    await seedUser({ stewardUserId });
    const cookie = await sessionCookie(stewardUserId);
    const { code } = await getAuthorizationCode(cookie);
    const body = (await (await redeem(code)).json()) as TokenResponse;
    return body.access_token;
  }

  test("a lowercase bearer scheme is accepted", async () => {
    const token = await accessTokenFor("u-lowercase-bearer");
    for (const scheme of ["Bearer", "bearer", "BEARER", "BeArEr"]) {
      const res = await call("/api/oidc/userinfo", {
        headers: { authorization: `${scheme} ${token}` },
      });
      expect(res.status).toBe(200);
    }
  });

  test("extra whitespace between scheme and token is tolerated", async () => {
    const token = await accessTokenFor("u-bearer-spaces");
    const res = await call("/api/oidc/userinfo", {
      headers: { authorization: `Bearer   ${token}` },
    });
    expect(res.status).toBe(200);
  });

  test("another scheme is refused with a challenge, not accepted as a token", async () => {
    const token = await accessTokenFor("u-basic-scheme");
    const res = await call("/api/oidc/userinfo", {
      headers: { authorization: `Basic ${token}` },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
  });

  test("a token without the openid scope gets 403 WITH a challenge naming the scope", async () => {
    // RFC 6750 §3: a 403 with no WWW-Authenticate leaves the client unable to
    // distinguish an authorization failure from a missing scope, so it retries
    // the same token forever.
    const { runWithCloudBindingsAsync } = await import(
      "@/lib/runtime/cloud-bindings"
    );
    const { mintOidcAccessToken } = await import("@/lib/oidc/tokens");
    const { userId } = await seedUser({ stewardUserId: "u-no-openid-scope" });

    const token = await runWithCloudBindingsAsync(ENV, () =>
      mintOidcAccessToken({
        issuer: ISSUER,
        clientId: FORGEJO_CLIENT_ID,
        subject: userId,
        audiences: [],
        scope: "email",
        ttlSeconds: 300,
        claims: { sub: userId },
        now: new Date(),
      }),
    );

    const res = await call("/api/oidc/userinfo", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "insufficient_scope",
    );
    const challenge = res.headers.get("www-authenticate") as string;
    expect(challenge.startsWith("Bearer ")).toBe(true);
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="openid"');
  });

  test("an unavailable provider answers 503 without claiming the token is bad", async () => {
    const token = await accessTokenFor("u-userinfo-unavailable");
    const res = await harness.request(
      `${ISSUER}/api/oidc/userinfo`,
      {
        headers: {
          "x-forwarded-for": "10.8.8.2",
          authorization: `Bearer ${token}`,
        },
      },
      { ...ENV, OIDC_SIGNING_JWKS: "" },
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(await res.json()).not.toHaveProperty("error");
  });
});
