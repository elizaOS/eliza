/**
 * Real end-to-end for the production device-pairing auth path (#13692).
 *
 * The sibling `auth-pairing-routes.test.ts` mocks `AuthStore`, the session
 * layer, and the DB, so it proves the route *branches* but structurally cannot
 * prove the property real users depend on: that a session minted by pairing
 * actually authenticates subsequent requests, and that revoking it takes
 * effect. Every CI lane bypasses this path entirely (`ELIZA_PAIRING_DISABLED=1`
 * on the device-e2e host + mobile/android workflows), so it had **zero**
 * no-mock coverage.
 *
 * This suite drives the WHOLE flow over a real TCP HTTP server, against a real
 * `AuthStore` backed by a real, migrated PGlite database — nothing mocked:
 *
 *   loopback GET  /api/auth/pair-code            → operator reads rotating code
 *   proxied  GET  /api/auth/pair-code            → 403 (pairing wall)
 *   remote   POST /api/auth/pair  (wrong code)   → 403
 *   remote   POST /api/auth/pair  (correct code) → 200 { token: <sessionId> }
 *   remote   GET  /api/auth/status Bearer <id>   → authenticated:true  (THE crux)
 *   revoke the session in the real DB
 *   remote   GET  /api/auth/status Bearer <id>   → authenticated:false (revocable)
 *
 * plus the adversarial matrix the mocked unit test can't reach through stubs:
 * single-use replay of a consumed code (403), per-IP rate limit (429),
 * pairing-disabled darkness (503/403), and the session actually landing as a
 * row in the real `auth_session` table with the `paired-device` label.
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import type { UUID } from "@elizaos/core";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";
import { createTestDatabase } from "@elizaos/plugin-sql/__tests__/test-helpers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthStore } from "../services/auth-store";
import { findActiveSession } from "./auth/sessions";
// The route module holds pairing state in module globals; import once and
// reset between tests via the exported test hook.
import {
  _resetAuthPairingStateForTests,
  handleAuthPairingCompatRoutes,
} from "./auth-pairing-routes";
import type { CompatRuntimeState } from "./compat-route-shared";

const TEST_AGENT_ID = "00000000-0000-0000-0000-000000013692" as UUID;

const REMOTE_IP = "203.0.113.10";

interface Harness {
  baseUrl: string;
  store: AuthStore;
  close: () => Promise<void>;
}

interface HttpResult {
  status: number;
  json: Record<string, unknown> | null;
}

/**
 * Fire a real HTTP request at the running server. `proxied` attaches an
 * `x-forwarded-for` header so the request is treated as coming through a proxy
 * from a non-loopback client — the exact shape a remote device hits, which the
 * loopback-trust check rejects for code disclosure.
 */
async function request(
  baseUrl: string,
  opts: {
    method: string;
    path: string;
    proxied?: boolean;
    bearer?: string;
    body?: unknown;
  },
): Promise<HttpResult> {
  const url = new URL(opts.path, baseUrl);
  const payload =
    opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const headers: Record<string, string> = {};
  if (payload !== undefined) {
    headers["content-type"] = "application/json";
    headers["content-length"] = String(Buffer.byteLength(payload));
  }
  if (opts.proxied) headers["x-forwarded-for"] = REMOTE_IP;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;

  return await new Promise<HttpResult>((resolve, reject) => {
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method: opts.method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json: Record<string, unknown> | null = null;
          if (text.length > 0) {
            try {
              json = JSON.parse(text) as Record<string, unknown>;
            } catch {
              json = null;
            }
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

let harness: Harness;
let cleanupDb: () => Promise<void>;

const ENV_KEYS = [
  "ELIZA_API_TOKEN",
  "ELIZA_PAIRING_DISABLED",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZAOS_CLOUD_API_KEY",
  "STEWARD_AGENT_TOKEN",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  // Pairing is enabled iff a compat API token is configured, pairing is not
  // explicitly disabled, and the deployment is not cloud-provisioned.
  process.env.ELIZA_API_TOKEN = "e2e-pairing-static-token";
  delete process.env.ELIZA_PAIRING_DISABLED;
  delete process.env.ELIZA_CLOUD_PROVISIONED;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  delete process.env.ELIZAOS_CLOUD_ENABLED;
  delete process.env.ELIZAOS_CLOUD_API_KEY;
  delete process.env.STEWARD_AGENT_TOKEN;

  // Real, migrated PGlite database with the plugin-sql auth schema.
  const db = await createTestDatabase(TEST_AGENT_ID, [sqlPlugin]);
  cleanupDb = db.cleanup;
  const drizzle = db.adapter.getDatabase();
  const store = new AuthStore(
    drizzle as ConstructorParameters<typeof AuthStore>[0],
  );

  // The route reads the runtime DB off `state.current.adapter.db`.
  const state: CompatRuntimeState = {
    current: {
      adapter: { db: drizzle },
    } as unknown as CompatRuntimeState["current"],
    pendingAgentName: null,
    pendingRestartReasons: [],
  };

  const server = http.createServer((req, res) => {
    handleAuthPairingCompatRoutes(req, res, state)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        }
      })
      .catch((err) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(err) }));
      });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  harness = {
    baseUrl: `http://127.0.0.1:${port}`,
    store,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
});

afterAll(async () => {
  await harness?.close();
  await cleanupDb?.();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  _resetAuthPairingStateForTests();
});

/** Read the current rotating pair code the way a local operator would. */
async function fetchPairCode(): Promise<string> {
  const res = await request(harness.baseUrl, {
    method: "GET",
    path: "/api/auth/pair-code",
  });
  expect(res.status).toBe(200);
  const code = res.json?.code;
  expect(typeof code).toBe("string");
  return code as string;
}

describe("production device-pairing auth path — real DB + real HTTP (#13692)", () => {
  it("discloses the pair code to loopback but hides it from proxied/remote callers", async () => {
    const local = await request(harness.baseUrl, {
      method: "GET",
      path: "/api/auth/pair-code",
    });
    expect(local.status).toBe(200);
    expect(local.json).toMatchObject({
      code: expect.stringMatching(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/),
      expiresAt: expect.any(Number),
    });

    const proxied = await request(harness.baseUrl, {
      method: "GET",
      path: "/api/auth/pair-code",
      proxied: true,
    });
    expect(proxied.status).toBe(403);
    expect(proxied.json).toMatchObject({
      error: "Pair code visible on loopback only",
    });
  });

  it("shows the pairing wall to an unauthenticated remote client via /api/auth/status", async () => {
    const status = await request(harness.baseUrl, {
      method: "GET",
      path: "/api/auth/status",
      proxied: true,
    });
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({
      required: true,
      authenticated: false,
      localAccess: false,
      pairingEnabled: true,
    });
  });

  it("rejects a wrong pairing code", async () => {
    await fetchPairCode();
    const res = await request(harness.baseUrl, {
      method: "POST",
      path: "/api/auth/pair",
      body: { code: "ZZZZ-ZZZZ-ZZZZ" },
    });
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ error: "Invalid pairing code" });
  });

  it("mints a revocable machine session that authenticates and then stops after revoke", async () => {
    const code = await fetchPairCode();

    // Remote client completes pairing and receives a session id (NOT the
    // forever-valid static API token).
    const paired = await request(harness.baseUrl, {
      method: "POST",
      path: "/api/auth/pair",
      body: { code },
    });
    expect(paired.status).toBe(200);
    const sessionId = paired.json?.token as string;
    expect(typeof sessionId).toBe("string");
    expect(sessionId).not.toBe(process.env.ELIZA_API_TOKEN);

    // The session is a real row in the real auth_session table, machine-kind,
    // labelled by the pairing flow.
    const row = await harness.store.findSession(sessionId);
    expect(row).not.toBeNull();
    expect(row?.kind).toBe("machine");
    expect(row?.userAgent).toBe("paired-device");
    expect(row?.revokedAt).toBeNull();

    // THE crux #13692 asks for: the minted session authenticates a subsequent
    // request against real DB truth — proven by a proxied (non-local) status
    // probe that is authenticated ONLY because of the bearer session.
    const authed = await request(harness.baseUrl, {
      method: "GET",
      path: "/api/auth/status",
      proxied: true,
      bearer: sessionId,
    });
    expect(authed.status).toBe(200);
    expect(authed.json).toMatchObject({
      authenticated: true,
      required: false,
    });

    // Independent confirmation through the real session lookup helper.
    const active = await findActiveSession(harness.store, sessionId);
    expect(active?.id).toBe(sessionId);

    // Revoke in the real DB and confirm the bearer no longer authenticates —
    // sessions are revocable, unlike the static connection key.
    const revoked = await harness.store.revokeSession(sessionId);
    expect(revoked).toBe(true);

    const afterRevoke = await request(harness.baseUrl, {
      method: "GET",
      path: "/api/auth/status",
      proxied: true,
      bearer: sessionId,
    });
    expect(afterRevoke.status).toBe(200);
    expect(afterRevoke.json).toMatchObject({
      authenticated: false,
      required: true,
    });
    expect(await findActiveSession(harness.store, sessionId)).toBeNull();
  });

  it("treats a pairing code as single-use — a replay of a consumed code is rejected", async () => {
    const code = await fetchPairCode();

    const first = await request(harness.baseUrl, {
      method: "POST",
      path: "/api/auth/pair",
      body: { code },
    });
    expect(first.status).toBe(200);

    // Same code again: it was cleared on success and a fresh code rotated in,
    // so the old value no longer matches.
    const replay = await request(harness.baseUrl, {
      method: "POST",
      path: "/api/auth/pair",
      body: { code },
    });
    expect(replay.status).toBe(403);
    expect(replay.json).toMatchObject({ error: "Invalid pairing code" });
  });

  it("rate-limits repeated pairing attempts from the same client IP", async () => {
    await fetchPairCode();
    // PAIRING_MAX_ATTEMPTS = 5; the 6th attempt in the window is throttled.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await request(harness.baseUrl, {
        method: "POST",
        path: "/api/auth/pair",
        body: { code: "ZZZZ-ZZZZ-ZZZZ" },
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
    expect(statuses[5]).toBe(429);
  });

  it("goes dark when pairing is disabled", async () => {
    process.env.ELIZA_PAIRING_DISABLED = "1";
    try {
      const code = await request(harness.baseUrl, {
        method: "GET",
        path: "/api/auth/pair-code",
      });
      expect(code.status).toBe(503);
      expect(code.json).toMatchObject({ error: "Pairing not enabled" });

      const pair = await request(harness.baseUrl, {
        method: "POST",
        path: "/api/auth/pair",
        body: { code: "ANY0-CODE-HERE" },
      });
      expect(pair.status).toBe(403);
      expect(pair.json).toMatchObject({ error: "Pairing disabled" });
    } finally {
      delete process.env.ELIZA_PAIRING_DISABLED;
    }
  });
});
