/**
 * Real PGlite test for the anonymous-session cleanup cron. The cron must delete
 * expired anonymous users and prune old anonymous users that never sent a
 * message. It must report the rows it removed.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const CRON_SECRET = "cleanup-cron-test-secret";
const OLD = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const FUTURE = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

const INACTIVE_NO_MESSAGES = "00000000-0000-4000-8000-00000000000a";
const ACTIVE_WITH_MESSAGES = "00000000-0000-4000-8000-00000000000b";
const EXPIRED_ONE = "00000000-0000-4000-8000-00000000000c";
const EXPIRED_TWO = "00000000-0000-4000-8000-00000000000e";
const REGULAR_USER = "00000000-0000-4000-8000-00000000000d";

const { closeDatabaseConnectionsForTests, dbWrite, getPgliteClientForTests } =
  await import("@elizaos/cloud-shared/db/client");
const { default: app } = await import("./route");

const pg = () => getPgliteClientForTests();

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  await pg().exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      organization_id uuid,
      created_at timestamp NOT NULL DEFAULT now()
    );
    CREATE TABLE user_identities (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_anonymous boolean NOT NULL DEFAULT false,
      expires_at timestamp
    );
    CREATE TABLE anonymous_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      session_token text NOT NULL UNIQUE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_count integer NOT NULL DEFAULT 0,
      messages_limit integer NOT NULL DEFAULT 10,
      total_tokens_used integer NOT NULL DEFAULT 0,
      last_message_at timestamp,
      hourly_message_count integer NOT NULL DEFAULT 0,
      hourly_reset_at timestamp,
      gate_revision bigint NOT NULL DEFAULT 0,
      ip_address text,
      user_agent text,
      fingerprint text,
      signup_prompted_at timestamp,
      signup_prompt_count integer NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now(),
      expires_at timestamp NOT NULL,
      converted_at timestamp,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE conversations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title text NOT NULL DEFAULT '',
      model text NOT NULL DEFAULT '',
      settings jsonb NOT NULL DEFAULT '{}',
      status text NOT NULL DEFAULT 'active',
      message_count integer NOT NULL DEFAULT 0,
      total_cost numeric(10,2) NOT NULL DEFAULT 0,
      last_message_at timestamp,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now(),
      deleted_at timestamp
    );
  `);

  const seedUser = async (
    id: string,
    anonymous: boolean,
    identityExpiresAt: string | null,
  ) => {
    await pg().query("INSERT INTO users(id, created_at) VALUES ($1, $2)", [
      id,
      OLD,
    ]);
    await pg().query(
      "INSERT INTO user_identities(user_id, is_anonymous, expires_at) VALUES ($1, $2, $3)",
      [id, anonymous, identityExpiresAt],
    );
  };

  // Anonymous, old, and a session with zero messages: must be pruned.
  await seedUser(INACTIVE_NO_MESSAGES, true, null);
  await pg().query(
    "INSERT INTO anonymous_sessions(session_token, user_id, message_count, expires_at) VALUES ('token-a', $1, 0, $2)",
    [INACTIVE_NO_MESSAGES, FUTURE],
  );
  // Anonymous, old, but has messages: must be kept.
  await seedUser(ACTIVE_WITH_MESSAGES, true, null);
  await pg().query(
    "INSERT INTO anonymous_sessions(session_token, user_id, message_count, expires_at) VALUES ('token-b', $1, 5, $2)",
    [ACTIVE_WITH_MESSAGES, FUTURE],
  );
  // Two users whose anonymous identity expired: both are deleted with their conversations.
  await seedUser(EXPIRED_ONE, true, PAST);
  await seedUser(EXPIRED_TWO, true, PAST);
  await pg().query("INSERT INTO conversations(user_id) VALUES ($1)", [
    EXPIRED_ONE,
  ]);
  await pg().query("INSERT INTO conversations(user_id) VALUES ($1)", [
    EXPIRED_TWO,
  ]);
  // A regular user is never touched.
  await seedUser(REGULAR_USER, false, null);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

test("cleanup prunes inactive anonymous users and reports the removed rows", async () => {
  const response = await app.request(
    "http://localhost/",
    { method: "GET", headers: { authorization: `Bearer ${CRON_SECRET}` } },
    { CRON_SECRET } as never,
  );
  const body = (await response.json()) as {
    success: boolean;
    stats?: { deletedUsers: number; deletedConversations: number };
    error?: string;
  };

  expect(response.status).toBe(200);
  expect(body.success).toBe(true);
  expect(body.stats?.deletedUsers).toBe(3);
  expect(body.stats?.deletedConversations).toBe(2);

  const remaining = await pg().query<{ id: string }>(
    "SELECT id FROM users ORDER BY id",
  );
  expect(remaining.rows.map((row) => row.id)).toEqual([
    ACTIVE_WITH_MESSAGES,
    REGULAR_USER,
  ]);
});
