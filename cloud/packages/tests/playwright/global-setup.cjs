const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { config } = require("dotenv");
const { Client } = require("pg");

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
const TEST_AUTH_SECRET = "playwright-local-auth-secret";
const PLAYWRIGHT_TEST_SESSION_COOKIE_NAME = "eliza-test-session";
const PLAYWRIGHT_TEST_SESSION_TTL_SECONDS = 60 * 60;
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
];

const LOCAL_DOCKER_DB_USER = "eliza_dev";
const LOCAL_DOCKER_DB_PASSWORD = "local_dev_password";
const LOCAL_DOCKER_DB_NAME = "eliza_dev";
const DEFAULT_LOCAL_DOCKER_DB_HOST = "localhost";
const DEFAULT_LOCAL_DOCKER_DB_PORT = "5432";

const testsRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(testsRoot, "..");

let cachedExternalIpv4;

function getFirstExternalIpv4Address() {
  if (cachedExternalIpv4 !== undefined) {
    return cachedExternalIpv4;
  }

  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === "IPv4" && !address.internal) {
        cachedExternalIpv4 = address.address;
        return cachedExternalIpv4;
      }
    }
  }

  cachedExternalIpv4 = null;
  return cachedExternalIpv4;
}

function getLocalDockerDatabaseUrl(env = process.env) {
  const host =
    env.LOCAL_DOCKER_DB_HOST || getFirstExternalIpv4Address() || DEFAULT_LOCAL_DOCKER_DB_HOST;
  const port = env.LOCAL_DOCKER_DB_PORT || DEFAULT_LOCAL_DOCKER_DB_PORT;

  return `postgresql://${LOCAL_DOCKER_DB_USER}:${LOCAL_DOCKER_DB_PASSWORD}@${host}:${port}/${LOCAL_DOCKER_DB_NAME}`;
}

function applyDatabaseUrlFallback(env = process.env) {
  const explicitUrl = env.TEST_DATABASE_URL || env.DATABASE_URL;
  if (explicitUrl) {
    env.DATABASE_URL = env.DATABASE_URL || explicitUrl;
    env.TEST_DATABASE_URL = env.TEST_DATABASE_URL || explicitUrl;
    return explicitUrl;
  }

  if (
    env.DISABLE_LOCAL_DOCKER_DB_FALLBACK === "1" ||
    env.VERCEL === "1" ||
    env.NODE_ENV === "production" ||
    env.CI === "true"
  ) {
    return null;
  }

  const fallbackUrl = getLocalDockerDatabaseUrl(env);
  env.DATABASE_URL = env.DATABASE_URL || fallbackUrl;
  env.TEST_DATABASE_URL = env.TEST_DATABASE_URL || fallbackUrl;
  return fallbackUrl;
}

function loadPlaywrightEnv() {
  for (const envPath of [
    path.resolve(workspaceRoot, ".env"),
    path.resolve(workspaceRoot, ".env.local"),
    path.resolve(workspaceRoot, ".env.test"),
    path.resolve(testsRoot, ".env"),
    path.resolve(testsRoot, ".env.local"),
    path.resolve(testsRoot, ".env.test"),
  ]) {
    config({ path: envPath });
  }

  process.env.NODE_ENV = "test";
  process.env.ELIZAOS_CLOUD_BASE_URL = "http://localhost:3000/api/v1";
  process.env.TEST_BLOCK_ANONYMOUS = "true";

  if (process.env.SKIP_DB_DEPENDENT === "1") {
    delete process.env.DATABASE_URL;
    delete process.env.TEST_DATABASE_URL;
    return;
  }

  const shouldPreferLocalDockerDb =
    process.env.CI !== "true" && process.env.DISABLE_LOCAL_DOCKER_DB_FALLBACK !== "1";
  const localDockerDatabaseUrl = getLocalDockerDatabaseUrl({
    ...process.env,
    LOCAL_DOCKER_DB_HOST: process.env.LOCAL_DOCKER_DB_HOST || "localhost",
  });
  const testDatabaseUrl =
    process.env.TEST_DATABASE_URL ||
    (shouldPreferLocalDockerDb ? localDockerDatabaseUrl : process.env.DATABASE_URL);

  if (testDatabaseUrl) {
    process.env.TEST_DATABASE_URL = testDatabaseUrl;
    process.env.DATABASE_URL = testDatabaseUrl;
    return;
  }

  applyDatabaseUrlFallback(process.env);
}

function getDatabaseUrl() {
  const connectionString = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("TEST_DATABASE_URL or DATABASE_URL is required for live auth bootstrap");
  }
  return connectionString;
}

function hashApiKey(key) {
  return crypto.createHash("sha256").update(key).digest("hex");
}

function getApiKeyPrefix(key) {
  return key.slice(0, 12);
}

function createPlaywrightTestSessionToken(userId, organizationId, env = process.env) {
  const secret = env.PLAYWRIGHT_TEST_AUTH_SECRET?.trim();
  if (env.PLAYWRIGHT_TEST_AUTH !== "true" || !secret || secret.length < 16) {
    throw new Error("Playwright test auth is not enabled");
  }

  const claims = {
    userId,
    organizationId,
    exp: Math.floor(Date.now() / 1000) + PLAYWRIGHT_TEST_SESSION_TTL_SECONDS,
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

async function columnExists(client, table, column) {
  const result = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = $2
      LIMIT 1`,
    [table, column],
  );

  return result.rowCount > 0;
}

async function ensureSchemaCompatibility(client) {
  for (const { table, column, definition } of SCHEMA_COMPATIBILITY_COLUMNS) {
    if (await columnExists(client, table, column)) {
      continue;
    }
    await client.query(`ALTER TABLE ${table} ADD COLUMN ${definition};`);
  }
}

async function upsertOrganization(client) {
  const result = await client.query(
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

  return result.rows[0].id;
}

async function upsertUser(client, organizationId) {
  const existingUsers = await client.query(
    `SELECT id
       FROM users
      WHERE email = $1 OR wallet_address = $2
      ORDER BY CASE WHEN email = $1 THEN 0 ELSE 1 END
      LIMIT 2`,
    [TEST_USER_EMAIL, TEST_USER_WALLET],
  );

  if (existingUsers.rowCount > 1) {
    throw new Error(
      `Found multiple local live test users for ${TEST_USER_EMAIL}/${TEST_USER_WALLET}; clean the local test database before rerunning live tests.`,
    );
  }

  if (existingUsers.rowCount === 1) {
    const result = await client.query(
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
        existingUsers.rows[0].id,
        TEST_USER_EMAIL,
        TEST_USER_NAME,
        organizationId,
        TEST_USER_WALLET,
        TEST_USER_STEWARD_ID,
      ],
    );

    return result.rows[0].id;
  }

  const result = await client.query(
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

  return result.rows[0].id;
}

async function upsertAdmin(client, userId) {
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

async function upsertApiKey(client, organizationId, userId) {
  const keyHash = hashApiKey(TEST_API_KEY_VALUE);
  const keyPrefix = getApiKeyPrefix(TEST_API_KEY_VALUE);

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
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '[]'::jsonb, 1000, true)
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
      TEST_API_KEY_ID,
      TEST_API_KEY_NAME,
      "Stable API key for local live infra tests",
      TEST_API_KEY_VALUE,
      keyHash,
      keyPrefix,
      organizationId,
      userId,
    ],
  );

  return TEST_API_KEY_VALUE;
}

async function bootstrapLocalTestAuth() {
  process.env.PLAYWRIGHT_TEST_AUTH = process.env.PLAYWRIGHT_TEST_AUTH || "true";
  process.env.PLAYWRIGHT_TEST_AUTH_SECRET =
    process.env.PLAYWRIGHT_TEST_AUTH_SECRET || TEST_AUTH_SECRET;

  const client = new Client({ connectionString: getDatabaseUrl() });
  await client.connect();

  let inTransaction = false;
  try {
    await ensureSchemaCompatibility(client);

    await client.query("BEGIN");
    inTransaction = true;

    const organizationId = await upsertOrganization(client);
    const userId = await upsertUser(client, organizationId);
    await upsertAdmin(client, userId);
    const apiKey = await upsertApiKey(client, organizationId, userId);

    await client.query("COMMIT");
    inTransaction = false;

    const sessionToken = createPlaywrightTestSessionToken(userId, organizationId);

    process.env.TEST_API_KEY = apiKey;
    process.env.TEST_USER_ID = userId;
    process.env.TEST_USER_EMAIL = TEST_USER_EMAIL;
    process.env.TEST_ORGANIZATION_ID = organizationId;
    process.env.TEST_SESSION_COOKIE_NAME = PLAYWRIGHT_TEST_SESSION_COOKIE_NAME;
    process.env.TEST_SESSION_TOKEN = sessionToken;
  } catch (error) {
    if (inTransaction) {
      await client.query("ROLLBACK");
    }
    throw error;
  } finally {
    await client.end();
  }
}

module.exports = async function globalSetup() {
  loadPlaywrightEnv();
  await bootstrapLocalTestAuth();
};

module.exports.loadPlaywrightEnv = loadPlaywrightEnv;
