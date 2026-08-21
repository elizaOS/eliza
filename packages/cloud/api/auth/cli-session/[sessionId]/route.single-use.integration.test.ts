/**
 * Real-persistence regression coverage for the single-use CLI key reveal.
 *
 * The HTTP route, service, repositories, Drizzle queries, and PGlite database
 * are real. Only the external KMS decrypt boundary and logger are controlled.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import crypto from "node:crypto";
import { Hono } from "hono";

const databaseUrl =
  process.env.CLI_AUTH_POSTGRES_URL?.trim() || "pglite://memory";
process.env.DATABASE_URL = databaseUrl;
process.env.TEST_DATABASE_URL = databaseUrl;
process.env.NODE_ENV ||= "test";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "44444444-4444-4444-8444-444444444444";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const API_KEY_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_API_KEY_ID = "55555555-5555-4555-8555-555555555555";
const PLAINTEXT = "eliza_single_winner_plaintext";
const OTHER_PLAINTEXT = "eliza_newer_login_plaintext";

let decryptMode: "success" | "failure" = "success";
let decryptCalls = 0;
let concurrentDecryptGate: Promise<void> | null = null;
let releaseConcurrentDecrypts: (() => void) | null = null;
let decryptHook: (() => Promise<void>) | null = null;

// Bun module mocks are process-wide across test files. Preserve the real
// encryption export so this reveal-only decrypt seam cannot poison the CLI
// completion integration tests when both files share a test process.
const { encryptApiKey } = await import(
  "../../../../shared/src/db/crypto/api-keys"
);

mock.module("../../../../shared/src/db/crypto/api-keys", () => ({
  decryptApiKey: async () => {
    decryptCalls += 1;
    if (decryptMode === "failure") {
      throw new Error("controlled KMS failure");
    }

    await decryptHook?.();

    if (concurrentDecryptGate) {
      if (decryptCalls === 2) {
        releaseConcurrentDecrypts?.();
      }
      await within(concurrentDecryptGate, "concurrent decrypt rendezvous");
    }

    return PLAINTEXT;
  },
  encryptApiKey,
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} },
}));

let dbWrite: typeof import("../../../../shared/src/db/client").dbWrite;
let closeDb:
  | typeof import("../../../../shared/src/db/client").closeDatabaseConnectionsForTests
  | undefined;
let cliAuthSessionsRepository: typeof import("../../../../shared/src/db/repositories/cli-auth-sessions").cliAuthSessionsRepository;
let apiKeysRepository: typeof import("../../../../shared/src/db/repositories/api-keys").apiKeysRepository;
let apiKeysService: typeof import("../../../../shared/src/lib/services/api-keys").apiKeysService;
let cliAuthSessionsService: typeof import("../../../../shared/src/lib/services/cli-auth-sessions").cliAuthSessionsService;
let pollApp: Hono;
let legacyPollApp: Hono;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import(
    "../../../../shared/src/db/client"
  ));
  await dbWrite.execute(`CREATE TABLE api_keys (
    id uuid PRIMARY KEY, name text NOT NULL, description text, key_hash text NOT NULL UNIQUE,
    key_prefix text NOT NULL, key_ciphertext text, key_nonce text, key_auth_tag text,
    key_kms_key_id text, key_kms_key_version integer, organization_id uuid NOT NULL,
    user_id uuid NOT NULL, source_app_id uuid, rate_limit integer NOT NULL DEFAULT 1000,
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

  ({ cliAuthSessionsRepository } = await import(
    "../../../../shared/src/db/repositories/cli-auth-sessions"
  ));
  ({ apiKeysRepository } = await import(
    "../../../../shared/src/db/repositories/api-keys"
  ));
  ({ apiKeysService } = await import(
    "../../../../shared/src/lib/services/api-keys"
  ));
  ({ cliAuthSessionsService } = await import(
    "../../../../shared/src/lib/services/cli-auth-sessions"
  ));

  const pollRoute = await import("./route");
  pollApp = new Hono();
  pollApp.route("/api/auth/cli-session/:sessionId", pollRoute.default);

  const legacyPollRoute = await import(
    "../../../eliza-app/cli-auth/poll/route"
  );
  legacyPollApp = new Hono();
  legacyPollApp.route("/api/eliza-app/cli-auth/poll", legacyPollRoute.default);
}, 60_000);

afterAll(async () => {
  await closeDb?.();
});

beforeEach(async () => {
  decryptMode = "success";
  decryptCalls = 0;
  concurrentDecryptGate = null;
  releaseConcurrentDecrypts = null;
  decryptHook = null;
  await dbWrite.execute("DELETE FROM cli_auth_sessions");
  await dbWrite.execute("DELETE FROM api_keys");
});

async function seedAuthenticatedSession(
  sessionId: string,
  options: {
    completeEncryptedKey?: boolean;
    sessionUserId?: string;
  } = {},
): Promise<void> {
  const completeEncryptedKey = options.completeEncryptedKey ?? true;
  const sessionUserId = options.sessionUserId ?? USER_ID;
  const keyHash = crypto.createHash("sha256").update(PLAINTEXT).digest("hex");
  await dbWrite.execute(`INSERT INTO api_keys
    (id, name, key_hash, key_prefix, key_ciphertext, key_nonce, key_auth_tag,
      key_kms_key_id, key_kms_key_version, organization_id, user_id)
    VALUES ('${API_KEY_ID}', 'CLI key', '${keyHash}', 'eliza_single',
      ${completeEncryptedKey ? "'ciphertext'" : "NULL"}, 'nonce', 'auth-tag',
      'kms-key', 1, '${ORG_ID}', '${USER_ID}')`);
  await dbWrite.execute(`INSERT INTO cli_auth_sessions
    (session_id, user_id, api_key_id, status, expires_at, authenticated_at)
    VALUES ('${sessionId}', '${sessionUserId}', '${API_KEY_ID}', 'authenticated',
      now() + interval '10 minutes', now())`);
}

async function readSession(
  sessionId: string,
): Promise<Record<string, unknown>> {
  const result = await dbWrite.execute(
    `SELECT status, consumed_at FROM cli_auth_sessions WHERE session_id = '${sessionId}'`,
  );
  return result.rows[0] as Record<string, unknown>;
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out`)),
          5_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe("CLI session single-use plaintext retrieval with real persistence", () => {
  test("the poll route rejects a non-UUID session id before any lookup", async () => {
    const response = await pollApp.request("/api/auth/cli-session/not-a-uuid");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Invalid session ID format",
    });
  });

  test("the session lifecycle still uses the real repository guards", async () => {
    const sessionId = "lifecycle";
    const created = await cliAuthSessionsService.createSession(sessionId);
    expect(created).toMatchObject({ session_id: sessionId, status: "pending" });
    expect(await cliAuthSessionsService.getSession(sessionId)).toMatchObject({
      session_id: sessionId,
    });
    expect(
      await cliAuthSessionsService.getActiveSession(sessionId),
    ).toMatchObject({
      status: "pending",
    });

    const authenticated = await cliAuthSessionsRepository.markAuthenticated(
      sessionId,
      USER_ID,
      API_KEY_ID,
    );
    expect(authenticated).toMatchObject({
      status: "authenticated",
      user_id: USER_ID,
      api_key_id: API_KEY_ID,
    });

    await cliAuthSessionsRepository.markExpired(sessionId);
    expect(await cliAuthSessionsService.getSession(sessionId)).toMatchObject({
      status: "expired",
    });
    await cliAuthSessionsRepository.update(sessionId, {
      expires_at: new Date(Date.now() - 1_000),
    });
    await cliAuthSessionsService.cleanupExpiredSessions();
    expect(await cliAuthSessionsService.getSession(sessionId)).toBeNull();
  });

  test("two concurrent poll routes decrypt the candidate but exactly one returns plaintext", async () => {
    const sessionId = "10101010-1010-4010-8010-101010101010";
    await seedAuthenticatedSession(sessionId);

    concurrentDecryptGate = new Promise<void>((resolve) => {
      releaseConcurrentDecrypts = resolve;
    });

    const [first, second] = await Promise.all([
      pollApp.request(`/api/auth/cli-session/${sessionId}`),
      pollApp.request(`/api/auth/cli-session/${sessionId}`),
    ]);
    const payloads = (await Promise.all([
      first.json(),
      second.json(),
    ])) as Array<Record<string, unknown>>;

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(decryptCalls).toBe(2);
    expect(
      payloads.filter((payload) => payload.apiKey === PLAINTEXT),
    ).toHaveLength(1);
    expect(payloads.filter((payload) => !("apiKey" in payload))).toHaveLength(
      1,
    );
    expect(await readSession(sessionId)).toMatchObject({
      status: "authenticated",
      consumed_at: expect.any(String),
    });
  });

  test("exact consumed-key revocation disables only abandoned A while B remains valid", async () => {
    const firstSession = "11111111-aaaa-4111-8111-111111111111";
    const secondSession = "22222222-bbbb-4222-8222-222222222222";
    await seedAuthenticatedSession(firstSession);
    const revealed = await pollApp.request(
      `/api/auth/cli-session/${firstSession}`,
    );
    expect(revealed.status).toBe(200);
    expect(await revealed.json()).toMatchObject({ apiKey: PLAINTEXT });

    const otherHash = crypto
      .createHash("sha256")
      .update(OTHER_PLAINTEXT)
      .digest("hex");
    await dbWrite.execute(`INSERT INTO api_keys
      (id, name, key_hash, key_prefix, key_ciphertext, key_nonce, key_auth_tag,
        key_kms_key_id, key_kms_key_version, organization_id, user_id)
      VALUES ('${OTHER_API_KEY_ID}', 'Newer CLI key', '${otherHash}', 'eliza_newer',
        'ciphertext', 'nonce', 'auth-tag', 'kms-key', 1, '${ORG_ID}', '${USER_ID}')`);
    await dbWrite.execute(`INSERT INTO cli_auth_sessions
      (session_id, user_id, api_key_id, consumed_at, status, expires_at, authenticated_at)
      VALUES ('${secondSession}', '${USER_ID}', '${OTHER_API_KEY_ID}', now(),
        'authenticated', now() + interval '10 minutes', now())`);

    const mismatched = await pollApp.request(
      `/api/auth/cli-session/${firstSession}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${OTHER_PLAINTEXT}` },
      },
    );
    expect(mismatched.status).toBe(403);

    const revoked = await pollApp.request(
      `/api/auth/cli-session/${firstSession}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${PLAINTEXT}` },
      },
    );
    expect(revoked.status).toBe(204);
    await expect(apiKeysService.validateApiKey(PLAINTEXT)).resolves.toBeNull();
    await expect(
      apiKeysService.validateApiKey(OTHER_PLAINTEXT),
    ).resolves.toMatchObject({ id: OTHER_API_KEY_ID, is_active: true });
  });

  test("a decrypt failure does not consume the session and a retry can win", async () => {
    const sessionId = "20202020-2020-4020-8020-202020202020";
    await seedAuthenticatedSession(sessionId);
    decryptMode = "failure";

    const failed = await pollApp.request(`/api/auth/cli-session/${sessionId}`);
    expect(failed.status).toBe(500);
    expect(await readSession(sessionId)).toMatchObject({
      status: "authenticated",
      consumed_at: null,
    });

    decryptMode = "success";
    const retried = await pollApp.request(`/api/auth/cli-session/${sessionId}`);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ apiKey: PLAINTEXT });
    expect(await readSession(sessionId)).toMatchObject({
      status: "authenticated",
      consumed_at: expect.any(String),
    });
  });

  test("a stale candidate cannot consume a session whose owner changes during decrypt", async () => {
    const sessionId = "30303030-3030-4030-8030-303030303030";
    await seedAuthenticatedSession(sessionId);

    let signalDecryptStarted: (() => void) | undefined;
    const decryptStarted = new Promise<void>((resolve) => {
      signalDecryptStarted = resolve;
    });
    let releaseDecrypt: (() => void) | undefined;
    const decryptReleased = new Promise<void>((resolve) => {
      releaseDecrypt = resolve;
    });
    decryptHook = async () => {
      signalDecryptStarted?.();
      await decryptReleased;
    };

    const pendingResponse = pollApp.request(
      `/api/auth/cli-session/${sessionId}`,
    );
    await within(decryptStarted, "decrypt rendezvous");
    await dbWrite.execute(
      `UPDATE cli_auth_sessions SET user_id = '${OTHER_USER_ID}' WHERE session_id = '${sessionId}'`,
    );
    releaseDecrypt?.();

    const response = await pendingResponse;
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("apiKey");
    expect(await readSession(sessionId)).toMatchObject({
      status: "authenticated",
      consumed_at: null,
    });
  });

  test("a session/API-key owner mismatch is rejected before decrypt", async () => {
    const sessionId = "40404040-4040-4040-8040-404040404040";
    await seedAuthenticatedSession(sessionId, {
      sessionUserId: OTHER_USER_ID,
    });

    const response = await pollApp.request(
      `/api/auth/cli-session/${sessionId}`,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "Failed to get session status",
    });
    expect(decryptCalls).toBe(0);
    expect(await readSession(sessionId)).toMatchObject({
      status: "authenticated",
      consumed_at: null,
    });
  });

  test("incomplete encrypted key material is an observable integrity failure", async () => {
    const sessionId = "missing-key-material";
    await seedAuthenticatedSession(sessionId, { completeEncryptedKey: false });

    const response = await legacyPollApp.request(
      `/api/eliza-app/cli-auth/poll?session_id=${sessionId}`,
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      success: false,
      error: "Failed to poll session",
    });
    expect(decryptCalls).toBe(0);
    expect(await readSession(sessionId)).toMatchObject({
      status: "authenticated",
      consumed_at: null,
    });
  });

  test("a real API-key regeneration update invalidates a decrypted candidate before claim", async () => {
    const sessionId = "50505050-5050-4050-8050-505050505050";
    await seedAuthenticatedSession(sessionId);

    let signalDecryptStarted: (() => void) | undefined;
    const decryptStarted = new Promise<void>((resolve) => {
      signalDecryptStarted = resolve;
    });
    let releaseDecrypt: (() => void) | undefined;
    const decryptReleased = new Promise<void>((resolve) => {
      releaseDecrypt = resolve;
    });
    decryptHook = async () => {
      signalDecryptStarted?.();
      await decryptReleased;
    };

    const pendingResponse = pollApp.request(
      `/api/auth/cli-session/${sessionId}`,
    );
    await within(decryptStarted, "regeneration rendezvous");
    await apiKeysRepository.update(API_KEY_ID, {
      key_hash: "regenerated-hash",
      key_prefix: "eliza_regenerated",
      key_ciphertext: "regenerated-ciphertext",
    });
    releaseDecrypt?.();

    const response = await pendingResponse;
    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty("apiKey");
    expect(await readSession(sessionId)).toMatchObject({
      status: "authenticated",
      consumed_at: null,
    });
  });
});
