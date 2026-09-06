/** Exercises app consent, one-time codes, and scoped HTTP credentials against real PGlite; only outbound Google is replaced. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type {
  AppDelegationResult,
  AppDelegationScope,
} from "@elizaos/cloud-sdk/app-delegation";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.CACHE_BACKEND = "memory";
process.env.NODE_ENV = "test";

const ORG = "71000000-0000-4000-8000-000000000001";
const OTHER_ORG = "71000000-0000-4000-8000-000000000002";
const USER = "71000000-0000-4000-8000-000000000011";
const APP_A = "71000000-0000-4000-8000-000000000021";
const APP_B = "71000000-0000-4000-8000-000000000022";
const CONNECTION = "71000000-0000-4000-8000-000000000031";
const REDIRECT = "https://app.example/callback";
const SCOPES: AppDelegationScope[] = [
  "identity",
  "google.basic_identity",
  "google.gmail.triage",
  "google.gmail.send",
  "billing:read",
  "billing:write",
  "inference",
];
let database: ReturnType<typeof import("@/db/client").getPgliteClientForTests>;
let close: typeof import("@/db/client").closeDatabaseConnectionsForTests;
let repository: typeof import("@/db/repositories/app-delegations").appDelegationsRepository;
let service: typeof import("@/lib/services/app-delegation-adapter").appDelegationService;
let issueCode: typeof import("@/lib/services/app-auth-codes").issueAppAuthCode;
let routes: Hono<AppEnv>;
let clientA: { clientId: string; clientSecret: string; revision: number };
let clientB: typeof clientA;
let googleCalls: string[] = [];

function headers(client = clientA, token?: string) {
  return {
    Authorization: `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`,
    "Content-Type": "application/json",
    ...(token ? { "X-App-Delegation": token } : {}),
  };
}

async function consent(
  scopes: AppDelegationScope[] = ["identity"],
  appId = APP_A,
  client = clientA,
) {
  const response = await routes.request(
    "https://cloud.example/connect",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer fixture-session",
      },
      body: JSON.stringify({
        appId,
        flow: "app_delegation",
        clientId: client.clientId,
        redirectUri: REDIRECT,
        scopes,
      }),
    },
    {},
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { code: string };
  return body.code;
}

async function exchange(code: string, client = clientA) {
  return routes.request(
    "https://cloud.example/delegations/token",
    {
      method: "POST",
      headers: headers(client),
      body: JSON.stringify({ code, redirectUri: REDIRECT }),
    },
    {},
  );
}

async function grant(
  scopes: AppDelegationScope[] = ["identity"],
  appId = APP_A,
  client = clientA,
) {
  const response = await exchange(await consent(scopes, appId, client), client);
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: AppDelegationResult }).data;
}

async function googleRequest(token: string, url: string, body?: string) {
  return routes.request(
    "https://cloud.example/delegations/google/request",
    {
      method: "POST",
      headers: headers(clientA, token),
      body: JSON.stringify({
        connectionId: CONNECTION,
        method: body === undefined ? "GET" : "POST",
        url,
        ...(body !== undefined ? { body } : {}),
      }),
    },
    {},
  );
}

beforeAll(async () => {
  const db = await import("@/db/client");
  database = db.getPgliteClientForTests();
  close = db.closeDatabaseConnectionsForTests;
  ({ appDelegationsRepository: repository } = await import(
    "@/db/repositories/app-delegations"
  ));
  ({ appDelegationService: service } = await import(
    "@/lib/services/app-delegation-adapter"
  ));
  ({ issueAppAuthCode: issueCode } = await import(
    "@/lib/services/app-auth-codes"
  ));
  const { createAppDelegationRoutes, appDelegationErrorResponse } =
    await import("./_handlers");
  const { requireAppActor, requireAppBillingActor } = await import(
    "@/lib/auth/app-delegation-auth"
  );
  const { default: connectRoutes } = await import("../connect/route");
  await database.exec(`
    CREATE TABLE organizations (id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE users (id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id), email text, name text, email_verified boolean DEFAULT false, is_active boolean DEFAULT true, is_anonymous boolean DEFAULT false, deleted_at timestamptz, expires_at timestamp);
    CREATE TABLE apps (id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id), name text NOT NULL, app_url text NOT NULL, allowed_origins jsonb NOT NULL DEFAULT '[]', is_active boolean DEFAULT true, is_approved boolean DEFAULT true, total_users integer DEFAULT 0);
    CREATE TABLE app_users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), app_id uuid REFERENCES apps(id), user_id uuid REFERENCES users(id), signup_source text, referral_code_used text, ip_address text, user_agent text, total_requests integer DEFAULT 0, total_credits_used numeric DEFAULT 0, first_seen_at timestamp DEFAULT now(), last_seen_at timestamp DEFAULT now(), metadata jsonb DEFAULT '{}', UNIQUE(app_id,user_id));
  `);
  await database.exec(
    await Bun.file(
      new URL(
        "../../../../shared/src/db/migrations/0387_app_delegations.sql",
        import.meta.url,
      ),
    ).text(),
  );
  await database.exec(
    await Bun.file(
      new URL(
        "../../../../shared/src/db/migrations/0417_app_billing_return_destination.sql",
        import.meta.url,
      ),
    ).text(),
  );
  routes = new Hono<AppEnv>();
  routes.onError(appDelegationErrorResponse);
  // The auth boundary supplies a canonical free user; the consent/repository/code/HTTP paths remain real.
  routes.use("*", async (c, next) => {
    if (c.req.header("Authorization") === "Bearer fixture-session") {
      c.set("authMethod", "session");
      c.set("user", {
        id: USER,
        created_at: new Date(0),
        email: "buyer@example.test",
        organization_id: null,
        organization: null,
        is_active: true,
        is_anonymous: false,
        role: "member",
        steward_id: null,
        wallet_address: null,
      });
    }
    return next();
  });
  routes.get("/billing/:appId", async (c) =>
    c.json(
      await requireAppBillingActor(c, c.req.param("appId"), "billing:read"),
    ),
  );
  routes.get("/inference/:appId", async (c) =>
    c.json(await requireAppActor(c, c.req.param("appId"), "inference")),
  );
  routes.route("/connect", connectRoutes);
  routes.route(
    "/delegations",
    createAppDelegationRoutes(service, {
      list: async () => [
        {
          provider: "google",
          side: "owner",
          mode: "cloud_managed",
          configured: true,
          connected: true,
          reason: "connected",
          identity: { email: "buyer@gmail.test" },
          grantedCapabilities: ["google.basic_identity", "google.gmail.triage"],
          grantedScopes: ["openid"],
          expiresAt: null,
          hasRefreshToken: true,
          connectionId: CONNECTION,
          linkedAt: null,
          lastUsedAt: null,
        },
      ],
      connect: async (input) => {
        googleCalls.push(JSON.stringify(input));
        return {
          provider: "google",
          side: "owner",
          mode: "cloud_managed",
          requestedCapabilities: input.capabilities ?? [],
          redirectUri: input.redirectUrl ?? REDIRECT,
          authUrl: "https://accounts.google.com/o/oauth2/auth?state=fixture",
        };
      },
      fetch: async (input) => {
        googleCalls.push(input.url);
        return Response.json({
          messages: [{ id: "first" }],
          nextPageToken: "continue-real-page-contract",
          receipt: input.options?.body,
        });
      },
    }),
  );
}, 60_000);

beforeEach(async () => {
  googleCalls = [];
  await database.exec(`TRUNCATE organizations,users,apps,app_users,app_client_registrations,app_delegations CASCADE;
    INSERT INTO organizations(id) VALUES ('${ORG}'),('${OTHER_ORG}');
    INSERT INTO users(id,email,name) VALUES ('${USER}','buyer@example.test','Free Buyer');
    INSERT INTO apps(id,organization_id,name,app_url) VALUES ('${APP_A}','${ORG}','App A','https://app.example'),('${APP_B}','${ORG}','App B','https://app.example');`);
  clientA = await repository.register(APP_A, ORG, {
    redirectUris: [REDIRECT],
    allowedScopes: SCOPES,
    billingEnvironment: "test",
  });
  clientB = await repository.register(APP_B, ORG, {
    redirectUris: [REDIRECT],
    allowedScopes: SCOPES,
    billingEnvironment: "test",
  });
});

afterAll(async () => {
  await close();
});

describe("registered app delegation HTTP and database authority", () => {
  test("a free user explicitly consents separately to two apps, and neither can borrow the other's grant", async () => {
    const a = await grant();
    const b = await grant(["identity"], APP_B, clientB);
    expect(a.user.organizationId).toBeNull();
    const own = await routes.request(
      "https://cloud.example/delegations/identity",
      { headers: headers(clientA, a.token) },
      {},
    );
    expect(own.status).toBe(200);
    expect(((await own.json()) as { data: { id: string } }).data.id).toBe(USER);
    expect(
      (
        await routes.request(
          "https://cloud.example/delegations/identity",
          { headers: headers(clientB, a.token) },
          {},
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await routes.request(
          "https://cloud.example/delegations/identity",
          { headers: headers(clientB, b.token) },
          {},
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await googleRequest(
          a.token,
          "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        )
      ).status,
    ).toBe(403);
    expect(googleCalls).toEqual([]);
  });

  test("canonical codes cannot replay concurrently and legacy broad codes cannot become delegated credentials", async () => {
    const code = await consent();
    const responses = await Promise.all([exchange(code), exchange(code)]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 401,
    ]);
    const oldCode = await issueCode({ appId: APP_A, userId: USER });
    expect((await exchange(oldCode.code)).status).toBe(401);
  });

  test("database consumption fence survives revocation even if a code backend returns stale data", async () => {
    await consent();
    const { AppDelegationService } = await import(
      "@/lib/services/app-delegation"
    );
    const binding = await service.consentBinding(APP_A, USER, {
      clientId: clientA.clientId,
      redirectUri: REDIRECT,
      scopes: ["identity"],
    });
    const record = {
      appId: APP_A,
      userId: USER,
      delegation: binding,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const staleCacheService = new AppDelegationService(
      repository,
      async () => record,
    );
    const code = `eac_${crypto.randomUUID()}`;
    const issued = await staleCacheService.exchange(
      clientA.clientId,
      clientA.clientSecret,
      code,
      REDIRECT,
    );
    await staleCacheService.revoke(
      clientA.clientId,
      clientA.clientSecret,
      issued.token,
    );
    await expect(
      staleCacheService.exchange(
        clientA.clientId,
        clientA.clientSecret,
        code,
        REDIRECT,
      ),
    ).rejects.toMatchObject({ code: "APP_AUTH_CODE_REPLAY" });
  });

  test("user revocation and reconnection cannot revive old grants or pending codes", async () => {
    const issued = await grant();
    const pending = await consent();
    const revoke = await routes.request(
      `https://cloud.example/delegations/consent?appId=${APP_A}`,
      {
        method: "DELETE",
        headers: { Authorization: "Bearer fixture-session" },
      },
      {},
    );
    expect(revoke.status).toBe(200);
    await consent();
    expect((await exchange(pending)).status).toBe(403);
    expect(
      (
        await routes.request(
          "https://cloud.example/delegations/identity",
          { headers: headers(clientA, issued.token) },
          {},
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await database.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM app_delegations",
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  test("client rotation and membership changes invalidate existing credentials", async () => {
    const issued = await grant();
    const rotated = await repository.rotate(
      APP_A,
      clientA.clientId,
      ORG,
      false,
    );
    if (!rotated.clientSecret)
      throw new Error("Rotation must produce a replacement secret");
    expect(
      (
        await routes.request(
          "https://cloud.example/delegations/identity",
          { headers: headers(clientA, issued.token) },
          {},
        )
      ).status,
    ).toBe(401);
    clientA = { ...rotated, clientSecret: rotated.clientSecret };
    expect(
      (
        await routes.request(
          "https://cloud.example/delegations/identity",
          { headers: headers(clientA, issued.token) },
          {},
        )
      ).status,
    ).toBe(401);
    const current = await grant();
    await database.query("UPDATE users SET organization_id=$1 WHERE id=$2", [
      OTHER_ORG,
      USER,
    ]);
    expect(
      (
        await routes.request(
          "https://cloud.example/delegations/identity",
          { headers: headers(clientA, current.token) },
          {},
        )
      ).status,
    ).toBe(401);
  });

  test("registration rejects other owners and consent rejects unregistered redirects and capabilities", async () => {
    await expect(
      repository.register(APP_A, OTHER_ORG, {
        redirectUris: [REDIRECT],
        allowedScopes: ["identity"],
        billingEnvironment: "test",
      }),
    ).rejects.toMatchObject({ code: "APP_OWNER_REQUIRED" });
    await expect(
      repository.register(APP_A, ORG, {
        redirectUris: ["https://evil.example/callback"],
        allowedScopes: ["identity"],
        billingEnvironment: "test",
      }),
    ).rejects.toMatchObject({ code: "APP_REDIRECT_INVALID" });
    await expect(
      service.validateConsent(APP_B, {
        clientId: clientA.clientId,
        redirectUri: REDIRECT,
        scopes: ["identity"],
      }),
    ).rejects.toMatchObject({ code: "APP_CLIENT_BINDING_INVALID" });
    await expect(
      service.validateConsent(APP_A, {
        clientId: clientA.clientId,
        redirectUri: `${REDIRECT}?different=1`,
        scopes: ["identity"],
      }),
    ).rejects.toMatchObject({ code: "APP_CLIENT_BINDING_INVALID" });
    await expect(
      service.validateConsent(APP_A, {
        clientId: clientA.clientId,
        redirectUri: REDIRECT,
        scopes: ["identity", "google.basic_identity", "google.calendar.write"],
      }),
    ).rejects.toMatchObject({ code: "APP_SCOPE_DENIED" });
  });

  test("Google initiation never adds mail or calendar scopes, and transport checks both app and provider grants", async () => {
    await database.query("UPDATE users SET organization_id=$1 WHERE id=$2", [
      ORG,
      USER,
    ]);
    const issued = await grant([
      "identity",
      "google.basic_identity",
      "google.gmail.triage",
      "google.gmail.send",
    ]);
    const connect = await routes.request(
      "https://cloud.example/delegations/google/connect",
      {
        method: "POST",
        headers: headers(clientA, issued.token),
        body: JSON.stringify({
          redirectUri: REDIRECT,
          capabilities: ["google.basic_identity"],
        }),
      },
      {},
    );
    expect(connect.status).toBe(200);
    expect(JSON.parse(googleCalls[0] ?? "null").capabilities).toEqual([
      "google.basic_identity",
    ]);
    expect(
      (
        await googleRequest(
          issued.token,
          "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          '{"raw":"mail"}',
        )
      ).status,
    ).toBe(403);
    const read = await googleRequest(
      issued.token,
      "https://gmail.googleapis.com/gmail/v1/users/me/messages?pageToken=previous",
    );
    expect(read.status).toBe(200);
    expect(
      ((await read.json()) as { nextPageToken: string }).nextPageToken,
    ).toBe("continue-real-page-contract");
    const calls = googleCalls.length;
    expect(
      (
        await googleRequest(
          issued.token,
          "https://evil.example/gmail/v1/users/me/messages",
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await googleRequest(
          issued.token,
          "https://gmail.googleapis.com/gmail/v1/users/me/messages?access_token=anything",
        )
      ).status,
    ).toBe(403);
    expect(googleCalls.length).toBe(calls);
  });
  test("the public SDK exchanges and revokes a user grant over HTTP without any Eliza paid state", async () => {
    const { AppDelegationClient } = await import(
      "@elizaos/cloud-sdk/app-delegation"
    );
    const http = new Hono<AppEnv>();
    http.route(
      "/app-auth/delegations/token",
      (await import("./token/route")).default,
    );
    http.route(
      "/app-auth/delegations/identity",
      (await import("./identity/route")).default,
    );
    http.route(
      "/app-auth/delegations/revoke",
      (await import("./revoke/route")).default,
    );
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => http.fetch(request, {}),
    });
    try {
      const client = new AppDelegationClient({
        ...clientA,
        apiBaseUrl: server.url.toString(),
      });
      const result = await client.exchange(await consent(), REDIRECT);
      expect((await client.identity(result.data.token)).data.id).toBe(USER);
      expect(client.headers(result.data.token).get("Authorization")).toBe(
        headers().Authorization,
      );
      await client.revoke(result.data.token);
      await expect(client.identity(result.data.token)).rejects.toMatchObject({
        statusCode: 401,
      });
    } finally {
      await server.stop(true);
    }
  });

  test.each([
    ["user deactivation", "UPDATE users SET is_active=false"],
    ["user expiry", "UPDATE users SET expires_at=now()-interval '1 second'"],
    ["app suspension", "UPDATE apps SET is_approved=false"],
    [
      "app ownership transfer",
      `UPDATE apps SET organization_id='${OTHER_ORG}'`,
    ],
    [
      "grant expiry",
      "UPDATE app_delegations SET expires_at=now()-interval '1 second'",
    ],
  ])(
    "%s immediately denies existing delegated access",
    async (_reason, mutation) => {
      const issued = await grant();
      await database.exec(mutation);
      expect(
        (
          await routes.request(
            "https://cloud.example/delegations/identity",
            { headers: headers(clientA, issued.token) },
            {},
          )
        ).status,
      ).toBe(401);
    },
  );
  test("billing actors inherit registered test/live mode and cannot override it with buyer input", async () => {
    const testGrant = await grant(["identity", "billing:read"]);
    const liveClient = await repository.register(APP_A, ORG, {
      redirectUris: [REDIRECT],
      allowedScopes: ["identity", "billing:read"],
      billingEnvironment: "live",
    });
    const liveGrant = await grant(
      ["identity", "billing:read"],
      APP_A,
      liveClient,
    );
    expect(testGrant.billingEnvironment).toBe("test");
    expect(liveGrant.billingEnvironment).toBe("live");
    const testActor = await routes.request(
      `https://cloud.example/billing/${APP_A}?billingEnvironment=live`,
      { headers: headers(clientA, testGrant.token) },
      {},
    );
    expect(
      ((await testActor.json()) as { billingEnvironment: string })
        .billingEnvironment,
    ).toBe("test");
    const liveActor = await routes.request(
      `https://cloud.example/billing/${APP_A}`,
      { headers: headers(liveClient, liveGrant.token) },
      {},
    );
    expect(
      ((await liveActor.json()) as { billingEnvironment: string })
        .billingEnvironment,
    ).toBe("live");
    const denied = await routes.request(
      `https://cloud.example/billing/${APP_A}`,
      { headers: headers(clientA, (await grant()).token) },
      {},
    );
    expect(denied.status).toBe(403);
    const native = await routes.request(
      `https://cloud.example/billing/${APP_A}`,
      { headers: { Authorization: "Bearer fixture-session" } },
      {},
    );
    expect(native.status).toBe(200);
    expect(
      ((await native.json()) as { billingEnvironment: null })
        .billingEnvironment,
    ).toBeNull();
  });
  test("inference requires its own explicit consent and preserves app isolation", async () => {
    for (const scopes of [
      ["identity"],
      ["identity", "billing:read", "billing:write"],
    ] satisfies AppDelegationScope[][]) {
      const denied = await routes.request(
        `https://cloud.example/inference/${APP_A}`,
        { headers: headers(clientA, (await grant(scopes)).token) },
        {},
      );
      expect(denied.status).toBe(403);
    }
    const delegated = await grant(["identity", "inference"]);
    const authorized = await routes.request(
      `https://cloud.example/inference/${APP_A}`,
      { headers: headers(clientA, delegated.token) },
      {},
    );
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({
      appId: APP_A,
      userId: USER,
      billingEnvironment: "test",
      clientId: clientA.clientId,
    });
    const otherApp = await routes.request(
      `https://cloud.example/inference/${APP_B}`,
      { headers: headers(clientA, delegated.token) },
      {},
    );
    expect(otherApp.status).toBe(403);
  });
  test("registration inventory is scoped to the current app owner and excludes every credential", async () => {
    const listed = await repository.list(APP_A, ORG);
    expect(listed.map((client) => client.clientId)).toEqual([clientA.clientId]);
    expect(JSON.stringify(listed)).not.toContain(clientA.clientSecret);
    expect(JSON.stringify(listed)).not.toContain("secret_hashes");
    await expect(repository.list(APP_A, OTHER_ORG)).rejects.toMatchObject({
      code: "APP_OWNER_REQUIRED",
    });
    await database.exec(
      `UPDATE apps SET organization_id = '${OTHER_ORG}' WHERE id = '${APP_A}'`,
    );
    const transferred = await repository.list(APP_A, OTHER_ORG);
    expect(transferred[0].active).toBe(false);
  });
});
