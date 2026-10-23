/**
 * Additional client registration (Alpha Phone, Senior Care, Grace): target selection, Worker registry validation, and
 * the real repair transaction against in-process PGlite. Synthetic UUIDs only.
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
  repairRegistrationTransaction,
  resolveTargetRegistration,
} from "./repair-mobile-app-auth-registration";
import {
  ALPHA_PHONE_MOBILE_APP_AUTH_CLIENT_ID,
  alphaPhoneMobileAppAuthTarget,
  GRACE_MOBILE_APP_AUTH_CLIENT_ID,
  graceMobileAppAuthTarget,
  type MobileAppAuthRegistrationRow,
  mobileAppAuthConfigUrl,
  PRIMARY_MOBILE_APP_AUTH_TARGET,
  queryMobileAppAuthRegistration,
  requireRegisteredMobileClientAppId,
  resolveMobileAppAuthRegistrationTarget,
  SENIOR_CARE_MOBILE_APP_AUTH_CLIENT_ID,
  seniorCareMobileAppAuthTarget,
  validateMobileAppAuthConfigPayload,
  validateMobileAppAuthRegistrationRow,
} from "./verify-mobile-app-auth-registration";

const ALPHA_APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRIMARY_APP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORGANIZATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SENIOR_APP_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const GRACE_APP_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const PRODUCTION = alphaPhoneMobileAppAuthTarget("production");
const STAGING = alphaPhoneMobileAppAuthTarget("staging");
const SENIOR_PRODUCTION = seniorCareMobileAppAuthTarget("production");
const SENIOR_STAGING = seniorCareMobileAppAuthTarget("staging");
const GRACE_PRODUCTION = graceMobileAppAuthTarget("production");
const GRACE_STAGING = graceMobileAppAuthTarget("staging");

const registry = (entry: Record<string, unknown>) =>
  JSON.stringify([
    {
      clientId: ALPHA_PHONE_MOBILE_APP_AUTH_CLIENT_ID,
      appId: ALPHA_APP_ID,
      redirectUri: PRODUCTION.redirectUri,
      enabled: true,
      credentialTtlSeconds: 90 * 24 * 60 * 60,
      ...entry,
    },
  ]);

describe("Alpha Phone registration target", () => {
  test("binds each environment to its own App Link callback", () => {
    expect(PRODUCTION).toMatchObject({
      clientId: "ai.elizaresearch.alphaphone",
      redirectUri: "https://eliza.app/alphaphone/auth/callback",
      redirectOrigin: "https://eliza.app",
    });
    expect(STAGING).toMatchObject({
      redirectUri: "https://staging.eliza.app/alphaphone/auth/callback",
      redirectOrigin: "https://staging.eliza.app",
    });
    const url = mobileAppAuthConfigUrl("staging", STAGING);
    expect(url.origin).toBe("https://api-staging.eliza.app");
    expect(url.searchParams.get("clientId")).toBe(
      ALPHA_PHONE_MOBILE_APP_AUTH_CLIENT_ID,
    );
    expect(url.searchParams.get("redirectUri")).toBe(STAGING.redirectUri);
  });

  test("unset selects the primary client; unknown clients and environments fail", () => {
    expect(resolveMobileAppAuthRegistrationTarget(undefined, undefined)).toBe(
      PRIMARY_MOBILE_APP_AUTH_TARGET,
    );
    expect(
      resolveMobileAppAuthRegistrationTarget(
        ALPHA_PHONE_MOBILE_APP_AUTH_CLIENT_ID,
        "production",
      ),
    ).toEqual(PRODUCTION);
    expect(() =>
      resolveMobileAppAuthRegistrationTarget(
        ALPHA_PHONE_MOBILE_APP_AUTH_CLIENT_ID,
        undefined,
      ),
    ).toThrow(/staging or production/);
    expect(() =>
      resolveMobileAppAuthRegistrationTarget("ai.example.other", "production"),
    ).toThrow(/known first-party/);
  });

  test("takes the app UUID only from an enabled, exactly bound registry entry", () => {
    expect(requireRegisteredMobileClientAppId(registry({}), PRODUCTION)).toBe(
      ALPHA_APP_ID,
    );
    const failures: Array<[unknown, RegExp]> = [
      [undefined, /must be configured/],
      ["{", /valid JSON/],
      ["{}", /JSON array/],
      ["[]", /exactly once/],
      [registry({ enabled: false }), /enabled/],
      [registry({ redirectUri: STAGING.redirectUri }), /must use exactly/],
      [registry({ credentialTtlSeconds: 91 * 24 * 60 * 60 }), /ninety days/],
      [registry({ appId: "not-a-uuid" }), /UUID/],
      [registry({ scopes: ["admin"] }), /unknown keys/],
    ];
    for (const [raw, message] of failures) {
      expect(() => requireRegisteredMobileClientAppId(raw, PRODUCTION)).toThrow(
        message,
      );
    }
    // Errors never echo the configured values.
    try {
      requireRegisteredMobileClientAppId(
        registry({ appId: "secret-looking-value" }),
        PRODUCTION,
      );
    } catch (error) {
      expect(String(error)).not.toContain("secret-looking-value");
    }
  });

  test("CLI target resolution reports invariants without values", () => {
    expect(
      resolveTargetRegistration({
        ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID:
          ALPHA_PHONE_MOBILE_APP_AUTH_CLIENT_ID,
        ELIZA_MOBILE_APP_AUTH_ENVIRONMENT: "production",
        ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: registry({}),
      }),
    ).toEqual({ target: PRODUCTION, appId: ALPHA_APP_ID });
    expect(() =>
      resolveTargetRegistration({
        ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID:
          ALPHA_PHONE_MOBILE_APP_AUTH_CLIENT_ID,
        ELIZA_MOBILE_APP_AUTH_ENVIRONMENT: "staging",
        ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: registry({}),
      }),
    ).toThrow(/^input\.The target client registry entry must use exactly/);
  });

  test("the public config for Alpha must name Alpha's client and callback", () => {
    const payload = {
      success: true,
      clientId: ALPHA_PHONE_MOBILE_APP_AUTH_CLIENT_ID,
      environment: "production",
      redirectUri: PRODUCTION.redirectUri,
      codeChallengeMethod: "S256",
      scopes: ["cloud:user"],
      app: {
        name: "Alpha Phone",
        description: null,
        logoUrl: null,
        websiteUrl: null,
      },
    };
    expect(() =>
      validateMobileAppAuthConfigPayload(payload, "production", PRODUCTION),
    ).not.toThrow();
    expect(() =>
      validateMobileAppAuthConfigPayload(payload, "production"),
    ).toThrow(/release contract/);
  });
});

describe("Senior Care registration target", () => {
  test("binds each environment to its own Cloud site callback", () => {
    expect(SENIOR_PRODUCTION).toMatchObject({
      clientId: "ai.elizaresearch.seniorcare",
      redirectUri: "https://cloud.eliza.app/auth/senior-care/callback",
      redirectOrigin: "https://cloud.eliza.app",
    });
    expect(SENIOR_STAGING).toMatchObject({
      redirectUri: "https://cloud-staging.eliza.app/auth/senior-care/callback",
      redirectOrigin: "https://cloud-staging.eliza.app",
    });
    expect(
      resolveMobileAppAuthRegistrationTarget(
        SENIOR_CARE_MOBILE_APP_AUTH_CLIENT_ID,
        "staging",
      ),
    ).toEqual(SENIOR_STAGING);
    expect(() =>
      resolveMobileAppAuthRegistrationTarget(
        SENIOR_CARE_MOBILE_APP_AUTH_CLIENT_ID,
        undefined,
      ),
    ).toThrow(/staging or production/);
  });

  test("selects the Senior Care entry from a registry shared with Alpha Phone", () => {
    const shared = JSON.stringify([
      {
        clientId: ALPHA_PHONE_MOBILE_APP_AUTH_CLIENT_ID,
        appId: ALPHA_APP_ID,
        redirectUri: PRODUCTION.redirectUri,
        enabled: true,
      },
      {
        clientId: SENIOR_CARE_MOBILE_APP_AUTH_CLIENT_ID,
        appId: SENIOR_APP_ID,
        redirectUri: SENIOR_PRODUCTION.redirectUri,
        enabled: true,
      },
    ]);
    expect(
      resolveTargetRegistration({
        ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID:
          SENIOR_CARE_MOBILE_APP_AUTH_CLIENT_ID,
        ELIZA_MOBILE_APP_AUTH_ENVIRONMENT: "production",
        ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: shared,
      }),
    ).toEqual({ target: SENIOR_PRODUCTION, appId: SENIOR_APP_ID });
    expect(
      resolveTargetRegistration({
        ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID:
          ALPHA_PHONE_MOBILE_APP_AUTH_CLIENT_ID,
        ELIZA_MOBILE_APP_AUTH_ENVIRONMENT: "production",
        ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: shared,
      }),
    ).toEqual({ target: PRODUCTION, appId: ALPHA_APP_ID });
    // The production entry does not satisfy the staging callback.
    expect(() =>
      resolveTargetRegistration({
        ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID:
          SENIOR_CARE_MOBILE_APP_AUTH_CLIENT_ID,
        ELIZA_MOBILE_APP_AUTH_ENVIRONMENT: "staging",
        ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: shared,
      }),
    ).toThrow(/^input\.The target client registry entry must use exactly/);
  });
});

describe("Grace registration target", () => {
  test("binds each environment to its own Cloud site callback", () => {
    expect(GRACE_PRODUCTION).toEqual({
      clientId: "technology.graceful.grace",
      redirectUri: "https://cloud.eliza.app/auth/grace/callback",
      redirectOrigin: "https://cloud.eliza.app",
      appName: "Grace",
      appDescription: "First-party Grace native sign-in client",
      slugPrefix: "grace-auth",
    });
    expect(GRACE_STAGING).toMatchObject({
      clientId: "technology.graceful.grace",
      redirectUri: "https://cloud-staging.eliza.app/auth/grace/callback",
      redirectOrigin: "https://cloud-staging.eliza.app",
    });
    expect(
      resolveMobileAppAuthRegistrationTarget(
        GRACE_MOBILE_APP_AUTH_CLIENT_ID,
        "production",
      ),
    ).toEqual(GRACE_PRODUCTION);
    expect(
      resolveMobileAppAuthRegistrationTarget(
        GRACE_MOBILE_APP_AUTH_CLIENT_ID,
        "staging",
      ),
    ).toEqual(GRACE_STAGING);
    expect(() =>
      resolveMobileAppAuthRegistrationTarget(
        GRACE_MOBILE_APP_AUTH_CLIENT_ID,
        undefined,
      ),
    ).toThrow(/staging or production/);
  });

  test("selects the Grace entry beside the retained Senior Care entry", () => {
    const shared = JSON.stringify([
      {
        clientId: SENIOR_CARE_MOBILE_APP_AUTH_CLIENT_ID,
        appId: SENIOR_APP_ID,
        redirectUri: SENIOR_PRODUCTION.redirectUri,
        enabled: true,
      },
      {
        clientId: GRACE_MOBILE_APP_AUTH_CLIENT_ID,
        appId: GRACE_APP_ID,
        redirectUri: GRACE_PRODUCTION.redirectUri,
        enabled: true,
      },
    ]);
    expect(
      resolveTargetRegistration({
        ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID: GRACE_MOBILE_APP_AUTH_CLIENT_ID,
        ELIZA_MOBILE_APP_AUTH_ENVIRONMENT: "production",
        ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: shared,
      }),
    ).toEqual({ target: GRACE_PRODUCTION, appId: GRACE_APP_ID });
    expect(
      resolveTargetRegistration({
        ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID:
          SENIOR_CARE_MOBILE_APP_AUTH_CLIENT_ID,
        ELIZA_MOBILE_APP_AUTH_ENVIRONMENT: "production",
        ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: shared,
      }),
    ).toEqual({ target: SENIOR_PRODUCTION, appId: SENIOR_APP_ID });
    // A Grace entry still bound to the Senior Care callback is refused.
    expect(() =>
      requireRegisteredMobileClientAppId(
        JSON.stringify([
          {
            clientId: GRACE_MOBILE_APP_AUTH_CLIENT_ID,
            appId: GRACE_APP_ID,
            redirectUri: SENIOR_PRODUCTION.redirectUri,
            enabled: true,
          },
        ]),
        GRACE_PRODUCTION,
      ),
    ).toThrow(/must use exactly/);
  });
});

describe("Alpha Phone registration repair transaction", () => {
  let database: PGlite;
  const client = {
    query: async <T extends Record<string, unknown>>(
      text: string,
      values?: unknown[],
    ) => {
      const result = await database.query<T>(text, values);
      return { rows: result.rows };
    },
  };
  const read = (appId: string, target = PRODUCTION) =>
    queryMobileAppAuthRegistration(
      async (text, values) => {
        const result = await database.query<MobileAppAuthRegistrationRow>(
          text,
          values,
        );
        return { rows: result.rows };
      },
      appId,
      target,
    );

  beforeAll(async () => {
    database = new PGlite();
    await database.exec(`
      CREATE TABLE organizations (id uuid PRIMARY KEY, is_active boolean NOT NULL);
      CREATE TABLE users (
        id uuid PRIMARY KEY, organization_id uuid, role text NOT NULL,
        is_active boolean NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE api_keys (
        id uuid PRIMARY KEY, organization_id uuid NOT NULL, user_id uuid NOT NULL,
        is_active boolean NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE apps (
        id uuid PRIMARY KEY, name text NOT NULL, description text,
        slug text NOT NULL UNIQUE, organization_id uuid NOT NULL,
        created_by_user_id uuid NOT NULL, app_url text NOT NULL,
        allowed_origins jsonb NOT NULL, api_key_id uuid,
        is_active boolean NOT NULL, is_approved boolean NOT NULL,
        updated_at timestamptz
      );
    `);
  });

  beforeEach(async () => {
    await database.exec("TRUNCATE apps, api_keys, users, organizations");
    await database.query(
      "INSERT INTO organizations (id, is_active) VALUES ($1::uuid, TRUE)",
      [ORGANIZATION_ID],
    );
    await database.query(
      "INSERT INTO users (id, organization_id, role, is_active) VALUES ($1::uuid, $2::uuid, 'owner', TRUE)",
      [OWNER_ID, ORGANIZATION_ID],
    );
  });

  afterAll(async () => {
    await database.close();
  });

  test("creates a verifiable Alpha row beside the primary client and is idempotent", async () => {
    await repairRegistrationTransaction(
      client,
      PRIMARY_APP_ID,
      ORGANIZATION_ID,
      OWNER_ID,
    );
    await repairRegistrationTransaction(
      client,
      ALPHA_APP_ID,
      ORGANIZATION_ID,
      OWNER_ID,
      PRODUCTION,
    );
    await repairRegistrationTransaction(
      client,
      ALPHA_APP_ID,
      ORGANIZATION_ID,
      OWNER_ID,
      PRODUCTION,
    );

    const alpha = await read(ALPHA_APP_ID);
    expect(() =>
      validateMobileAppAuthRegistrationRow(alpha, ALPHA_APP_ID, PRODUCTION),
    ).not.toThrow();
    const primary = await read(PRIMARY_APP_ID, PRIMARY_MOBILE_APP_AUTH_TARGET);
    expect(() =>
      validateMobileAppAuthRegistrationRow(primary, PRIMARY_APP_ID),
    ).not.toThrow();

    const rows = await database.query<{
      name: string;
      app_url: string;
      allowed_origins: unknown;
    }>("SELECT name, app_url, allowed_origins FROM apps WHERE id = $1::uuid", [
      ALPHA_APP_ID,
    ]);
    expect(rows.rows).toEqual([
      {
        name: "Alpha Phone",
        app_url: "https://eliza.app",
        allowed_origins: ["https://eliza.app/alphaphone/auth/callback"],
      },
    ]);
    // The Alpha row cannot satisfy the primary client's callback contract.
    expect(() =>
      validateMobileAppAuthRegistrationRow(alpha, ALPHA_APP_ID),
    ).toThrow();
  });

  test("staging repair binds the staging callback", async () => {
    await repairRegistrationTransaction(
      client,
      ALPHA_APP_ID,
      ORGANIZATION_ID,
      OWNER_ID,
      STAGING,
    );
    const row = await read(ALPHA_APP_ID, STAGING);
    expect(() =>
      validateMobileAppAuthRegistrationRow(row, ALPHA_APP_ID, STAGING),
    ).not.toThrow();
    expect(row?.allowed_origins).toEqual([STAGING.redirectUri]);
  });

  test("repairs Senior Care beside Alpha Phone, bound only to its own callback", async () => {
    await repairRegistrationTransaction(
      client,
      ALPHA_APP_ID,
      ORGANIZATION_ID,
      OWNER_ID,
      PRODUCTION,
    );
    for (const target of [SENIOR_STAGING, SENIOR_PRODUCTION]) {
      await repairRegistrationTransaction(
        client,
        SENIOR_APP_ID,
        ORGANIZATION_ID,
        OWNER_ID,
        target,
      );
      const row = await read(SENIOR_APP_ID, target);
      expect(() =>
        validateMobileAppAuthRegistrationRow(row, SENIOR_APP_ID, target),
      ).not.toThrow();
      expect(row?.app_url).toBe(target.redirectOrigin);
      expect(row?.allowed_origins).toEqual([target.redirectUri]);
    }
    const senior = await read(SENIOR_APP_ID, SENIOR_PRODUCTION);
    expect(() =>
      validateMobileAppAuthRegistrationRow(senior, SENIOR_APP_ID, PRODUCTION),
    ).toThrow();
    const alpha = await read(ALPHA_APP_ID);
    expect(() =>
      validateMobileAppAuthRegistrationRow(alpha, ALPHA_APP_ID, PRODUCTION),
    ).not.toThrow();
  });

  test("repairs Grace beside the retained Senior Care client on the same origin", async () => {
    for (const [appId, target] of [
      [SENIOR_APP_ID, SENIOR_PRODUCTION],
      [GRACE_APP_ID, GRACE_PRODUCTION],
    ] as const) {
      await repairRegistrationTransaction(
        client,
        appId,
        ORGANIZATION_ID,
        OWNER_ID,
        target,
      );
    }
    const grace = await read(GRACE_APP_ID, GRACE_PRODUCTION);
    expect(() =>
      validateMobileAppAuthRegistrationRow(
        grace,
        GRACE_APP_ID,
        GRACE_PRODUCTION,
      ),
    ).not.toThrow();
    expect(grace?.allowed_origins).toEqual([GRACE_PRODUCTION.redirectUri]);
    const senior = await read(SENIOR_APP_ID, SENIOR_PRODUCTION);
    expect(() =>
      validateMobileAppAuthRegistrationRow(
        senior,
        SENIOR_APP_ID,
        SENIOR_PRODUCTION,
      ),
    ).not.toThrow();
    expect(() =>
      validateMobileAppAuthRegistrationRow(
        senior,
        SENIOR_APP_ID,
        GRACE_PRODUCTION,
      ),
    ).toThrow();
  });

  test("refuses to give the Alpha callback to a second active app", async () => {
    await repairRegistrationTransaction(
      client,
      ALPHA_APP_ID,
      ORGANIZATION_ID,
      OWNER_ID,
      PRODUCTION,
    );
    await expect(
      repairRegistrationTransaction(
        client,
        PRIMARY_APP_ID,
        ORGANIZATION_ID,
        OWNER_ID,
        PRODUCTION,
      ),
    ).rejects.toThrow("registration.unique_callback_owner");
  });
});
