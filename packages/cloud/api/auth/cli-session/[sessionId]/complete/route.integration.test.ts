/**
 * Drives CLI-session completion through the real route, transaction, and KMS
 * boundary against PGlite by default and PostgreSQL when configured.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { Hono } from "hono";

const databaseUrl =
  process.env.CLI_AUTH_POSTGRES_URL?.trim() || "pglite://memory";
process.env.DATABASE_URL = databaseUrl;
process.env.TEST_DATABASE_URL = databaseUrl;
process.env.NODE_ENV ||= "test";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "33333333-3333-4333-8333-333333333333";
const API_KEY_ID = "44444444-4444-4444-8444-444444444444";

interface CompleteResponseBody {
  alreadyAuthenticated: boolean;
  keyPrefix: string;
}

let currentUserId = USER_ID;
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async (context: {
    req: { header: (name: string) => string | undefined };
  }) => ({
    id: context.req.header("x-test-user-id") ?? currentUserId,
    organization_id: ORG_ID,
  }),
}));
mock.module("@/lib/utils/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

let dbWrite: typeof import("../../../../../shared/src/db/client").dbWrite;
let cliAuthSessionCompletionService: typeof import("../../../../../shared/src/lib/services/cli-auth-session-completion").cliAuthSessionCompletionService;
let apiKeysService: typeof import("../../../../../shared/src/lib/services/api-keys").apiKeysService;
let closeDb:
  | typeof import("../../../../../shared/src/db/client").closeDatabaseConnectionsForTests
  | undefined;
let app: Hono;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import(
    "../../../../../shared/src/db/client"
  ));
  ({ cliAuthSessionCompletionService } = await import(
    "../../../../../shared/src/lib/services/cli-auth-session-completion"
  ));
  ({ apiKeysService } = await import(
    "../../../../../shared/src/lib/services/api-keys"
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

async function seedPendingSession(sessionId: string): Promise<void> {
  await dbWrite.execute(`INSERT INTO cli_auth_sessions
    (session_id, status, expires_at)
    VALUES ('${sessionId}', 'pending', now() + interval '10 minutes')`);
}

async function complete(
  sessionId: string,
  userId = currentUserId,
): Promise<Response> {
  return app.request(`/api/auth/cli-session/${sessionId}/complete`, {
    method: "POST",
    headers: { "x-test-user-id": userId },
  });
}

async function afterConcurrentPendingReads<T>(
  run: () => Promise<T>,
): Promise<{ result: T; reads: number }> {
  const findActive = cliAuthSessionCompletionService.findActive.bind(
    cliAuthSessionCompletionService,
  );
  let reads = 0;
  let releaseReads: () => void = () => {};
  const bothRead = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  let barrierTimer: ReturnType<typeof setTimeout> | undefined;
  const barrierTimeout = new Promise<never>((_, reject) => {
    barrierTimer = setTimeout(
      () => reject(new Error("Timed out waiting for concurrent primary reads")),
      5_000,
    );
  });
  const readGate = Promise.race([bothRead, barrierTimeout]);
  const readBarrier = spyOn(
    cliAuthSessionCompletionService,
    "findActive",
  ).mockImplementation(async (sessionId) => {
    const session = await findActive(sessionId);
    reads += 1;
    if (reads === 2) releaseReads();
    await readGate;
    return session;
  });

  try {
    const result = await run();
    return { result, reads };
  } finally {
    if (barrierTimer) clearTimeout(barrierTimer);
    readBarrier.mockRestore();
  }
}

describe("CLI session completion with real persistence", () => {
  test("same-user retry succeeds without creating another API key", async () => {
    await seedSession("same-user", USER_ID);
    const response = await complete("same-user");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      alreadyAuthenticated: true,
      keyPrefix: "eliza_cli",
    });
    const count = await dbWrite.execute(
      "SELECT count(*)::int AS count FROM api_keys",
    );
    expect(count.rows[0]).toMatchObject({ count: 1 });
  });

  test("concurrent completions atomically mint exactly one API key", async () => {
    await seedPendingSession("concurrent");

    // Wrap the real primary read with a barrier so both requests have observed
    // the same pending row before either can attempt the conditional claim.
    // This forces the race deterministically instead of relying on scheduler
    // timing while preserving the real route/service/DB/KMS path.
    const {
      result: [first, second],
      reads,
    } = await afterConcurrentPendingReads(() =>
      Promise.all([complete("concurrent"), complete("concurrent")]),
    );
    expect(reads).toBe(2);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const bodies = (await Promise.all([
      first.json(),
      second.json(),
    ])) as CompleteResponseBody[];
    expect(bodies.map((body) => body.alreadyAuthenticated).sort()).toEqual([
      false,
      true,
    ]);
    const winner = bodies.find((body) => !body.alreadyAuthenticated);
    const retry = bodies.find((body) => body.alreadyAuthenticated);
    expect(retry?.keyPrefix).toBe(winner?.keyPrefix);
    expect(bodies.every((body) => !("apiKey" in body))).toBe(true);

    const keys = await dbWrite.execute(
      "SELECT id, is_active FROM api_keys ORDER BY created_at, id",
    );
    // beforeEach seeds one existing key; the two racing calls add exactly one.
    expect(keys.rows).toHaveLength(2);
    expect(keys.rows.every((row) => row.is_active === true)).toBe(true);

    const session = await dbWrite.execute(
      "SELECT status, user_id, api_key_id FROM cli_auth_sessions WHERE session_id = 'concurrent'",
    );
    expect(session.rows[0]).toMatchObject({
      status: "authenticated",
      user_id: USER_ID,
    });
    expect(
      keys.rows.some((row) => row.id === session.rows[0]?.api_key_id),
    ).toBe(true);
  });

  test("concurrent different-user completions persist only the winner's key", async () => {
    await seedPendingSession("cross-user-race");

    const { result: responses, reads } = await afterConcurrentPendingReads(() =>
      Promise.all([
        complete("cross-user-race", USER_ID),
        complete("cross-user-race", OTHER_USER_ID),
      ]),
    );

    expect(reads).toBe(2);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 400,
    ]);
    const winnerIndex = responses.findIndex(
      (response) => response.status === 200,
    );
    const winnerId = winnerIndex === 0 ? USER_ID : OTHER_USER_ID;
    expect(JSON.stringify(await responses[1 - winnerIndex]?.json())).toContain(
      "Session already authenticated or expired",
    );

    const keys = await dbWrite.execute(
      `SELECT id, user_id FROM api_keys WHERE id <> '${API_KEY_ID}'`,
    );
    expect(keys.rows).toEqual([expect.objectContaining({ user_id: winnerId })]);
    const session = await dbWrite.execute(
      "SELECT user_id, api_key_id FROM cli_auth_sessions WHERE session_id = 'cross-user-race'",
    );
    expect(session.rows[0]).toMatchObject({
      user_id: winnerId,
      api_key_id: keys.rows[0]?.id,
    });
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

  test("rolls back the session claim when API-key insertion fails", async () => {
    await seedPendingSession("insert-failure");
    const generate = spyOn(apiKeysService, "generateApiKey").mockReturnValue({
      key: "eliza_duplicate_plaintext",
      hash: "hash",
      prefix: "eliza_duplicate",
    });

    try {
      const response = await complete("insert-failure");
      expect(response.status).toBe(500);
    } finally {
      generate.mockRestore();
    }

    const session = await dbWrite.execute(
      "SELECT status, user_id, api_key_id, authenticated_at FROM cli_auth_sessions WHERE session_id = 'insert-failure'",
    );
    expect(session.rows[0]).toMatchObject({
      status: "pending",
      user_id: null,
      api_key_id: null,
      authenticated_at: null,
    });
    const keys = await dbWrite.execute(
      "SELECT count(*)::int AS count FROM api_keys",
    );
    expect(keys.rows[0]).toMatchObject({ count: 1 });
  });

  test.each([
    [
      "missing-key-reference",
      "UPDATE cli_auth_sessions SET api_key_id = NULL WHERE session_id = 'missing-key-reference'",
    ],
    ["missing-key-row", `DELETE FROM api_keys WHERE id = '${API_KEY_ID}'`],
    [
      "mismatched-key-owner",
      `UPDATE api_keys SET user_id = '${OTHER_USER_ID}' WHERE id = '${API_KEY_ID}'`,
    ],
  ])("fails closed for authenticated session integrity defect: %s", async (sessionId, mutation) => {
    await seedSession(sessionId, USER_ID);
    await dbWrite.execute(mutation);

    const response = await complete(sessionId);
    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.success).not.toBe(true);
    expect(JSON.stringify(body)).not.toContain("eliza_cli");
  });

  test("rejects a missing session", async () => {
    const response = await complete("missing");
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain(
      "Invalid or expired session",
    );
  });
});
