/** Registry selection and real registration repair against in-process PostgreSQL. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { selectRegisteredMobileClient } from "../../../cloud/shared/src/lib/services/mobile-client-registry.ts";
import {
  repairRegistrationTransaction,
  resolveTargetRegistration,
} from "./repair-mobile-app-auth-registration";
import {
  type MobileAppAuthRegistrationRow,
  mobileAppAuthConfigUrl,
  PRIMARY_MOBILE_APP_AUTH_TARGET,
  queryMobileAppAuthRegistration,
  resolveMobileAppAuthRegistrationTarget,
  validateMobileAppAuthRegistrationRow,
} from "./verify-mobile-app-auth-registration";

const FIRST_APP_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRIMARY_APP_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORGANIZATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const SECOND_APP_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const THIRD_APP_ID = "eeeeeeee-ffff-4fff-8fff-ffffffffffff";
const entry = (
  clientId = "org.example.reader",
  appId = FIRST_APP_ID,
  redirectUri = "https://apps.example.org/reader/return",
) => ({ clientId, appId, redirectUri, enabled: true });
const env = (entries = [entry()]) => ({
  ELIZA_MOBILE_APP_AUTH_APP_ID: PRIMARY_APP_ID,
  ELIZA_MOBILE_APP_AUTH_ENVIRONMENT: "production",
  ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID: entries[0].clientId,
  ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: JSON.stringify(entries),
});
const target = (
  clientId: string,
  appId: string,
  path: string,
  staging = false,
) =>
  resolveTargetRegistration({
    ...env([
      entry(
        clientId,
        appId,
        `https://${staging ? "staging." : ""}apps.example.org/${path}/return`,
      ),
    ]),
    ELIZA_MOBILE_APP_AUTH_ENVIRONMENT: staging ? "staging" : "production",
  }).target;
const PRODUCTION = target("org.example.reader", FIRST_APP_ID, "reader");
const STAGING = target("org.example.reader", FIRST_APP_ID, "reader", true);
const SECOND_PRODUCTION = target(
  "com.example.calendar",
  SECOND_APP_ID,
  "calendar",
);
const SECOND_STAGING = target(
  "com.example.calendar",
  SECOND_APP_ID,
  "calendar",
  true,
);
const THIRD_PRODUCTION = target("net.example.notes", THIRD_APP_ID, "notes");

describe("dynamic mobile registration", () => {
  test("accepts an arbitrary registered app without adding an upstream product", () => {
    expect(resolveTargetRegistration(env())).toEqual({
      target: PRODUCTION,
      appId: FIRST_APP_ID,
    });
    expect(resolveMobileAppAuthRegistrationTarget(undefined, undefined)).toBe(
      PRIMARY_MOBILE_APP_AUTH_TARGET,
    );
    const url = mobileAppAuthConfigUrl("staging", STAGING);
    expect(url.origin).toBe("https://api-staging.eliza.app");
    expect(url.searchParams.get("redirectUri")).toBe(STAGING.redirectUri);
  });
  test("admin and Worker reject malformed, disabled and colliding registry entries", () => {
    const good = entry();
    const registries = [
      JSON.stringify([{ ...good, redirectUri: "https://apps.example.org/*" }]),
      "{",
      "{}",
      "[]",
      JSON.stringify([{ ...good, enabled: false }]),
      JSON.stringify([{ ...good, unexpected: true }]),
      JSON.stringify([{ ...good, credentialTtlSeconds: 1 }]),
      JSON.stringify([
        { ...good, redirectUri: "http://apps.example.org/return" },
      ]),
      JSON.stringify([{ ...good, appId: PRIMARY_APP_ID }]),
      JSON.stringify([
        good,
        {
          ...entry("com.example.other", SECOND_APP_ID),
          redirectUri: good.redirectUri,
        },
      ]),
      JSON.stringify([
        good,
        {
          ...entry(
            "com.example.other",
            FIRST_APP_ID,
            "https://apps.example.org/other",
          ),
        },
      ]),
      JSON.stringify([
        good,
        {
          ...entry(
            good.clientId,
            SECOND_APP_ID,
            "https://apps.example.org/other",
          ),
        },
      ]),
      JSON.stringify([good, { broken: true }]),
    ];
    for (const raw of registries) {
      expect(
        selectRegisteredMobileClient(raw, good.clientId, {
          clientId: PRIMARY_MOBILE_APP_AUTH_TARGET.clientId,
          appId: PRIMARY_APP_ID,
          redirectUri: PRIMARY_MOBILE_APP_AUTH_TARGET.redirectUri,
        }).ok,
      ).toBe(false);
      expect(() =>
        resolveTargetRegistration({
          ...env(),
          ELIZA_MOBILE_APP_AUTH_CLIENTS_JSON: raw,
        }),
      ).toThrow();
    }
    expect(() =>
      resolveTargetRegistration({
        ...env(),
        ELIZA_MOBILE_APP_AUTH_TARGET_CLIENT_ID: "net.example.missing",
      }),
    ).toThrow();
    expect(() =>
      resolveTargetRegistration({
        ...env(),
        ELIZA_MOBILE_APP_AUTH_ENVIRONMENT: "preview",
      }),
    ).toThrow();
  });
});

describe("first app registration repair transaction", () => {
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

  test("creates a verifiable first app row beside the primary client and is idempotent", async () => {
    await repairRegistrationTransaction(
      client,
      PRIMARY_APP_ID,
      ORGANIZATION_ID,
      OWNER_ID,
    );
    await repairRegistrationTransaction(
      client,
      FIRST_APP_ID,
      ORGANIZATION_ID,
      OWNER_ID,
      PRODUCTION,
    );
    await repairRegistrationTransaction(
      client,
      FIRST_APP_ID,
      ORGANIZATION_ID,
      OWNER_ID,
      PRODUCTION,
    );

    const first = await read(FIRST_APP_ID);
    expect(() =>
      validateMobileAppAuthRegistrationRow(first, FIRST_APP_ID, PRODUCTION),
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
      FIRST_APP_ID,
    ]);
    expect(rows.rows).toEqual([
      {
        name: PRODUCTION.appName,
        app_url: PRODUCTION.redirectOrigin,
        allowed_origins: [PRODUCTION.redirectUri],
      },
    ]);
    // The first app row cannot satisfy the primary client's callback contract.
    expect(() =>
      validateMobileAppAuthRegistrationRow(first, FIRST_APP_ID),
    ).toThrow();
  });

  test("staging repair binds the staging callback", async () => {
    await repairRegistrationTransaction(
      client,
      FIRST_APP_ID,
      ORGANIZATION_ID,
      OWNER_ID,
      STAGING,
    );
    const row = await read(FIRST_APP_ID, STAGING);
    expect(() =>
      validateMobileAppAuthRegistrationRow(row, FIRST_APP_ID, STAGING),
    ).not.toThrow();
    expect(row?.allowed_origins).toEqual([STAGING.redirectUri]);
  });

  test("repairs second app beside first app, bound only to its own callback", async () => {
    await repairRegistrationTransaction(
      client,
      FIRST_APP_ID,
      ORGANIZATION_ID,
      OWNER_ID,
      PRODUCTION,
    );
    for (const target of [SECOND_STAGING, SECOND_PRODUCTION]) {
      await repairRegistrationTransaction(
        client,
        SECOND_APP_ID,
        ORGANIZATION_ID,
        OWNER_ID,
        target,
      );
      const row = await read(SECOND_APP_ID, target);
      expect(() =>
        validateMobileAppAuthRegistrationRow(row, SECOND_APP_ID, target),
      ).not.toThrow();
      expect(row?.app_url).toBe(target.redirectOrigin);
      expect(row?.allowed_origins).toEqual([target.redirectUri]);
    }
    const second = await read(SECOND_APP_ID, SECOND_PRODUCTION);
    expect(() =>
      validateMobileAppAuthRegistrationRow(second, SECOND_APP_ID, PRODUCTION),
    ).toThrow();
    const first = await read(FIRST_APP_ID);
    expect(() =>
      validateMobileAppAuthRegistrationRow(first, FIRST_APP_ID, PRODUCTION),
    ).not.toThrow();
  });

  test("repairs third app beside the retained second app client on the same origin", async () => {
    for (const [appId, target] of [
      [SECOND_APP_ID, SECOND_PRODUCTION],
      [THIRD_APP_ID, THIRD_PRODUCTION],
    ] as const) {
      await repairRegistrationTransaction(
        client,
        appId,
        ORGANIZATION_ID,
        OWNER_ID,
        target,
      );
    }
    const third = await read(THIRD_APP_ID, THIRD_PRODUCTION);
    expect(() =>
      validateMobileAppAuthRegistrationRow(
        third,
        THIRD_APP_ID,
        THIRD_PRODUCTION,
      ),
    ).not.toThrow();
    expect(third?.allowed_origins).toEqual([THIRD_PRODUCTION.redirectUri]);
    const second = await read(SECOND_APP_ID, SECOND_PRODUCTION);
    expect(() =>
      validateMobileAppAuthRegistrationRow(
        second,
        SECOND_APP_ID,
        SECOND_PRODUCTION,
      ),
    ).not.toThrow();
    expect(() =>
      validateMobileAppAuthRegistrationRow(
        second,
        SECOND_APP_ID,
        THIRD_PRODUCTION,
      ),
    ).toThrow();
  });

  test("refuses to give the first app callback to a second active app", async () => {
    await repairRegistrationTransaction(
      client,
      FIRST_APP_ID,
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
