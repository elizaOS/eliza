/**
 * Worker speech routes run the chat completions rate limiter. Production
 * flags authorize every API key at origin with no admission snapshot, which
 * used to send STT and TTS through the exclusive policy lock and Redis REST
 * windows. Real STT and TTS routes, API-key auth and policy reads on PGlite;
 * the per-organization Durable Object and the Redis REST endpoint are counting
 * fakes. The Durable Object's own window logic is covered by its miniflare test.
 * The personal agent's platform-funded image and video media count in the same
 * strict window when the turn runs in a Worker.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { createHash } from "node:crypto";
import type { SharedMediaGenerationPort } from "@elizaos/cloud-shared/lib/services/shared-runtime/run-shared-agent-turn";
import type { Hono } from "hono";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
// Production values: the positive auth cache stays off without strong
// revocation, and the compatibility limiter uses Redis REST.
process.env.INFERENCE_AUTH_CACHE_ENABLED = "true";
process.env.INFERENCE_STRONG_REVOCATION_ENABLED = "false";
process.env.REDIS_RATE_LIMITING = "true";
process.env.DIRECT_REDIS_BACKEND = "redis-rest";
process.env.KV_REST_API_URL = "https://redis-rest.test";
process.env.KV_REST_API_TOKEN = "redis-rest-token";
setDefaultTimeout(120_000);

const ORG = "71000000-0000-4000-8000-000000000009";
const SECOND_ORG = "71000000-0000-4000-8000-000000000008";
const FIXTURE_ORG = "61000000-0000-4000-8000-000000000001";
const USER = "73000000-0000-4000-8000-000000000001";
const SECOND_USER = "73000000-0000-4000-8000-000000000002";

interface GateCall {
  name: string;
  path: string;
  body: {
    endpointType: string;
    maxRequests: number;
    windowMs: number;
    windowStartedAt: number;
    apiKey?: { id: string; maxRequests: number };
  };
}

const gateCalls: GateCall[] = [];
const gateWindows = new Map<string, number>();
let gateDown = false;
/** Fixed windows like the real object: one per endpoint, one per key across endpoints. */
const INFERENCE_ADMISSION_GATES = {
  getByName(name: string) {
    return {
      async fetch(request: Request): Promise<Response> {
        if (gateDown) throw new TypeError("Durable Object unreachable");
        const call: GateCall = {
          name,
          path: new URL(request.url).pathname,
          body: await request.json(),
        };
        gateCalls.push(call);
        if (call.path !== "/rate-limit")
          return new Response("unexpected", { status: 404 });
        const bump = (window: string) => {
          const count = (gateWindows.get(window) ?? 0) + 1;
          gateWindows.set(window, count);
          return count;
        };
        const { body } = call;
        const orgCount = bump(`${name}:${body.endpointType}`);
        const keyCount = body.apiKey ? bump(`${name}:${body.apiKey.id}`) : 0;
        const allowed =
          orgCount <= body.maxRequests &&
          (!body.apiKey || keyCount <= body.apiKey.maxRequests);
        return Response.json(
          {
            allowed,
            remaining: allowed ? 1 : 0,
            resetAt: body.windowStartedAt + body.windowMs,
            ...(allowed ? {} : { retryAfter: 60 }),
          },
          { status: allowed ? 200 : 429 },
        );
      },
    };
  },
};

let redisCalls = 0;
const redisWindows = new Map<string, number>();
const realFetch = globalThis.fetch;

let pg: () => { exec(query: string): Promise<unknown> };
let closeDatabase: () => Promise<void>;
let runWithBindings: <T>(
  bindings: Record<string, unknown>,
  fn: () => Promise<T>,
) => Promise<T>;
let routes: { stt: Hono; tts: Hono };
let personalMedia: (
  executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined,
) => SharedMediaGenerationPort | undefined;
let strictRpm: number;
const keys: Record<
  "plain" | "capped" | "inactive" | "deleted" | "foreign" | "second",
  { id: string; raw: string }
> = {} as never;

beforeAll(async () => {
  // Sliding-window Upstash pipeline: zremrangebyscore, zcard, zadd, expire.
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== "redis-rest.test")
      throw new Error(`unexpected network call to ${url.host}`);
    redisCalls += 1;
    const commands = JSON.parse(String(init?.body)) as [string, string][];
    return Response.json(
      commands.map(([command, key]) => {
        const count = redisWindows.get(key) ?? 0;
        if (command === "zcard") return { result: count };
        if (command === "zadd") redisWindows.set(key, count + 1);
        return { result: 1 };
      }),
    );
  }) as typeof fetch;

  const database = await import("@elizaos/cloud-shared/db/client");
  pg = () => database.getPgliteClientForTests();
  closeDatabase = database.closeDatabaseConnectionsForTests;
  const exec = (query: string) => pg().exec(query);
  const { createBillingSnapshotFixture } = await import(
    "../../shared/src/db/repositories/account-billing-snapshot-test-fixture"
  );
  await createBillingSnapshotFixture(exec, "");
  // The billing fixture's users table only carries ids; auth reads the rest.
  const { getTableConfig } = await import("drizzle-orm/pg-core");
  const { users, userModerationStatus } = await import(
    "@elizaos/cloud-shared/db/schemas"
  );
  await exec("DROP TABLE users CASCADE");
  for (const table of [users, userModerationStatus]) {
    const config = getTableConfig(table);
    await exec(
      `CREATE TABLE "${config.name}" (${config.columns
        .map(
          (column) =>
            `"${column.name}" ${"enumValues" in column && column.enumValues ? "text" : column.getSQLType()}`,
        )
        .join(", ")})`,
    );
  }
  await exec(`INSERT INTO organizations(id, credit_balance, balance_revision, balance_decrease_revision, settings, is_active, auto_top_up_enabled, account_lifecycle_state) VALUES
    ('${ORG}', '0', 1, 0, '{}', true, false, 'active'),
    ('${SECOND_ORG}', '0', 1, 0, '{}', true, false, 'active')`);
  await exec(`INSERT INTO users(id, organization_id, is_active, steward_user_id, role) VALUES
    ('${USER}', '${ORG}', true, 'subject_speech_1', 'owner'),
    ('${SECOND_USER}', '${SECOND_ORG}', true, 'subject_speech_2', 'owner')`);
  const seed = async (
    name: keyof typeof keys,
    values: {
      organizationId?: string;
      userId?: string;
      rateLimit?: number;
      active?: boolean;
      deleted?: boolean;
    } = {},
  ) => {
    const id = crypto.randomUUID();
    const raw = `eliza_speech_rate_${name}_${id}`;
    await exec(`INSERT INTO api_keys(id, name, key_hash, key_prefix, organization_id, user_id, rate_limit, is_active, deleted_at, usage_count, created_at, updated_at, user_created) VALUES
      ('${id}', '${name}', '${createHash("sha256").update(raw).digest("hex")}', 'eliza_sp', '${values.organizationId ?? ORG}', '${values.userId ?? USER}', ${values.rateLimit ?? 1000}, ${values.active ?? true}, ${values.deleted ? "now()" : "NULL"}, 0, now(), now(), true)`);
    keys[name] = { id, raw };
  };
  await seed("plain");
  // The pay-as-you-go tiers sum to 195 requests per minute, so 1 binds.
  await seed("capped", { rateLimit: 1 });
  await seed("inactive", { active: false });
  await seed("deleted", { deleted: true });
  // Authenticates through its user in ORG while the row belongs to another org.
  await seed("foreign", { organizationId: FIXTURE_ORG });
  await seed("second", { organizationId: SECOND_ORG, userId: SECOND_USER });

  const [
    { runWithCloudBindingsAsync },
    { withOrganizationPolicyReadAdmission },
    { requireOrganizationRateTier },
    { personalSharedAgent },
    { sharedElizaRuntimeExecution, sharedRuntimeRoomKey },
  ] = await Promise.all([
    import("@elizaos/cloud-shared/lib/runtime/cloud-bindings"),
    import("@elizaos/cloud-shared/lib/services/organization-policy-admission"),
    import("@elizaos/cloud-shared/lib/services/organization-quota-policy"),
    import(
      "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-agent"
    ),
    import(
      "@elizaos/cloud-shared/lib/services/shared-runtime/shared-runtime-chat"
    ),
  ]);
  const agent = personalSharedAgent({ userId: USER, organizationId: ORG });
  personalMedia = (executionCtx) =>
    sharedElizaRuntimeExecution(
      agent,
      sharedRuntimeRoomKey(agent.id, agent.id),
      undefined,
      {},
      "platform",
      executionCtx,
    ).media;
  runWithBindings = runWithCloudBindingsAsync;
  strictRpm = await withOrganizationPolicyReadAdmission(
    ORG,
    undefined,
    async (policy) => requireOrganizationRateTier(policy).strictRpm,
  );
  routes = {
    stt: (await import("../v1/voice/stt/route")).default as unknown as Hono,
    tts: (await import("../v1/voice/tts/route")).default as unknown as Hono,
  };
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await closeDatabase?.();
});

beforeEach(() => {
  gateCalls.length = 0;
  gateWindows.clear();
  gateDown = false;
  redisCalls = 0;
  redisWindows.clear();
});

/**
 * Both requests stop at the first validation after auth (non-multipart STT,
 * empty TTS text), so an admitted caller gets 400 with no provider work.
 */
async function speak(route: "stt" | "tts", rawKey: string) {
  const pending: Promise<unknown>[] = [];
  const response = await runWithBindings({ INFERENCE_ADMISSION_GATES }, () =>
    Promise.resolve(
      routes[route].request(
        "http://cloud.test/",
        route === "stt"
          ? {
              method: "POST",
              headers: {
                authorization: `Bearer ${rawKey}`,
                "content-type": "text/plain",
              },
              body: "not multipart",
            }
          : {
              method: "POST",
              headers: {
                authorization: `Bearer ${rawKey}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ text: "" }),
            },
        {},
        {
          waitUntil: (promise: Promise<unknown>) => pending.push(promise),
          passThroughOnException: () => undefined,
          props: {},
        },
      ),
    ),
  );
  await Promise.allSettled(pending);
  return response;
}

/**
 * Personal-agent media from a Worker turn (with an execution context) or from
 * a turn without one. The limiter runs first and audio is refused right after
 * it, so an admitted request does no provider work.
 */
async function generatePersonalMedia(
  workerTurn: boolean,
  mediaType: "image" | "audio",
) {
  const pending: Promise<unknown>[] = [];
  try {
    return await runWithBindings(
      { INFERENCE_ADMISSION_GATES, BLOB: {}, FAL_KEY: "fal-key-unused" },
      async () => {
        const port = personalMedia(
          workerTurn
            ? { waitUntil: (promise) => pending.push(promise) }
            : undefined,
        );
        if (!port) throw new Error("Personal media port is not configured");
        return await port.generateMedia({
          mediaType,
          prompt: "a lighthouse at dusk",
        });
      },
    );
  } finally {
    await Promise.allSettled(pending);
  }
}

describe("Worker speech rate limit without an admission snapshot", () => {
  test("STT and TTS take one Durable Object decision and no Redis round trip", async () => {
    const stt = await speak("stt", keys.plain.raw);
    const tts = await speak("tts", keys.plain.raw);

    expect(stt.status).toBe(400);
    expect(tts.status).toBe(400);
    expect(redisCalls).toBe(0);
    expect(gateCalls).toHaveLength(2);
    for (const call of gateCalls) {
      expect(call.name).toBe(`rate-limit:v2:${ORG}`);
      expect(call.path).toBe("/rate-limit");
      expect(call.body).toMatchObject({
        endpointType: "strict",
        maxRequests: strictRpm,
        windowMs: 60_000,
      });
      expect(call.body.apiKey).toBeUndefined();
    }
    const timing = stt.headers.get("Server-Timing") ?? "";
    expect(timing).toMatch(/(^|, )upload;dur=\d/);
    expect(timing).toMatch(/(^|, )auth;dur=\d/);
  });

  test("a request over the key's cap is refused before provider work", async () => {
    expect((await speak("stt", keys.capped.raw)).status).toBe(400);
    const refused = await speak("tts", keys.capped.raw);

    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "rate_limit_exceeded" });
    expect(gateCalls.map((call) => call.body.apiKey)).toEqual([
      { id: keys.capped.id, maxRequests: 1 },
      { id: keys.capped.id, maxRequests: 1 },
    ]);
  });

  test("an inactive or deleted key is refused before any limiter work", async () => {
    for (const [key, status] of [
      [keys.inactive, 403],
      [keys.deleted, 401],
    ] as const) {
      expect((await speak("stt", key.raw)).status).toBe(status);
      expect((await speak("tts", key.raw)).status).toBe(status);
    }
    expect(gateCalls).toHaveLength(0);
    expect(redisCalls).toBe(0);
  });

  test("a key row owned by another organization fails closed", async () => {
    expect((await speak("stt", keys.foreign.raw)).status).toBe(503);
    expect((await speak("tts", keys.foreign.raw)).status).toBe(503);
    expect(gateCalls).toHaveLength(0);
    expect(redisCalls).toBe(0);
  });

  test("each organization is counted only in its own window", async () => {
    await speak("stt", keys.plain.raw);
    await speak("stt", keys.second.raw);

    expect(gateCalls.map((call) => call.name)).toEqual([
      `rate-limit:v2:${ORG}`,
      `rate-limit:v2:${SECOND_ORG}`,
    ]);
  });

  test("an unreachable limiter refuses the request", async () => {
    gateDown = true;
    expect((await speak("stt", keys.plain.raw)).status).toBe(503);
    expect((await speak("tts", keys.plain.raw)).status).toBe(503);
    expect(redisCalls).toBe(0);
  });
});

describe("Personal-agent media in the organization's strict window", () => {
  test("Worker turn media and the speech routes count in one window", async () => {
    for (let sent = 1; sent < strictRpm; sent += 1)
      expect((await speak("stt", keys.plain.raw)).status).toBe(400);
    // The media takes the last request of the window.
    await expect(generatePersonalMedia(true, "audio")).rejects.toThrow(
      "Personal Shared media generation does not support audio",
    );
    expect((await speak("tts", keys.plain.raw)).status).toBe(429);
    await expect(generatePersonalMedia(true, "image")).rejects.toThrow(
      "Image generation rate limit exceeded.",
    );

    expect(redisCalls).toBe(0);
    expect(gateCalls).toHaveLength(strictRpm + 2);
    for (const call of gateCalls)
      expect(call).toMatchObject({
        name: `rate-limit:v2:${ORG}`,
        body: { endpointType: "strict", maxRequests: strictRpm },
      });
  });

  test("media without an execution context keeps the Redis window", async () => {
    await expect(generatePersonalMedia(false, "audio")).rejects.toThrow(
      "Personal Shared media generation does not support audio",
    );

    expect(gateCalls).toHaveLength(0);
    expect(redisCalls).toBe(1);
    expect([...redisWindows]).toEqual([
      [expect.stringMatching(new RegExp(`:ratelimit:org:${ORG}:strict$`)), 1],
    ]);
  });
});
