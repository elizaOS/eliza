/**
 * Group O — Console page-load GETs (tracker #13406).
 *
 * A signed-in user opening the /dashboard/* console pages fires these GETs on
 * load; any 500 here renders a broken console for every user. This suite
 * drives the exact page-load requests (session-cookie auth, the console's
 * credential) against the real Worker + real DB and pins every endpoint to
 * its documented 2xx — first on the minimal signed-in/empty state, then on
 * seeded "user actually has data" states for the endpoints whose handlers
 * join through the eliza runtime tables (the drifted-stub 42703 class that
 * broke claim-affiliate-characters, #13495) or serialize non-null DB fields.
 *
 * Skip behavior matches the other groups: no reachable Worker or no
 * bootstrapped TEST_API_KEY → loud, counted skips, never a silent pass.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

import {
  api,
  exchangeApiKeyForSession,
  getBaseUrl,
  isServerReachable,
} from "./_helpers/api";

const serverReachable = await isServerReachable();
const hasTestApiKey = Boolean(process.env.TEST_API_KEY?.trim());
if (!serverReachable) {
  console.warn(
    `[group-o-console-pageload] ${getBaseUrl()} did not respond to /api/health. ` +
      "Tests will SKIP. Start the Worker (bun run dev → wrangler dev) " +
      "or set TEST_API_BASE_URL to a reachable host.",
  );
}
if (!hasTestApiKey) {
  console.warn(
    "[group-o-console-pageload] TEST_API_KEY is not set; the preload could " +
      "not bootstrap a test API key. Tests will SKIP.",
  );
}

const describeE2E = describe.skipIf(!serverReachable || !hasTestApiKey);

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} must be set by the e2e preload`);
  }
  return value;
}

async function withDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "TEST_DATABASE_URL or DATABASE_URL must be set by the e2e harness",
    );
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

// Seed rows to remove in afterAll (agents cascades memories/entities/rooms;
// organizations cascades the anonymous owner user; the rest are direct).
const cleanup: Array<{ table: string; id: string }> = [];

/**
 * Seeds the "signed-in user chatted with a public agent they don't own"
 * state /my-agents/saved reads: an anonymous owner org+user, a public
 * user_characters row, the eliza runtime rows (agents/entities) and a
 * memories row with entity_id = the signed-in user — the same
 * stub-schema-sensitive join surface as #13495.
 */
async function seedSavedAgentInteraction(input: {
  userId: string;
}): Promise<{ characterId: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const anonOrgId = crypto.randomUUID();
  const anonUserId = crypto.randomUUID();
  const characterId = crypto.randomUUID();

  await withDb(async (client) => {
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`,
      [anonOrgId, `E2E Saved Org ${suffix}`, `e2e-saved-org-${suffix}`],
    );
    await client.query(
      `INSERT INTO users (id, email, steward_user_id, is_anonymous, organization_id)
       VALUES ($1, $2, $3, true, $4)`,
      [
        anonUserId,
        `e2e-saved-${suffix}@anonymous.elizacloud.ai`,
        `e2e-saved-steward-${suffix}`,
        anonOrgId,
      ],
    );
    await client.query(
      `INSERT INTO user_characters (
         id, organization_id, user_id, name, bio,
         message_examples, post_examples, topics, adjectives, knowledge,
         plugins, settings, secrets, style, character_data,
         is_template, is_public, source
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb,
         '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
         '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $6::jsonb,
         false, true, 'cloud'
       )`,
      [
        characterId,
        anonOrgId,
        anonUserId,
        `E2E Saved Agent ${suffix}`,
        JSON.stringify(["E2E saved-agent coverage"]),
        JSON.stringify({ name: `E2E Saved Agent ${suffix}` }),
      ],
    );
    await client.query(`INSERT INTO agents (id, name) VALUES ($1, $2)`, [
      characterId,
      `E2E Saved Agent ${suffix}`,
    ]);
    await client.query(
      `INSERT INTO entities (id, agent_id) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [input.userId, characterId],
    );
    await client.query(
      `INSERT INTO memories (id, type, content, entity_id, agent_id)
       VALUES ($1, 'messages', $2::jsonb, $3, $4)`,
      [
        crypto.randomUUID(),
        JSON.stringify({ text: "hello from e2e" }),
        input.userId,
        characterId,
      ],
    );
  });

  cleanup.push({ table: "agents", id: characterId });
  cleanup.push({ table: "user_characters", id: characterId });
  cleanup.push({ table: "organizations", id: anonOrgId });
  return { characterId };
}

/** Seeds a user_characters row owned by the signed-in user (my-agents list). */
async function seedOwnedCharacter(input: {
  userId: string;
  organizationId: string;
}): Promise<{ characterId: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const characterId = crypto.randomUUID();
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO user_characters (
         id, organization_id, user_id, name, bio,
         message_examples, post_examples, topics, adjectives, knowledge,
         plugins, settings, secrets, style, character_data,
         is_template, is_public, source
       ) VALUES (
         $1, $2, $3, $4, $5::jsonb,
         '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
         '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $6::jsonb,
         false, false, 'cloud'
       )`,
      [
        characterId,
        input.organizationId,
        input.userId,
        `E2E Owned Agent ${suffix}`,
        JSON.stringify(["E2E owned-agent coverage"]),
        JSON.stringify({ name: `E2E Owned Agent ${suffix}` }),
      ],
    );
  });
  cleanup.push({ table: "user_characters", id: characterId });
  return { characterId };
}

/** Seeds a connected ad account (exercises the non-null field serializer). */
async function seedAdAccount(input: {
  userId: string;
  organizationId: string;
}): Promise<{ accountId: string }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const accountId = crypto.randomUUID();
  await withDb(async (client) => {
    await client.query(
      `INSERT INTO ad_accounts (
         id, organization_id, connected_by_user_id, platform,
         external_account_id, account_name, status
       ) VALUES ($1, $2, $3, 'meta', $4, $5, 'active')`,
      [
        accountId,
        input.organizationId,
        input.userId,
        `e2e-ext-${suffix}`,
        `E2E Ad Account ${suffix}`,
      ],
    );
  });
  cleanup.push({ table: "ad_accounts", id: accountId });
  return { accountId };
}

afterAll(async () => {
  if (!serverReachable || !hasTestApiKey || cleanup.length === 0) return;
  await withDb(async (client) => {
    for (const row of cleanup) {
      await client.query(`DELETE FROM ${row.table} WHERE id = $1`, [row.id]);
    }
    // The explorer endpoint mints a real key per GET; drop the ones this
    // suite created so reruns don't accumulate deactivated keys.
    await client.query(
      `DELETE FROM api_keys WHERE user_id = $1 AND name = 'API Explorer Key'`,
      [requireEnv("TEST_USER_ID")],
    );
  });
});

/** GET with the console's session cookie; returns status + parsed body. */
async function pageLoadGet(
  path: string,
  sessionCookie: string,
): Promise<{ status: number; bodyText: string }> {
  const res = await api.get(path, { headers: { Cookie: sessionCookie } });
  const bodyText = await res.text();
  return { status: res.status, bodyText };
}

describeE2E("console page-load GETs return 2xx for a signed-in user", () => {
  // Every endpoint the console dashboard fires on page load, with the exact
  // status the local Worker contract produces. The explorer endpoint mints a
  // fresh key per load (201 by design).
  const PAGE_LOAD_ENDPOINTS: Array<{ path: string; status: number }> = [
    { path: "/api/my-agents/characters", status: 200 },
    { path: "/api/my-agents/saved", status: 200 },
    { path: "/api/organizations/credentials", status: 200 },
    { path: "/api/organizations/members", status: 200 },
    { path: "/api/organizations/invites", status: 200 },
    { path: "/api/v1/api-keys", status: 200 },
    { path: "/api/v1/api-keys/explorer", status: 201 },
    { path: "/api/v1/apps", status: 200 },
    { path: "/api/v1/affiliates", status: 200 },
    { path: "/api/v1/advertising/accounts", status: 200 },
  ];

  for (const endpoint of PAGE_LOAD_ENDPOINTS) {
    test(`GET ${endpoint.path} (empty/normal state) → ${endpoint.status}`, async () => {
      const sessionCookie = await exchangeApiKeyForSession();
      const { status, bodyText } = await pageLoadGet(
        endpoint.path,
        sessionCookie,
      );
      expect(status, `body: ${bodyText.slice(0, 500)}`).toBe(endpoint.status);
    });
  }

  test("GET /api/my-agents/saved with a seeded chat interaction lists the agent (the #13495 join surface)", async () => {
    const userId = requireEnv("TEST_USER_ID");
    const seeded = await seedSavedAgentInteraction({ userId });

    const sessionCookie = await exchangeApiKeyForSession();
    const { status, bodyText } = await pageLoadGet(
      "/api/my-agents/saved",
      sessionCookie,
    );
    expect(status, `body: ${bodyText.slice(0, 500)}`).toBe(200);
    const body = JSON.parse(bodyText) as {
      success?: boolean;
      data?: { agents?: Array<{ id?: string }> };
    };
    expect(body.success).toBe(true);
    expect(body.data?.agents?.some((a) => a.id === seeded.characterId)).toBe(
      true,
    );
  });

  test("GET /api/my-agents/characters with a seeded owned character lists it", async () => {
    const userId = requireEnv("TEST_USER_ID");
    const organizationId = requireEnv("TEST_ORGANIZATION_ID");
    const seeded = await seedOwnedCharacter({ userId, organizationId });

    const sessionCookie = await exchangeApiKeyForSession();
    const { status, bodyText } = await pageLoadGet(
      "/api/my-agents/characters",
      sessionCookie,
    );
    expect(status, `body: ${bodyText.slice(0, 500)}`).toBe(200);
    const body = JSON.parse(bodyText) as {
      success?: boolean;
      data?: { characters?: Array<{ id?: string }> };
    };
    expect(body.success).toBe(true);
    expect(
      body.data?.characters?.some((c) => c.id === seeded.characterId),
    ).toBe(true);
  });

  test("GET /api/v1/advertising/accounts with a seeded connected account serializes it", async () => {
    const userId = requireEnv("TEST_USER_ID");
    const organizationId = requireEnv("TEST_ORGANIZATION_ID");
    const seeded = await seedAdAccount({ userId, organizationId });

    const sessionCookie = await exchangeApiKeyForSession();
    const { status, bodyText } = await pageLoadGet(
      "/api/v1/advertising/accounts",
      sessionCookie,
    );
    expect(status, `body: ${bodyText.slice(0, 500)}`).toBe(200);
    const body = JSON.parse(bodyText) as {
      accounts?: Array<{ id?: string; createdAt?: string }>;
    };
    const account = body.accounts?.find((a) => a.id === seeded.accountId);
    expect(account).toBeDefined();
    expect(typeof account?.createdAt).toBe("string");
  });
});
