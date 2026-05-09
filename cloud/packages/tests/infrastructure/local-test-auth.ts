import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { Client } from "pg";
import {
  createPlaywrightTestSessionToken,
  PLAYWRIGHT_TEST_SESSION_COOKIE_NAME,
} from "../../lib/auth/playwright-test-session";

const TEST_ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const TEST_ORGANIZATION_NAME = "Local Live Test Organization";
const TEST_ORGANIZATION_SLUG = "local-live-test-organization";
const TEST_ORGANIZATION_CREDIT_BALANCE = "100.000000";

const TEST_USER_ID = "22222222-2222-4222-8222-222222222222";
const TEST_USER_EMAIL = "local-live-test-user@agent.local";
const TEST_USER_NAME = "Local Live Test User";
const TEST_USER_WALLET = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const TEST_USER_STEWARD_ID = "steward:local-live-test-user";

const TEST_API_KEY_ID = "33333333-3333-4333-8333-333333333333";
const TEST_API_KEY_NAME = "Local Live Test API Key";
const TEST_API_KEY_VALUE = "eliza_test_local_live_infra_key";

const TEST_ADMIN_ID = "44444444-4444-4444-8444-444444444444";
const TEST_MEMBER_USER_ID = "55555555-5555-4555-8555-555555555555";
const TEST_MEMBER_USER_EMAIL = "local-live-test-member@agent.local";
const TEST_MEMBER_USER_NAME = "Local Live Test Member";
const TEST_MEMBER_USER_WALLET = "0xdddddddddddddddddddddddddddddddddddddddd";
const TEST_MEMBER_USER_STEWARD_ID = "steward:local-live-test-member";
const TEST_MEMBER_API_KEY_ID = "66666666-6666-4666-8666-666666666666";
const TEST_MEMBER_API_KEY_NAME = "Local Live Test Member API Key";
const TEST_MEMBER_API_KEY_VALUE = "eliza_test_local_live_member_key";
const TEST_AFFILIATE_API_KEY_ID = "77777777-7777-4777-8777-777777777777";
const TEST_AFFILIATE_API_KEY_NAME = "Local Live Test Affiliate API Key";
const TEST_AFFILIATE_API_KEY_VALUE = "eliza_test_local_live_affiliate_key";
const TEST_AFFILIATE_PERMISSIONS = ["affiliate:create-character"];
const TEST_AUTH_SECRET = "playwright-local-auth-secret";
const SCHEMA_COMPATIBILITY_COLUMNS = [
  { table: "users", column: "steward_user_id", definition: "steward_user_id text" },
  {
    table: "user_identities",
    column: "steward_user_id",
    definition: "steward_user_id text",
  },
  {
    table: "organizations",
    column: "steward_tenant_id",
    definition: "steward_tenant_id text",
  },
  {
    table: "organizations",
    column: "steward_tenant_api_key",
    definition: "steward_tenant_api_key text",
  },
  {
    table: "organizations",
    column: "pay_as_you_go_from_earnings",
    definition: "pay_as_you_go_from_earnings boolean NOT NULL DEFAULT true",
  },
  {
    table: "generations",
    column: "is_public",
    definition: "is_public boolean NOT NULL DEFAULT false",
  },
] as const;

let bootstrapPromise: Promise<LocalTestAuthContext> | null = null;

export type LocalTestAuthContext = {
  organizationId: string;
  userId: string;
  apiKey: string;
  memberApiKey: string;
  affiliateApiKey: string;
  sessionCookieName: string;
  sessionToken: string;
};

interface LocalAuthClient {
  query<T = unknown>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  end(): Promise<void>;
}

function getDatabaseUrl(): string {
  const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for live auth bootstrap");
  }
  return connectionString;
}

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function getApiKeyPrefix(key: string): string {
  return key.slice(0, 12);
}

function parsePGliteDataDir(url: string): string | undefined {
  const stripped = url.slice("pglite://".length);
  return !stripped || stripped === "memory" ? undefined : stripped;
}

async function createLocalAuthClient(connectionString: string): Promise<LocalAuthClient> {
  if (connectionString.startsWith("pglite://")) {
    const dataDir = parsePGliteDataDir(connectionString);
    if (dataDir) {
      mkdirSync(dataDir, { recursive: true });
    }

    const { PGlite } = await import("@electric-sql/pglite");
    const { vector } = await import("@electric-sql/pglite/vector");
    const db = await PGlite.create({ dataDir, extensions: { vector } });

    return {
      query: async <T>(text: string, params?: unknown[]) => {
        const result = await db.query<T>(text, params ?? []);
        return { rows: result.rows, rowCount: result.rows.length };
      },
      end: () => db.close(),
    };
  }

  const client = new Client({ connectionString });
  await client.connect();
  return client;
}

async function columnExists(
  client: LocalAuthClient,
  table: string,
  column: string,
): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1`,
    [table, column],
  );

  return Boolean(result.rowCount && result.rowCount > 0);
}

async function ensureSchemaCompatibility(client: LocalAuthClient): Promise<void> {
  for (const { table, column, definition } of SCHEMA_COMPATIBILITY_COLUMNS) {
    if (await columnExists(client, table, column)) {
      continue;
    }
    await client.query(`ALTER TABLE ${table} ADD COLUMN ${definition};`);
  }
}

async function upsertOrganization(client: LocalAuthClient): Promise<string> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO organizations (id, name, slug, credit_balance, is_active, settings)
     VALUES ($1, $2, $3, $4, true, '{}'::jsonb)
     ON CONFLICT (slug) DO UPDATE
       SET name = EXCLUDED.name,
           credit_balance = GREATEST(organizations.credit_balance, EXCLUDED.credit_balance),
           is_active = true,
           updated_at = NOW()
     RETURNING id`,
    [
      TEST_ORGANIZATION_ID,
      TEST_ORGANIZATION_NAME,
      TEST_ORGANIZATION_SLUG,
      TEST_ORGANIZATION_CREDIT_BALANCE,
    ],
  );

  return result.rows[0]!.id;
}

async function upsertUser(client: LocalAuthClient, organizationId: string): Promise<string> {
  const existingUsers = await client.query<{ id: string }>(
    `SELECT id
       FROM users
      WHERE email = $1 OR wallet_address = $2
      ORDER BY CASE WHEN email = $1 THEN 0 ELSE 1 END
      LIMIT 2`,
    [TEST_USER_EMAIL, TEST_USER_WALLET],
  );

  if (existingUsers.rowCount && existingUsers.rowCount > 1) {
    throw new Error(
      `Found multiple local live test users for ${TEST_USER_EMAIL}/${TEST_USER_WALLET}; clean the local test database before rerunning live tests.`,
    );
  }

  if (existingUsers.rowCount === 1) {
    const result = await client.query<{ id: string }>(
      `UPDATE users
          SET email = $2,
              name = $3,
              organization_id = $4,
              role = 'owner',
              is_anonymous = false,
              is_active = true,
          email_verified = true,
              steward_user_id = $6,
              wallet_address = $5,
              wallet_chain_type = 'evm',
              wallet_verified = true,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id`,
      [
        existingUsers.rows[0]!.id,
        TEST_USER_EMAIL,
        TEST_USER_NAME,
        organizationId,
        TEST_USER_WALLET,
        TEST_USER_STEWARD_ID,
      ],
    );

    return result.rows[0]!.id;
  }

  const result = await client.query<{ id: string }>(
    `INSERT INTO users (
       id,
       email,
       name,
       organization_id,
       role,
       is_anonymous,
       is_active,
       email_verified,
       steward_user_id,
       wallet_address,
       wallet_chain_type,
       wallet_verified
     )
     VALUES ($1, $2, $3, $4, 'owner', false, true, true, $5, $6, 'evm', true)
     RETURNING id`,
    [
      TEST_USER_ID,
      TEST_USER_EMAIL,
      TEST_USER_NAME,
      organizationId,
      TEST_USER_STEWARD_ID,
      TEST_USER_WALLET,
    ],
  );

  return result.rows[0]!.id;
}

async function upsertAdmin(client: LocalAuthClient, userId: string): Promise<void> {
  await client.query(
    `INSERT INTO admin_users (id, user_id, wallet_address, role, is_active, notes)
     VALUES ($1, $2, $3, 'super_admin', true, $4)
     ON CONFLICT (wallet_address) DO UPDATE
       SET user_id = EXCLUDED.user_id,
           role = 'super_admin',
           is_active = true,
           revoked_at = NULL,
           updated_at = NOW(),
           notes = EXCLUDED.notes`,
    [TEST_ADMIN_ID, userId, TEST_USER_WALLET, "Local live test admin account"],
  );
}

async function upsertMemberUser(client: LocalAuthClient, organizationId: string): Promise<string> {
  const existingUsers = await client.query<{ id: string }>(
    `SELECT id
       FROM users
      WHERE email = $1 OR wallet_address = $2
      ORDER BY CASE WHEN email = $1 THEN 0 ELSE 1 END
      LIMIT 2`,
    [TEST_MEMBER_USER_EMAIL, TEST_MEMBER_USER_WALLET],
  );

  if (existingUsers.rowCount && existingUsers.rowCount > 1) {
    throw new Error(
      `Found multiple local live test users for ${TEST_MEMBER_USER_EMAIL}/${TEST_MEMBER_USER_WALLET}; clean the local test database before rerunning live tests.`,
    );
  }

  if (existingUsers.rowCount === 1) {
    const result = await client.query<{ id: string }>(
      `UPDATE users
          SET email = $2,
              name = $3,
              organization_id = $4,
              role = 'member',
              is_anonymous = false,
              is_active = true,
              email_verified = true,
              steward_user_id = $6,
              wallet_address = $5,
              wallet_chain_type = 'evm',
              wallet_verified = true,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id`,
      [
        existingUsers.rows[0]!.id,
        TEST_MEMBER_USER_EMAIL,
        TEST_MEMBER_USER_NAME,
        organizationId,
        TEST_MEMBER_USER_WALLET,
        TEST_MEMBER_USER_STEWARD_ID,
      ],
    );

    return result.rows[0]!.id;
  }

  const result = await client.query<{ id: string }>(
    `INSERT INTO users (
       id,
       email,
       name,
       organization_id,
       role,
       is_anonymous,
       is_active,
       email_verified,
       steward_user_id,
       wallet_address,
       wallet_chain_type,
       wallet_verified
     )
     VALUES ($1, $2, $3, $4, 'member', false, true, true, $5, $6, 'evm', true)
     RETURNING id`,
    [
      TEST_MEMBER_USER_ID,
      TEST_MEMBER_USER_EMAIL,
      TEST_MEMBER_USER_NAME,
      organizationId,
      TEST_MEMBER_USER_STEWARD_ID,
      TEST_MEMBER_USER_WALLET,
    ],
  );

  return result.rows[0]!.id;
}

async function resetAdminForTestUser(client: LocalAuthClient, userId: string): Promise<void> {
  if (process.env.AGENT_TEST_BOOTSTRAP_ADMIN === "true") {
    await upsertAdmin(client, userId);
    return;
  }

  await client.query(
    `DELETE FROM admin_users
      WHERE id = $1
         OR user_id = $2
         OR wallet_address = $3`,
    [TEST_ADMIN_ID, userId, TEST_USER_WALLET],
  );
}

async function upsertApiKey(
  client: LocalAuthClient,
  organizationId: string,
  userId: string,
  key: {
    id: string;
    name: string;
    value: string;
    description: string;
    permissions?: string[];
  } = {
    id: TEST_API_KEY_ID,
    name: TEST_API_KEY_NAME,
    value: TEST_API_KEY_VALUE,
    description: "Stable API key for local live infra tests",
  },
): Promise<string> {
  const keyHash = hashApiKey(key.value);
  const keyPrefix = getApiKeyPrefix(key.value);
  const permissions = JSON.stringify(key.permissions ?? []);

  await client.query(
    `INSERT INTO api_keys (
       id,
       name,
       description,
       key,
       key_hash,
       key_prefix,
       organization_id,
       user_id,
       permissions,
       rate_limit,
       is_active
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 1000, true)
     ON CONFLICT (key) DO UPDATE
       SET name = EXCLUDED.name,
           description = EXCLUDED.description,
           key_hash = EXCLUDED.key_hash,
           key_prefix = EXCLUDED.key_prefix,
           organization_id = EXCLUDED.organization_id,
           user_id = EXCLUDED.user_id,
           permissions = EXCLUDED.permissions,
           rate_limit = EXCLUDED.rate_limit,
           is_active = true,
           expires_at = NULL,
           updated_at = NOW()`,
    [
      key.id,
      key.name,
      key.description,
      key.value,
      keyHash,
      keyPrefix,
      organizationId,
      userId,
      permissions,
    ],
  );

  return key.value;
}

async function bootstrapLocalTestAuth(): Promise<LocalTestAuthContext> {
  process.env.PLAYWRIGHT_TEST_AUTH = process.env.PLAYWRIGHT_TEST_AUTH ?? "true";
  process.env.PLAYWRIGHT_TEST_AUTH_SECRET =
    process.env.PLAYWRIGHT_TEST_AUTH_SECRET ?? TEST_AUTH_SECRET;

  const client = await createLocalAuthClient(getDatabaseUrl());

  let inTransaction = false;
  try {
    await ensureSchemaCompatibility(client);

    await client.query("BEGIN");
    inTransaction = true;

    const organizationId = await upsertOrganization(client);
    const userId = await upsertUser(client, organizationId);
    const memberUserId = await upsertMemberUser(client, organizationId);
    await resetAdminForTestUser(client, userId);
    const apiKey = await upsertApiKey(client, organizationId, userId);
    const memberApiKey = await upsertApiKey(client, organizationId, memberUserId, {
      id: TEST_MEMBER_API_KEY_ID,
      name: TEST_MEMBER_API_KEY_NAME,
      value: TEST_MEMBER_API_KEY_VALUE,
      description: "Stable member API key for local live infra tests",
    });
    const affiliateApiKey = await upsertApiKey(client, organizationId, userId, {
      id: TEST_AFFILIATE_API_KEY_ID,
      name: TEST_AFFILIATE_API_KEY_NAME,
      value: TEST_AFFILIATE_API_KEY_VALUE,
      description: "Stable affiliate API key for local live infra tests",
      permissions: TEST_AFFILIATE_PERMISSIONS,
    });

    await client.query("COMMIT");
    inTransaction = false;

    const sessionToken = createPlaywrightTestSessionToken(userId, organizationId);

    process.env.TEST_API_KEY = apiKey;
    process.env.TEST_MEMBER_API_KEY = memberApiKey;
    process.env.TEST_AFFILIATE_API_KEY = affiliateApiKey;
    process.env.TEST_USER_ID = userId;
    process.env.TEST_USER_EMAIL = TEST_USER_EMAIL;
    process.env.TEST_ORGANIZATION_ID = organizationId;
    process.env.TEST_SESSION_COOKIE_NAME = PLAYWRIGHT_TEST_SESSION_COOKIE_NAME;
    process.env.TEST_SESSION_TOKEN = sessionToken;

    return {
      organizationId,
      userId,
      apiKey,
      memberApiKey,
      affiliateApiKey,
      sessionCookieName: PLAYWRIGHT_TEST_SESSION_COOKIE_NAME,
      sessionToken,
    };
  } catch (error) {
    if (inTransaction) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    await client.end();
  }
}

export function ensureLocalTestAuth(): Promise<LocalTestAuthContext> {
  bootstrapPromise ??= bootstrapLocalTestAuth();
  return bootstrapPromise;
}
