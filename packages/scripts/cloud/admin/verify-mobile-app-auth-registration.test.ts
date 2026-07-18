/**
 * Validates the mobile App Auth release preflight's pure protocol guards and
 * executes its exact snapshot query against in-process PGlite.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
  MOBILE_APP_AUTH_CONFIG_MAX_BYTES,
  type MobileAppAuthRegistrationRow,
  mobileAppAuthConfigUrl,
  queryMobileAppAuthRegistration,
  requireMobileAppAuthAppId,
  requireMobileAppAuthEnabled,
  requireMobileAppAuthEnvironment,
  validateDisabledMobileAppAuthConfigPayload,
  validateMobileAppAuthConfigPayload,
  validateMobileAppAuthRegistrationRow,
  verifyLiveMobileAppAuthConfig,
} from "./verify-mobile-app-auth-registration";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_APP_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_APP_ID = "88888888-8888-4888-8888-888888888888";
const ORGANIZATION_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_ORGANIZATION_ID = "44444444-4444-4444-8444-444444444444";
const CREATOR_ID = "55555555-5555-4555-8555-555555555555";
const OTHER_CREATOR_ID = "66666666-6666-4666-8666-666666666666";
const GENERATED_KEY_ID = "77777777-7777-4777-8777-777777777777";

function liveResponse(
  environment: "staging" | "production",
  body: unknown = publicConfig(environment),
  init: ResponseInit = {},
  finalUrl = mobileAppAuthConfigUrl(environment).toString(),
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "no-store");
  if (!headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const response = new Response(JSON.stringify(body), {
    ...init,
    headers,
    status: init.status ?? 200,
  });
  Object.defineProperty(response, "url", { value: finalUrl });
  return response;
}

function registration(
  overrides: Partial<MobileAppAuthRegistrationRow> = {},
): MobileAppAuthRegistrationRow {
  return {
    id: APP_ID,
    app_url: "https://eliza.app",
    allowed_origins: ["https://eliza.app/auth/callback"],
    is_active: true,
    is_approved: true,
    organization_exists: true,
    organization_is_active: true,
    creator_exists: true,
    creator_is_active: true,
    creator_matches_organization: true,
    creator_role: "owner",
    has_api_key_id: true,
    api_key_row_absent: true,
    api_key_row_revoked: false,
    api_key_ownership_matches: false,
    matching_active_approved_registration_count: 1,
    ...overrides,
  };
}

function publicConfig(environment: "staging" | "production") {
  return {
    success: true,
    clientId: "ai.elizaos.app",
    environment,
    redirectUri: "https://eliza.app/auth/callback",
    codeChallengeMethod: "S256",
    scopes: ["cloud:user"],
    app: {
      name: "Eliza iOS",
      description: "First-party native app",
      logoUrl: "https://eliza.app/logo.png",
      websiteUrl: "https://eliza.app",
    },
  };
}

function disabledConfig() {
  return {
    success: false,
    error: "server_configuration_error",
    errorDescription: "Mobile App Auth is disabled for this environment",
    retryable: false,
  };
}

describe("mobile App Auth deployment preflight", () => {
  test("accepts the dedicated active and approved first-party registration", () => {
    expect(() =>
      validateMobileAppAuthRegistrationRow(registration(), APP_ID),
    ).not.toThrow();
  });

  test("rejects missing, inactive, unapproved, and mismatched registrations", () => {
    expect(() =>
      validateMobileAppAuthRegistrationRow(undefined, APP_ID),
    ).toThrow(/does not resolve/);
    expect(() =>
      validateMobileAppAuthRegistrationRow(
        registration({ is_active: false }),
        APP_ID,
      ),
    ).toThrow(/active and approved/);
    expect(() =>
      validateMobileAppAuthRegistrationRow(
        registration({ is_approved: false }),
        APP_ID,
      ),
    ).toThrow(/active and approved/);
    expect(() =>
      validateMobileAppAuthRegistrationRow(
        registration({ id: "22222222-2222-4222-8222-222222222222" }),
        APP_ID,
      ),
    ).toThrow(/did not match/);
  });

  test("requires the literal app URL and sole literal callback", () => {
    for (const row of [
      registration({ app_url: "not-a-url" }),
      registration({ app_url: "http://eliza.app" }),
      registration({ app_url: "https://example.com" }),
      registration({ app_url: "https://eliza.app/" }),
      registration({ app_url: "https://eliza.app/mobile" }),
      registration({ app_url: "https://eliza.app?native=true" }),
      registration({ allowed_origins: ["*"] }),
      registration({ allowed_origins: ["https://*.eliza.app"] }),
      registration({ allowed_origins: ["https://example.com"] }),
      registration({ allowed_origins: ["https://eliza.app"] }),
      registration({ allowed_origins: ["https://eliza.app/auth/callback/"] }),
      registration({
        allowed_origins: [
          "https://eliza.app/auth/callback",
          "https://eliza.app/other",
        ],
      }),
      registration({ allowed_origins: [] }),
      registration({ allowed_origins: "https://eliza.app" }),
    ]) {
      expect(() => validateMobileAppAuthRegistrationRow(row, APP_ID)).toThrow();
    }
  });

  test("requires an active organization and active privileged creator in that organization", () => {
    expect(() =>
      validateMobileAppAuthRegistrationRow(
        registration({ creator_role: "admin" }),
        APP_ID,
      ),
    ).not.toThrow();

    const cases: Array<{
      row: MobileAppAuthRegistrationRow;
      expected: RegExp;
    }> = [
      {
        row: registration({ organization_exists: false }),
        expected: /organization must exist and be active/,
      },
      {
        row: registration({ organization_is_active: false }),
        expected: /organization must exist and be active/,
      },
      {
        row: registration({ creator_exists: false }),
        expected: /creator must exist and be active/,
      },
      {
        row: registration({ creator_is_active: false }),
        expected: /creator must exist and be active/,
      },
      {
        row: registration({ creator_matches_organization: false }),
        expected: /belong to its organization/,
      },
      {
        row: registration({ creator_role: "member" }),
        expected: /owner or admin/,
      },
      {
        row: registration({ creator_role: null }),
        expected: /owner or admin/,
      },
    ];

    for (const { expected, row } of cases) {
      expect(() => validateMobileAppAuthRegistrationRow(row, APP_ID)).toThrow(
        expected,
      );
    }
  });

  test("requires the generated key reference to be absent or durably revoked", () => {
    expect(() =>
      validateMobileAppAuthRegistrationRow(
        registration({
          api_key_ownership_matches: true,
          api_key_row_absent: false,
          api_key_row_revoked: true,
        }),
        APP_ID,
      ),
    ).not.toThrow();

    for (const row of [
      registration({ has_api_key_id: false }),
      registration({
        api_key_ownership_matches: true,
        api_key_row_absent: false,
        api_key_row_revoked: false,
      }),
      registration({
        api_key_ownership_matches: false,
        api_key_row_absent: false,
        api_key_row_revoked: true,
      }),
    ]) {
      expect(() => validateMobileAppAuthRegistrationRow(row, APP_ID)).toThrow();
    }
  });

  test("rejects missing or duplicate active callback claims", () => {
    for (const count of [0, 2]) {
      expect(() =>
        validateMobileAppAuthRegistrationRow(
          registration({
            matching_active_approved_registration_count: count,
          }),
          APP_ID,
        ),
      ).toThrow(/Exactly one active and approved app/);
    }
  });

  test("requires exact environment UUID and deployment environment values", () => {
    expect(requireMobileAppAuthAppId(APP_ID)).toBe(APP_ID);
    expect(() => requireMobileAppAuthAppId("not-a-uuid")).toThrow(
      /registered app UUID/,
    );
    expect(requireMobileAppAuthEnvironment("staging")).toBe("staging");
    expect(requireMobileAppAuthEnvironment("production")).toBe("production");
    expect(() => requireMobileAppAuthEnvironment("preview")).toThrow(
      /staging or production/,
    );
    expect(requireMobileAppAuthEnabled("true")).toBe(true);
    expect(requireMobileAppAuthEnabled("false")).toBe(false);
    expect(() => requireMobileAppAuthEnabled("1")).toThrow(
      /exactly true or false/,
    );
  });

  test("builds only canonical staging and production public config probes", () => {
    expect(mobileAppAuthConfigUrl("staging").toString()).toBe(
      "https://api-staging.elizacloud.ai/api/v1/app-auth/mobile/config?clientId=ai.elizaos.app&environment=staging&redirectUri=https%3A%2F%2Feliza.app%2Fauth%2Fcallback",
    );
    expect(mobileAppAuthConfigUrl("production").origin).toBe(
      "https://api.elizacloud.ai",
    );
  });

  test("accepts the exact public protocol and rejects drift or internal IDs", () => {
    expect(() =>
      validateMobileAppAuthConfigPayload(publicConfig("staging"), "staging"),
    ).not.toThrow();
    expect(() =>
      validateMobileAppAuthConfigPayload(publicConfig("staging"), "production"),
    ).toThrow(/release contract/);
    expect(() =>
      validateMobileAppAuthConfigPayload(
        { ...publicConfig("staging"), appId: APP_ID },
        "staging",
      ),
    ).toThrow(/release contract/);
    expect(() =>
      validateMobileAppAuthConfigPayload(
        {
          ...publicConfig("staging"),
          app: { ...publicConfig("staging").app, id: APP_ID },
        },
        "staging",
      ),
    ).toThrow(/invalid app metadata/);
    expect(() =>
      validateMobileAppAuthConfigPayload(
        {
          ...publicConfig("staging"),
          app: { ...publicConfig("staging").app, name: "x".repeat(121) },
        },
        "staging",
      ),
    ).toThrow(/invalid app metadata/);
  });

  test("accepts only the exact disabled release response", () => {
    expect(() =>
      validateDisabledMobileAppAuthConfigPayload(disabledConfig()),
    ).not.toThrow();
    expect(() =>
      validateDisabledMobileAppAuthConfigPayload({
        ...disabledConfig(),
        retryable: true,
      }),
    ).toThrow(/disabled mobile App Auth config response/);
    expect(() =>
      validateDisabledMobileAppAuthConfigPayload({
        ...disabledConfig(),
        appId: APP_ID,
      }),
    ).toThrow(/disabled mobile App Auth config response/);
  });

  test("live verification fails closed on HTTP and protocol errors", async () => {
    const requestedUrls: string[] = [];
    const requestInits: RequestInit[] = [];
    await verifyLiveMobileAppAuthConfig(
      "production",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requestedUrls.push(String(input));
        requestInits.push(init ?? {});
        return liveResponse("production");
      },
    );
    expect(requestedUrls).toEqual([
      "https://api.elizacloud.ai/api/v1/app-auth/mobile/config?clientId=ai.elizaos.app&environment=production&redirectUri=https%3A%2F%2Feliza.app%2Fauth%2Fcallback",
    ]);
    expect(requestInits[0]?.redirect).toBe("manual");
    expect(new Headers(requestInits[0]?.headers).get("Accept")).toBe(
      "application/json",
    );

    await expect(
      verifyLiveMobileAppAuthConfig("staging", async () =>
        liveResponse("staging", { error: "unavailable" }, { status: 503 }),
      ),
    ).rejects.toThrow(/HTTP 503/);
    await expect(
      verifyLiveMobileAppAuthConfig("staging", async () =>
        liveResponse("staging", publicConfig("production")),
      ),
    ).rejects.toThrow(/release contract/);
    await verifyLiveMobileAppAuthConfig(
      "staging",
      async () => liveResponse("staging", disabledConfig(), { status: 503 }),
      false,
    );
    await expect(
      verifyLiveMobileAppAuthConfig(
        "staging",
        async () => liveResponse("staging", publicConfig("staging")),
        false,
      ),
    ).rejects.toThrow(/HTTP 200/);
  });

  test("live verification rejects redirects, URL drift, media drift, and cacheability", async () => {
    const cases: Array<{ response: Response; expected: RegExp }> = [
      {
        response: liveResponse("staging", null, {
          headers: { Location: "https://attacker.example/config" },
          status: 302,
        }),
        expected: /HTTP 302/,
      },
      {
        response: liveResponse(
          "staging",
          publicConfig("staging"),
          {},
          "https://attacker.example/config",
        ),
        expected: /final URL/,
      },
      {
        response: liveResponse("staging", publicConfig("staging"), {
          status: 201,
        }),
        expected: /HTTP 201/,
      },
      {
        response: liveResponse("staging", publicConfig("staging"), {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }),
        expected: /exactly application\/json/,
      },
      {
        response: liveResponse("staging", publicConfig("staging"), {
          headers: { "Cache-Control": "public, max-age=60" },
        }),
        expected: /exactly Cache-Control: no-store/,
      },
    ];

    for (const { expected, response } of cases) {
      await expect(
        verifyLiveMobileAppAuthConfig("staging", async () => response),
      ).rejects.toThrow(expected);
    }
  });

  test("live verification bounds the body even without a Content-Length", async () => {
    const oversized = liveResponse("staging", {
      ...publicConfig("staging"),
      padding: "x".repeat(MOBILE_APP_AUTH_CONFIG_MAX_BYTES),
    });
    oversized.headers.delete("Content-Length");

    await expect(
      verifyLiveMobileAppAuthConfig("staging", async () => oversized),
    ).rejects.toThrow(/size limit/);

    const declaredOversized = liveResponse("staging");
    declaredOversized.headers.set(
      "Content-Length",
      String(MOBILE_APP_AUTH_CONFIG_MAX_BYTES + 1),
    );
    await expect(
      verifyLiveMobileAppAuthConfig("staging", async () => declaredOversized),
    ).rejects.toThrow(/size limit/);
  });
});

describe("mobile App Auth registration database snapshot", () => {
  let database: PGlite;

  async function insertOrganization(
    id: string,
    isActive = true,
  ): Promise<void> {
    await database.query(
      "INSERT INTO organizations (id, is_active) VALUES ($1::uuid, $2)",
      [id, isActive],
    );
  }

  async function insertCreator(input: {
    id: string;
    organizationId: string | null;
    role?: string;
    isActive?: boolean;
    deletedAt?: Date | null;
  }): Promise<void> {
    await database.query(
      `INSERT INTO users
         (id, organization_id, role, is_active, deleted_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5)`,
      [
        input.id,
        input.organizationId,
        input.role ?? "owner",
        input.isActive ?? true,
        input.deletedAt ?? null,
      ],
    );
  }

  async function insertApp(input: {
    id: string;
    organizationId: string;
    creatorId: string;
    appUrl?: string;
    allowedOrigins?: unknown;
    isActive?: boolean;
    isApproved?: boolean;
    apiKeyId?: string | null;
  }): Promise<void> {
    await database.query(
      `INSERT INTO apps
         (id, organization_id, created_by_user_id, app_url, allowed_origins,
          is_active, is_approved, api_key_id)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6, $7, $8::uuid)`,
      [
        input.id,
        input.organizationId,
        input.creatorId,
        input.appUrl ?? "https://eliza.app",
        JSON.stringify(
          input.allowedOrigins ?? ["https://eliza.app/auth/callback"],
        ),
        input.isActive ?? true,
        input.isApproved ?? true,
        input.apiKeyId === undefined ? GENERATED_KEY_ID : input.apiKeyId,
      ],
    );
  }

  async function seedSelectedRegistration(): Promise<void> {
    await insertOrganization(ORGANIZATION_ID);
    await insertCreator({
      id: CREATOR_ID,
      organizationId: ORGANIZATION_ID,
    });
    await insertApp({
      id: APP_ID,
      organizationId: ORGANIZATION_ID,
      creatorId: CREATOR_ID,
    });
  }

  async function readRegistration(
    appId = APP_ID,
  ): Promise<MobileAppAuthRegistrationRow | undefined> {
    return await queryMobileAppAuthRegistration(async (text, values) => {
      const result = await database.query<MobileAppAuthRegistrationRow>(
        text,
        values,
      );
      return { rows: result.rows };
    }, appId);
  }

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE TABLE organizations (
        id uuid PRIMARY KEY,
        is_active boolean NOT NULL
      );
      CREATE TABLE users (
        id uuid PRIMARY KEY,
        organization_id uuid,
        role text NOT NULL,
        is_active boolean NOT NULL,
        deleted_at timestamptz
      );
      CREATE TABLE api_keys (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        user_id uuid NOT NULL,
        is_active boolean NOT NULL,
        deleted_at timestamptz
      );
      CREATE TABLE apps (
        id uuid PRIMARY KEY,
        organization_id uuid NOT NULL,
        created_by_user_id uuid NOT NULL,
        app_url text NOT NULL,
        allowed_origins jsonb NOT NULL,
        is_active boolean NOT NULL,
        is_approved boolean NOT NULL,
        api_key_id uuid
      );
    `);
  });

  beforeEach(async () => {
    await database.exec("TRUNCATE apps, api_keys, users, organizations");
  });

  afterAll(async () => {
    await database.close();
  });

  test("reads the complete valid state in one parameterized statement", async () => {
    await seedSelectedRegistration();
    let queryCalls = 0;
    const row = await queryMobileAppAuthRegistration(async (text, values) => {
      queryCalls += 1;
      expect(text).not.toContain(APP_ID);
      expect(values).toEqual([APP_ID, "https://eliza.app/auth/callback"]);
      const result = await database.query<MobileAppAuthRegistrationRow>(
        text,
        values,
      );
      return { rows: result.rows };
    }, APP_ID);

    expect(queryCalls).toBe(1);
    expect(row).toEqual(registration());
    expect(() =>
      validateMobileAppAuthRegistrationRow(row, APP_ID),
    ).not.toThrow();
  });

  test("returns no fabricated state when the configured app is missing", async () => {
    await expect(readRegistration()).resolves.toBeUndefined();
  });

  test("caps duplicate discovery and ignores inactive or unapproved callback rows", async () => {
    await seedSelectedRegistration();
    await insertOrganization(OTHER_ORGANIZATION_ID);
    await insertCreator({
      id: OTHER_CREATOR_ID,
      organizationId: OTHER_ORGANIZATION_ID,
    });
    await insertApp({
      id: OTHER_APP_ID,
      organizationId: OTHER_ORGANIZATION_ID,
      creatorId: OTHER_CREATOR_ID,
      appUrl: "https://example.com",
      allowedOrigins: [
        "https://eliza.app/auth/callback",
        "https://example.com/callback",
      ],
      apiKeyId: null,
      isActive: false,
    });

    expect(
      (await readRegistration())?.matching_active_approved_registration_count,
    ).toBe(1);
    await database.query(
      "UPDATE apps SET is_active = TRUE, is_approved = FALSE WHERE id = $1::uuid",
      [OTHER_APP_ID],
    );
    expect(
      (await readRegistration())?.matching_active_approved_registration_count,
    ).toBe(1);
    await database.query(
      "UPDATE apps SET is_approved = TRUE WHERE id = $1::uuid",
      [OTHER_APP_ID],
    );
    await insertApp({
      id: THIRD_APP_ID,
      organizationId: OTHER_ORGANIZATION_ID,
      creatorId: OTHER_CREATOR_ID,
      apiKeyId: null,
    });

    const duplicate = await readRegistration();
    expect(duplicate?.matching_active_approved_registration_count).toBe(2);
    expect(() =>
      validateMobileAppAuthRegistrationRow(duplicate, APP_ID),
    ).toThrow(/Exactly one active and approved app/);
  });

  test("distinguishes an active key from a same-owner durable revocation", async () => {
    await seedSelectedRegistration();
    await database.query(
      `INSERT INTO api_keys
         (id, organization_id, user_id, is_active, deleted_at)
       VALUES ($1::uuid, $2::uuid, $3::uuid, TRUE, NULL)`,
      [GENERATED_KEY_ID, ORGANIZATION_ID, CREATOR_ID],
    );

    const activeKey = await readRegistration();
    expect(activeKey).toMatchObject({
      api_key_ownership_matches: true,
      api_key_row_absent: false,
      api_key_row_revoked: false,
    });
    expect(() =>
      validateMobileAppAuthRegistrationRow(activeKey, APP_ID),
    ).toThrow(/generated key must be absent or revoked/);

    await database.query(
      `UPDATE api_keys
          SET is_active = FALSE, deleted_at = now()
        WHERE id = $1::uuid`,
      [GENERATED_KEY_ID],
    );
    const revokedKey = await readRegistration();
    expect(revokedKey).toMatchObject({
      api_key_ownership_matches: true,
      api_key_row_absent: false,
      api_key_row_revoked: true,
    });
    expect(() =>
      validateMobileAppAuthRegistrationRow(revokedKey, APP_ID),
    ).not.toThrow();

    await database.query(
      "UPDATE api_keys SET organization_id = $2::uuid WHERE id = $1::uuid",
      [GENERATED_KEY_ID, OTHER_ORGANIZATION_ID],
    );
    const wrongOwnerKey = await readRegistration();
    expect(() =>
      validateMobileAppAuthRegistrationRow(wrongOwnerKey, APP_ID),
    ).toThrow(/same owner/);
  });

  test("derives organization and creator authority from joined primary state", async () => {
    await seedSelectedRegistration();
    await database.query(
      "UPDATE organizations SET is_active = FALSE WHERE id = $1::uuid",
      [ORGANIZATION_ID],
    );
    await database.query(
      `UPDATE users
          SET role = 'member', is_active = FALSE, deleted_at = now()
        WHERE id = $1::uuid`,
      [CREATOR_ID],
    );

    const row = await readRegistration();
    expect(row).toMatchObject({
      organization_exists: true,
      organization_is_active: false,
      creator_exists: true,
      creator_is_active: false,
      creator_matches_organization: true,
      creator_role: "member",
    });
    expect(() => validateMobileAppAuthRegistrationRow(row, APP_ID)).toThrow(
      /organization must exist and be active/,
    );
  });
});
