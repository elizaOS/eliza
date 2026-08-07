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
  });
  return payload as Record<string, unknown>;
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
      // Forgejo maps teams from the native org groups AND gates admin on its
      // own `eliza-admins` name, so both vocabularies have to survive.
      claims_mapping: {
        mode: "extend",
        roles: {},
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
    const res = await call(authorizeUrl());
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
    const bounce = await call(authorizeUrl({ state: "resume-state" }));
    const returnTo = new URL(
      bounce.headers.get("location") as string,
    ).searchParams.get("returnTo") as string;
    const rid = new URLSearchParams(returnTo.split("?")[1]).get(
      "rid",
    ) as string;

    await seedUser({ stewardUserId: "u-resume" });
    const cookie = await sessionCookie("u-resume");
    const resumed = await call(`/api/oidc/authorize/resume?rid=${rid}`, {
      cookie,
    });
    expect(resumed.status).toBe(302);
    const location = new URL(resumed.headers.get("location") as string);
    expect(location.origin + location.pathname).toBe(FORGEJO_REDIRECT);
    expect(location.searchParams.get("code")).toMatch(/^eoc_[0-9a-f]{64}$/);
    expect(location.searchParams.get("state")).toBe("resume-state");

    // Parked requests are single use.
    const replay = await call(`/api/oidc/authorize/resume?rid=${rid}`, {
      cookie,
    });
    expect(replay.status).toBe(400);
  });

  test("resuming while still signed out shows a terminal page rather than looping", async () => {
    const bounce = await call(authorizeUrl());
    const returnTo = new URL(
      bounce.headers.get("location") as string,
    ).searchParams.get("returnTo") as string;
    const rid = new URLSearchParams(returnTo.split("?")[1]).get(
      "rid",
    ) as string;
    const res = await call(`/api/oidc/authorize/resume?rid=${rid}`);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
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
    expect(idClaims.auth_time).toBeNumber();
    expect(idClaims.azp).toBe(FORGEJO_CLIENT_ID);

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

    expect(claims.groups).toContain("eliza-admins");
    // `extend` keeps the native vocabulary the team-sync job reads.
    expect(claims.groups).toContain("eliza-cloud:admins");
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
    });
    expect(payload.aud).toEqual([FORGEJO_CLIENT_ID]);

    // A steward-audience verifier must reject it — the relying party holds this
    // token, so an audience leak would make it a cross-system credential.
    await expect(
      verifyOidcTokenAgainstJwks(body.access_token, {
        jwks,
        issuer: ISSUER,
        audience: STEWARD_AUDIENCE,
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
