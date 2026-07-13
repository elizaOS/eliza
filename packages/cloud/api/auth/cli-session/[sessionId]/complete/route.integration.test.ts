/** Drives CLI-session re-completion through the real route, service, repositories, and PGlite; only the authenticated request identity and logger are controlled. */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { Hono } from "hono";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const API_KEY_ID = "44444444-4444-4444-8444-444444444444";

let currentUserId = USER_ID;
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserWithOrg: async () => ({
    id: currentUserId,
    organization_id: ORG_ID,
  }),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

let dbWrite: typeof import("../../../../../shared/src/db/client").dbWrite;
let closeDb:
  | typeof import("../../../../../shared/src/db/client").closeDatabaseConnectionsForTests
  | undefined;
let app: Hono;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import(
    "../../../../../shared/src/db/client"
  ));
  await dbWrite.execute(`CREATE TABLE api_keys (
    id uuid PRIMARY KEY, name text NOT NULL, description text, key_hash text NOT NULL UNIQUE,
    key_prefix text NOT NULL, key_ciphertext text, key_nonce text, key_auth_tag text,
    key_kms_key_id text, key_kms_key_version integer, organization_id uuid NOT NULL,
    user_id uuid NOT NULL, rate_limit integer NOT NULL DEFAULT 1000,
    is_active boolean NOT NULL DEFAULT true, usage_count integer NOT NULL DEFAULT 0,
    expires_at timestamp, last_used_at timestamp, created_at timestamp NOT NULL DEFAULT now(),
    updated_at timestamp NOT NULL DEFAULT now(), deleted_at timestamp
  )`);
  await dbWrite.execute(`CREATE TABLE cli_auth_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id text NOT NULL UNIQUE,
    user_id uuid, api_key_id uuid, consumed_at timestamp, status text NOT NULL DEFAULT 'pending',
    expires_at timestamp NOT NULL, authenticated_at timestamp,
    created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
  )`);
  const route = await import("./route");
  app = new Hono();
  app.route("/api/auth/cli-session/:sessionId/complete", route.default);
}, 60_000);

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  currentUserId = USER_ID;
  await dbWrite.execute("DELETE FROM cli_auth_sessions");
  await dbWrite.execute("DELETE FROM api_keys");
  await dbWrite.execute(`INSERT INTO api_keys
    (id, name, key_hash, key_prefix, organization_id, user_id)
    VALUES ('${API_KEY_ID}', 'CLI key', 'hash', 'eliza_cli', '${ORG_ID}', '${USER_ID}')`);
});

async function seedSession(
  sessionId: string,
  owner: string | null,
): Promise<void> {
  const ownerSql = owner ? `'${owner}'` : "NULL";
  await dbWrite.execute(`INSERT INTO cli_auth_sessions
    (session_id, user_id, api_key_id, status, expires_at, authenticated_at)
    VALUES ('${sessionId}', ${ownerSql}, '${API_KEY_ID}', 'authenticated',
      now() + interval '10 minutes', now())`);
}

async function complete(sessionId: string): Promise<Response> {
  return app.request(`/api/auth/cli-session/${sessionId}/complete`, {
    method: "POST",
  });
}

describe("CLI session completion with real persistence", () => {
  test("same-user retry succeeds without creating another API key", async () => {
    await seedSession("same-user", USER_ID);
    const response = await complete("same-user");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      alreadyAuthenticated: true,
      apiKey: null,
      keyPrefix: "eliza_cli",
    });
    const count = await dbWrite.execute(
      "SELECT count(*)::int AS count FROM api_keys",
    );
    expect(count.rows[0]).toMatchObject({ count: 1 });
  });

  test.each([
    ["different-user", OTHER_USER_ID],
    ["ownerless", null],
  ])("rejects %s sessions without exposing key metadata", async (sessionId, owner) => {
    await seedSession(sessionId, owner);
    const response = await complete(sessionId);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(
      "Session already authenticated or expired",
    );
  });

  test("rejects a missing session", async () => {
    const response = await complete("missing");
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(
      "Invalid or expired session",
    );
  });
});
