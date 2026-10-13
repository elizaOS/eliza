/** Exercises anonymous cleanup selection and deletion against real PGlite. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";

const EXPIRED = "81000000-0000-4000-8000-000000000001";
const ZERO_ONLY = "81000000-0000-4000-8000-000000000002";
const USED = "81000000-0000-4000-8000-000000000003";
const NO_SESSION = "81000000-0000-4000-8000-000000000004";
const RECENT = "81000000-0000-4000-8000-000000000005";
const MEMBER = "81000000-0000-4000-8000-000000000006";
const OLD = "2020-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";

let database: ReturnType<
  typeof import("@elizaos/cloud-shared/db/client").getPgliteClientForTests
>;
let closeDatabase: typeof import("@elizaos/cloud-shared/db/client").closeDatabaseConnectionsForTests;
let routes: Hono<AppEnv>;

beforeAll(async () => {
  const db = await import("@elizaos/cloud-shared/db/client");
  database = db.getPgliteClientForTests();
  closeDatabase = db.closeDatabaseConnectionsForTests;
  await database.exec(`
    CREATE TABLE users (
      id uuid PRIMARY KEY,
      created_at timestamp NOT NULL
    );
    CREATE TABLE user_identities (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      is_anonymous boolean NOT NULL,
      expires_at timestamp
    );
    CREATE TABLE conversations (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE anonymous_sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_count integer NOT NULL,
      expires_at timestamp NOT NULL
    );
  `);

  await database.exec(`
    INSERT INTO users (id, created_at) VALUES
      ('${EXPIRED}', '${OLD}'),
      ('${ZERO_ONLY}', '${OLD}'),
      ('${USED}', '${OLD}'),
      ('${NO_SESSION}', '${OLD}'),
      ('${RECENT}', now()),
      ('${MEMBER}', '${OLD}');
    INSERT INTO user_identities (user_id, is_anonymous, expires_at) VALUES
      ('${EXPIRED}', true, '${OLD}'),
      ('${ZERO_ONLY}', true, '${FUTURE}'),
      ('${USED}', true, '${FUTURE}'),
      ('${NO_SESSION}', true, '${FUTURE}'),
      ('${RECENT}', true, '${FUTURE}'),
      ('${MEMBER}', false, '${FUTURE}');
    INSERT INTO conversations (id, user_id) VALUES
      ('82000000-0000-4000-8000-000000000001', '${EXPIRED}'),
      ('82000000-0000-4000-8000-000000000002', '${EXPIRED}'),
      ('82000000-0000-4000-8000-000000000003', '${USED}');
    INSERT INTO anonymous_sessions (id, user_id, message_count, expires_at) VALUES
      ('83000000-0000-4000-8000-000000000001', '${EXPIRED}', 4, '${FUTURE}'),
      ('83000000-0000-4000-8000-000000000002', '${ZERO_ONLY}', 0, '${FUTURE}'),
      ('83000000-0000-4000-8000-000000000003', '${ZERO_ONLY}', 0, '${FUTURE}'),
      ('83000000-0000-4000-8000-000000000004', '${USED}', 0, '${FUTURE}'),
      ('83000000-0000-4000-8000-000000000005', '${USED}', 3, '${OLD}'),
      ('83000000-0000-4000-8000-000000000006', '${RECENT}', 0, '${OLD}'),
      ('83000000-0000-4000-8000-000000000007', '${MEMBER}', 0, '${FUTURE}');
  `);

  routes = new Hono<AppEnv>();
  routes.route("/", (await import("./route")).default);
});

afterAll(async () => {
  await closeDatabase();
});

test("cleanup deletes only expired or old never-used anonymous users", async () => {
  const response = await routes.request(
    "https://cloud.example/",
    { headers: { Authorization: "Bearer cleanup-secret" } },
    { CRON_SECRET: "cleanup-secret" },
  );

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    success: true,
    stats: {
      deletedUsers: 3,
      deletedSessions: 2,
      deletedConversations: 2,
    },
  });

  const remainingUsers = await database.query<{ id: string }>(
    "SELECT id FROM users ORDER BY id",
  );
  expect(remainingUsers.rows.map((row) => row.id)).toEqual([
    USED,
    RECENT,
    MEMBER,
  ]);

  const remainingSessions = await database.query<{
    message_count: number;
    user_id: string;
  }>(
    "SELECT user_id, message_count FROM anonymous_sessions ORDER BY user_id, message_count",
  );
  expect(remainingSessions.rows).toEqual([
    { user_id: USED, message_count: 0 },
    { user_id: MEMBER, message_count: 0 },
  ]);

  const remainingConversations = await database.query<{ user_id: string }>(
    "SELECT user_id FROM conversations ORDER BY user_id",
  );
  expect(remainingConversations.rows).toEqual([{ user_id: USED }]);
});
