/** Registry selection and real registration repair against in-process PostgreSQL. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { readFileSync } from "node:fs";
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
      CREATE TABLE native_app_publishers(organization_id uuid PRIMARY KEY);
      CREATE TABLE organizations (id uuid PRIMARY KEY, is_active boolean NOT NULL);
      CREATE TABLE users (
        id uuid PRIMARY KEY, organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE, role text NOT NULL,
        is_active boolean NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE api_keys (
        id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_app_id uuid, is_active boolean NOT NULL, deleted_at timestamptz
      );
      CREATE TABLE apps (
        id uuid PRIMARY KEY, name text NOT NULL, description text,
        slug text NOT NULL UNIQUE, organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        created_by_user_id uuid NOT NULL CONSTRAINT apps_created_by_user_id_users_id_fk REFERENCES users(id) ON DELETE CASCADE,
        app_url text NOT NULL,
        allowed_origins jsonb NOT NULL, api_key_id uuid,
        is_active boolean NOT NULL, is_approved boolean NOT NULL,
        updated_at timestamptz
      );
      CREATE TABLE app_users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        app_id uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE(app_id, user_id)
      );
    `);
    for (const file of [
      "0381_app_billing_registration.sql",
      "0550_app_creator_audit_reference.sql",
      "0277_mobile_app_auth_pkce_grants.sql",
    ]) {
      const migration = readFileSync(
        new URL(
          `../../../cloud/shared/src/db/migrations/${file}`,
          import.meta.url,
        ),
        "utf8",
      );
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await database.exec(statement);
      }
    }
  });

  beforeEach(async () => {
    await database.exec(
      "TRUNCATE app_subscriber_accounts, app_billing_registrations, app_users, mobile_app_auth_grants, apps, api_keys, users, organizations",
    );
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

  test("creator erasure preserves the organization app and other customers' independent grants", async () => {
    const customerOrg = "10000000-0000-4000-8000-000000000001";
    const customerOrg2 = "10000000-0000-4000-8000-000000000002";
    const customer = "20000000-0000-4000-8000-000000000001";
    const customer2 = "20000000-0000-4000-8000-000000000002";
    const key = "30000000-0000-4000-8000-000000000001";
    const key2 = "30000000-0000-4000-8000-000000000002";
    await repairRegistrationTransaction(
      client,
      FIRST_APP_ID,
      ORGANIZATION_ID,
      OWNER_ID,
      PRODUCTION,
    );
    for (const [org, user, credential, char] of [
      [customerOrg, customer, key, "a"],
      [customerOrg2, customer2, key2, "b"],
    ]) {
      await database.query("INSERT INTO organizations VALUES ($1, TRUE)", [
        org,
      ]);
      await database.query(
        "INSERT INTO users VALUES ($1, $2, 'owner', TRUE, NULL)",
        [user, org],
      );
      await database.query(
        "INSERT INTO api_keys VALUES ($1, $2, $3, $4, TRUE, NULL)",
        [credential, org, user, FIRST_APP_ID],
      );
      await database.query(
        `INSERT INTO mobile_app_auth_grants
        (code_hash, app_id, client_id, user_id, organization_id, environment, redirect_uri,
         state_hash, code_challenge, code_challenge_method, scopes, status, credential_id, expires_at)
        VALUES ($1, $2, $3, $4, $5, 'production', $6, $1, $7, 'S256', '["cloud:user"]', 'acknowledged', $8, now() + interval '30 days')`,
        [
          char.repeat(64),
          FIRST_APP_ID,
          PRODUCTION.clientId,
          user,
          org,
          PRODUCTION.redirectUri,
          char.repeat(43),
          credential,
        ],
      );
    }
    const registration = (
      await database.query<{ id: string }>(
        `INSERT INTO app_billing_registrations
      (app_id, owner_organization_id, infrastructure_payer_organization_id, registered_by_user_id, provider_environment)
      VALUES ($1, $2, $2, $3, 'test') RETURNING id`,
        [FIRST_APP_ID, ORGANIZATION_ID, OWNER_ID],
      )
    ).rows[0].id;
    for (const user of [customer, customer2]) {
      await database.query(
        "INSERT INTO app_users(app_id,user_id) VALUES ($1,$2)",
        [FIRST_APP_ID, user],
      );
      await database.query(
        "INSERT INTO app_subscriber_accounts(registration_id,app_id,subscriber_user_id) VALUES ($1,$2,$3)",
        [registration, FIRST_APP_ID, user],
      );
    }
    await database.query("UPDATE users SET is_active=FALSE WHERE id=$1", [
      OWNER_ID,
    ]);
    validateMobileAppAuthRegistrationRow(
      await read(FIRST_APP_ID),
      FIRST_APP_ID,
      PRODUCTION,
    );
    await database.query("DELETE FROM users WHERE id=$1", [OWNER_ID]);
    expect(
      (
        await database.query(
          "SELECT created_by_user_id FROM apps WHERE id=$1",
          [FIRST_APP_ID],
        )
      ).rows,
    ).toEqual([{ created_by_user_id: null }]);
    expect(
      (
        await database.query(
          "SELECT registered_by_user_id FROM app_billing_registrations WHERE id=$1",
          [registration],
        )
      ).rows,
    ).toEqual([{ registered_by_user_id: null }]);
    expect(
      (await database.query("SELECT id FROM app_subscriber_accounts")).rows,
    ).toHaveLength(2);
    await expect(
      database.query(
        "UPDATE app_billing_registrations SET owner_organization_id=$1 WHERE id=$2",
        [customerOrg, registration],
      ),
    ).rejects.toThrow();
    await repairRegistrationTransaction(
      client,
      FIRST_APP_ID,
      ORGANIZATION_ID,
      undefined,
      PRODUCTION,
    );
    validateMobileAppAuthRegistrationRow(
      await read(FIRST_APP_ID),
      FIRST_APP_ID,
      PRODUCTION,
    );
    const grants = () =>
      database.query<{
        user_id: string;
        organization_id: string;
        credential_id: string;
      }>(
        "SELECT user_id, organization_id, credential_id FROM mobile_app_auth_grants ORDER BY user_id",
      );
    expect((await grants()).rows).toEqual([
      { user_id: customer, organization_id: customerOrg, credential_id: key },
      {
        user_id: customer2,
        organization_id: customerOrg2,
        credential_id: key2,
      },
    ]);
    await database.query("DELETE FROM users WHERE id=$1", [customer]);
    expect((await grants()).rows).toEqual([
      {
        user_id: customer2,
        organization_id: customerOrg2,
        credential_id: key2,
      },
    ]);
    expect(
      (
        await database.query(
          "SELECT subscriber_user_id FROM app_subscriber_accounts",
        )
      ).rows,
    ).toEqual([{ subscriber_user_id: customer2 }]);
    await database.query("DELETE FROM organizations WHERE id=$1", [
      ORGANIZATION_ID,
    ]);
    expect(
      (await database.query("SELECT id FROM apps WHERE id=$1", [FIRST_APP_ID]))
        .rows,
    ).toEqual([]);
    expect((await grants()).rows).toEqual([]);
    expect(
      (await database.query("SELECT id FROM app_billing_registrations")).rows,
    ).toEqual([]);
    expect(
      (await database.query("SELECT id FROM app_subscriber_accounts")).rows,
    ).toEqual([]);
    expect(
      (
        await database.query("SELECT source_app_id FROM api_keys WHERE id=$1", [
          key2,
        ])
      ).rows,
    ).toEqual([{ source_app_id: FIRST_APP_ID }]);
  });
});
