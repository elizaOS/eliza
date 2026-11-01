/**
 * `POST /api/v1/voice/tts` replays a credit reservation for a retried
 * `Idempotency-Key` (#16425). The key names one utterance: a second utterance
 * sent under the same key is a new paid request, while a retry of the same
 * utterance still replays. An ElevenLabs rejection releases the reservation.
 * A caller abort reaches moderation and the speech upstreams: before dispatch
 * it releases the reservation, after dispatch it keeps the unknown charge.
 * Real credits service on PGlite; auth, pricing,
 * content safety, the ElevenLabs client, the Cartesia and Kokoro upstreams,
 * the first-line cache and usage records are replaced.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  mock,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import { getEventListeners } from "node:events";
import { ElevenLabs, ElevenLabsTimeoutError } from "@elevenlabs/elevenlabs-js";
import { runWithCloudBindingsAsync } from "@elizaos/cloud-shared/lib/runtime/cloud-bindings";
import * as aiPricing from "@elizaos/cloud-shared/lib/services/ai-pricing";
import * as elevenlabs from "@elizaos/cloud-shared/lib/services/elevenlabs";
import * as firstLineCache from "@elizaos/cloud-shared/lib/services/tts-first-line-cache";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { Hono } from "hono";
import * as generativeRouteAuth from "../src/lib/generative-route-auth";

const phaseRows: Array<Record<string, unknown>> = [];
const phaseLog = spyOn(logger, "audit").mockImplementation((name, data) => {
  if (name === "[CloudSpeech] phase timing")
    phaseRows.push(data as Record<string, unknown>);
});
let authCalls = 0;
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV = "test";
setDefaultTimeout(60_000);

const orgId = randomUUID();
const userId = randomUUID();
const providerCalls: string[] = [];
const providerFailures = new Map<string, Error>();
const COST_PER_CHAR = 0.001;
let moderate: ((signal?: AbortSignal) => Promise<unknown>) | undefined;
let duringPricing: (() => void) | undefined;

mock.module("@/api-app/lib/generative-route-auth", () => ({
  ...generativeRouteAuth,
  requireGenerativeRouteCaller: async () => {
    authCalls++;
    return {
      user: { id: userId, organization_id: orgId },
      apiKeyId: null,
      admissionSnapshot: undefined,
      credential: undefined,
    };
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/content-safety", () => ({
  contentSafetyService: {
    assertSafeForPublicUse: async (_input: unknown, signal?: AbortSignal) =>
      moderate ? moderate(signal) : {},
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/ai-pricing", () => ({
  ...aiPricing,
  calculateTTSCostFromCatalog: async ({
    characterCount,
  }: {
    characterCount: number;
  }) => {
    duringPricing?.();
    return {
      totalCost: characterCount * COST_PER_CHAR,
      baseTotalCost: characterCount * COST_PER_CHAR * 0.8,
      platformMarkup: characterCount * COST_PER_CHAR * 0.2,
    };
  },
}));
mock.module("@elizaos/cloud-shared/lib/services/elevenlabs", () => ({
  ...elevenlabs,
  getElevenLabsService: () => ({
    textToSpeech: async ({ text }: { text: string }) => {
      providerCalls.push(text);
      const failure = providerFailures.get(text);
      if (failure) throw failure;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([0xff, 0xfb, 0x90, 0x00]));
          controller.close();
        },
      });
    },
  }),
}));
mock.module("@elizaos/cloud-shared/lib/services/tts-first-line-cache", () => ({
  ...firstLineCache,
  getCloudFirstLineCacheService: () => ({
    get: async () => null,
    put: async () => undefined,
  }),
}));
mock.module("@elizaos/cloud-shared/lib/services/usage", () => ({
  usageService: { create: async () => ({}) },
}));

const { closeDatabaseConnectionsForTests, getPgliteClientForTests, dbWrite } =
  await import("@elizaos/cloud-shared/db/client");
const {
  organizations,
  users,
  creditTransactions,
  billingSubscriptions,
  organizationSubscriptionAuthorities,
  orgRateLimitOverrides,
  organizationConfig,
  orgStorageQuota,
  organizationEntitlements,
  organizationPaymentReversalHolds,
  autoTopUpAttempts,
} = await import("@elizaos/cloud-shared/db/schemas");
const { default: ttsRoute } = await import("../v1/voice/tts/route");

const pg = () => getPgliteClientForTests();
const SEEDED_TABLES = new Set([
  "organizations",
  "users",
  "credit_transactions",
  "billing_subscriptions",
  "organization_subscription_authorities",
  "org_rate_limit_overrides",
  "organization_config",
  "org_storage_quota",
  "organization_entitlements",
  "organization_payment_reversal_holds",
  "auto_top_up_attempts",
]);
const app = new Hono();
app.route("/api/v1/voice/tts", ttsRoute);

beforeAll(async () => {
  await dbWrite.execute("SELECT 1");
  const empty = generateDrizzleJson({});
  for (const statement of await generateMigration(
    empty,
    generateDrizzleJson(
      {
        organizations,
        users,
        creditTransactions,
        billingSubscriptions,
        organizationSubscriptionAuthorities,
        orgRateLimitOverrides,
        organizationConfig,
        orgStorageQuota,
        organizationPaymentReversalHolds,
        autoTopUpAttempts,
      },
      empty.id,
    ),
  )) {
    // Keys into tables outside this slice of the schema are not created.
    const foreignKey = statement.match(/REFERENCES "([a-z_]+)"/);
    if (foreignKey && !SEEDED_TABLES.has(foreignKey[1])) continue;
    await pg().exec(statement.replaceAll('"public".', ""));
  }
  const { getTableConfig } = await import("drizzle-orm/pg-core");
  await pg().exec(
    `CREATE TABLE organization_entitlements (${getTableConfig(
      organizationEntitlements,
    )
      .columns.map((column) => `"${column.name}" ${column.getSQLType()}`)
      .join(",")})`,
  );
  await pg().query(
    "INSERT INTO organizations(id,name,slug,credit_balance) VALUES ($1,'Speaker',$2,'10')",
    [orgId, `speaker-${orgId}`],
  );
  await pg().query(
    "INSERT INTO users(id,organization_id,steward_user_id,role) VALUES ($1,$2,$3,'owner')",
    [userId, orgId, `subject_${userId}`],
  );
  await pg().query(
    "INSERT INTO organization_subscription_authorities(organization_id,state,policy_generation) VALUES ($1,'none',1)",
    [orgId],
  );
});
const realFetch = globalThis.fetch;
/** Requests and socket frames seen by the stubbed Cartesia and Kokoro upstreams. */
const upstream = {
  urls: [] as string[],
  signals: [] as (AbortSignal | undefined)[],
  frames: [] as Record<string, unknown>[],
};
beforeEach(() => {
  moderate = undefined;
  duringPricing = undefined;
  globalThis.fetch = realFetch;
  upstream.urls.length = 0;
  upstream.signals.length = 0;
  upstream.frames.length = 0;
});
afterAll(async () => {
  phaseLog.mockRestore();
  globalThis.fetch = realFetch;
  await closeDatabaseConnectionsForTests();
});

/**
 * Stub the Cartesia REST, Cartesia WebSocket and Kokoro upstreams. `answer`
 * returns audio. `hold` accepts the request and sends no audio, so only the
 * request signal can end it. Resolves once a held request is in flight.
 */
function stubSpeechUpstream(mode: "answer" | "hold"): Promise<void> {
  let accepted!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  globalThis.fetch = (async (input, init) => {
    upstream.urls.push(String(input));
    const signal = init?.signal ?? undefined;
    upstream.signals.push(signal);
    if (new Headers(init?.headers).get("Upgrade") === "websocket") {
      const messageListeners: Array<(event: { data: string }) => void> = [];
      const webSocket = {
        accept() {},
        close() {},
        addEventListener(
          type: string,
          listener: (event: { data: string }) => void,
        ) {
          if (type === "message") messageListeners.push(listener);
        },
        send(data: string) {
          const frame = JSON.parse(data) as Record<string, unknown>;
          upstream.frames.push(frame);
          if (frame.transcript === undefined) return;
          if (mode === "hold") return accepted();
          for (const reply of [
            { type: "chunk", context_id: frame.context_id, data: "AAABAA==" },
            { type: "done", context_id: frame.context_id },
          ])
            queueMicrotask(() => {
              for (const listener of messageListeners)
                listener({ data: JSON.stringify(reply) });
            });
        },
      };
      return { status: 101, webSocket } as unknown as Response;
    }
    if (mode === "answer")
      return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), {
        headers: { "Content-Type": "audio/mpeg" },
      });
    accepted();
    return new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
  }) as typeof fetch;
  return inFlight;
}

/** Reservations still awaiting settlement; release refunds are separate rows. */
async function openReservations(): Promise<number> {
  const { rows } = await pg().query<{ open: string }>(
    "SELECT count(*)::text AS open FROM credit_transactions WHERE organization_id=$1 AND type='debit' AND metadata->>'type'='reservation' AND settled_at IS NULL",
    [orgId],
  );
  return Number(rows[0]?.open);
}

async function speak(
  text: string,
  idempotencyKey: string,
  identity: { voiceId?: string; modelId?: string; format?: "wav" } = {},
  expectedStatus = 200,
  caller: { signal?: AbortSignal; env?: Record<string, string> } = {},
) {
  const response = await app.request(
    "/api/v1/voice/tts",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ text, ...identity }),
      signal: caller.signal,
    },
    { NODE_ENV: "test", ...caller.env },
  );
  if (response.status !== expectedStatus)
    throw new Error(`tts ${response.status}: ${await response.text()}`);
  const spoken = {
    headers: response.headers,
    audio: new Uint8Array(await response.arrayBuffer()),
  };
  // A failed request settles before it responds.
  if (expectedStatus !== 200) return spoken;
  // Settlement runs after the audio response; wait for every reservation to settle.
  for (let i = 0; i < 200; i++) {
    if ((await openReservations()) === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return spoken;
}

async function balance(): Promise<number> {
  const { rows } = await pg().query<{ credit_balance: string }>(
    "SELECT credit_balance FROM organizations WHERE id=$1",
    [orgId],
  );
  return Number(rows[0]?.credit_balance);
}

test("one Idempotency-Key pays for one utterance: a different text is charged, the same text replays", async () => {
  const key = `utterance-${randomUUID()}`;
  const first = "Your table is booked for seven.";
  const second =
    "Your table is booked for seven, and the kitchen closes at ten, so please arrive on time.";

  await speak(first, key);
  const afterFirst = await balance();
  expect(afterFirst).toBeCloseTo(10 - first.length * COST_PER_CHAR, 6);

  await speak(second, key);
  expect(providerCalls).toEqual([first, second]);
  expect(await balance()).toBeCloseTo(
    afterFirst - second.length * COST_PER_CHAR,
    6,
  );

  // A retry of the first utterance under its key replays the paid reservation.
  const beforeRetry = await balance();
  await speak(first, key);
  expect(providerCalls).toHaveLength(3);
  expect(await balance()).toBeCloseTo(beforeRetry, 6);

  // The direct browser request omits the default voice and model. Its cloud
  // proxy fallback fills both compatibility defaults. They are the same
  // logical utterance and must replay one reservation after an ambiguous
  // direct response instead of charging again.
  const fallbackKey = `fallback-${randomUUID()}`;
  const fallbackText = "Your driver will arrive in five minutes.";
  await speak(fallbackText, fallbackKey);
  const afterDirect = await balance();
  expect(afterDirect).toBeCloseTo(
    beforeRetry - fallbackText.length * COST_PER_CHAR,
    6,
  );

  await speak(fallbackText, fallbackKey, {
    voiceId: "EXAVITQu4vr4xnSDxMaL",
    modelId: "eleven_flash_v2_5",
  });
  expect(providerCalls).toHaveLength(5);
  expect(await balance()).toBeCloseTo(afterDirect, 6);
});

test("an ElevenLabs rejection releases the reservation; a failure without a status stays charged", async () => {
  const rejected = "Please confirm the table for two.";
  providerFailures.set(rejected, new ElevenLabs.UnprocessableEntityError({}));
  const beforeRejection = await balance();
  await speak(rejected, `rejected-${randomUUID()}`, {}, 500);
  expect(await balance()).toBeCloseTo(beforeRejection, 6);

  const timedOut = "Your order is on its way.";
  providerFailures.set(timedOut, new ElevenLabsTimeoutError("timed out"));
  await speak(timedOut, `timeout-${randomUUID()}`, {}, 500);
  expect(await balance()).toBeCloseTo(
    beforeRejection - timedOut.length * COST_PER_CHAR,
    6,
  );
  expect(providerCalls.slice(-2)).toEqual([rejected, timedOut]);
});

test("speech timing preserves TTS provider and charged amount", async () => {
  const before = await balance(),
    calls = providerCalls.length,
    auth = authCalls;
  phaseRows.length = 0;
  const text = "Diagnostic speech fixture.";
  await speak(text, `speech-phase-${randomUUID()}`);
  expect(phaseRows.map((row) => row.phase)).toEqual(["json_decode"]);
  expect(authCalls - auth).toBe(1);
  expect(providerCalls.length - calls).toBe(1);
  expect(await balance()).toBeCloseTo(before - text.length * COST_PER_CHAR, 6);
});

test("malformed TTS JSON retains auth policy and never calls a provider", async () => {
  const before = await balance(),
    calls = providerCalls.length,
    auth = authCalls;
  phaseRows.length = 0;
  const response = await app.request(
    "/api/v1/voice/tts",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    },
    { NODE_ENV: "test" },
  );
  expect(response.status).toBe(400);
  expect(phaseRows.map((row) => row.phase)).toEqual(["json_decode"]);
  expect(authCalls - auth).toBe(1);
  expect(providerCalls.length).toBe(calls);
  expect(await balance()).toBeCloseTo(before, 6);
});

const CARTESIA = { CARTESIA_API_KEY: "local-test-only" };

test.each([
  ["ElevenLabs", {}, {}],
  ["Cartesia MP3", {}, CARTESIA],
  ["Cartesia WAV", { format: "wav" }, CARTESIA],
] as const)(
  "a caller abort before %s dispatch calls no provider and releases the reservation",
  async (lane, identity, env) => {
    const before = await balance(),
      calls = providerCalls.length;
    const caller = new AbortController();
    duringPricing = () => caller.abort();
    stubSpeechUpstream("answer");

    await speak(
      `Cancelled before ${lane} dispatch.`,
      `pre-dispatch-${randomUUID()}`,
      identity,
      499,
      { signal: caller.signal, env },
    );

    expect(providerCalls).toHaveLength(calls);
    expect(upstream.urls).toEqual([]);
    expect(await openReservations()).toBe(0);
    expect(await balance()).toBeCloseTo(before, 6);
  },
);

test.each([
  ["Cartesia MP3", {}],
  ["Cartesia WAV", { format: "wav" }],
] as const)(
  "a caller abort after %s dispatch keeps the unknown charge; a keyed retry replays it and synthesizes again",
  async (lane, identity) => {
    const text = `Your ${lane} reply was cut off.`;
    const key = `after-dispatch-${randomUUID()}`;
    const before = await balance();
    const caller = new AbortController();
    const inFlight = stubSpeechUpstream("hold");
    const aborted = speak(text, key, identity, 499, {
      signal: caller.signal,
      env: CARTESIA,
    });
    await inFlight;
    caller.abort();
    await aborted;

    // The abort reaches the provider request, and the socket gets a cancel frame.
    expect(upstream.signals[0]?.aborted).toBe(true);
    if (lane === "Cartesia WAV")
      expect(upstream.frames).toContainEqual({
        context_id: "cloud-tts",
        cancel: true,
      });
    // Dispatched work has an unknown outcome: the reservation stays charged.
    const afterAbort = await balance();
    expect(afterAbort).toBeCloseTo(before - text.length * COST_PER_CHAR, 6);
    expect(await openReservations()).toBe(0);

    stubSpeechUpstream("answer");
    const retry = await speak(text, key, identity, 200, { env: CARTESIA });

    expect(retry.headers.get("X-Eliza-TTS-Provider")).toBe("cartesia");
    expect(retry.audio.byteLength).toBeGreaterThan(0);
    // The retry synthesizes again instead of replaying a success, and replays
    // the reservation instead of charging twice.
    expect(upstream.urls).toHaveLength(2);
    expect(await balance()).toBeCloseTo(afterAbort, 6);
    // No abort listener outlives its request.
    expect(
      upstream.signals.map(
        (signal) => signal && getEventListeners(signal, "abort").length,
      ),
    ).toEqual([0, 0]);
  },
);

test("a caller abort during moderation stops the review and caches no late approval", async () => {
  const receipts = new Map<string, string>();
  const bindings = {
    CACHE_KV: {
      get: async (key: string) => receipts.get(key) ?? null,
      put: async (key: string, value: string) => {
        receipts.set(key, value);
      },
    },
  };
  const safetyReceipts = () =>
    [...receipts.keys()].filter((key) => key.startsWith("tts-safety:"));
  const approved = {
    allowed: true,
    skipped: false,
    flagged: false,
    mode: "enforce",
    issues: [],
  };
  const text = `A reply the caller left ${randomUUID()}.`;
  const before = await balance(),
    calls = providerCalls.length;
  let reviewSignal: AbortSignal | undefined;
  let reviewing!: () => void;
  const inReview = new Promise<void>((resolve) => {
    reviewing = resolve;
  });
  let approve!: () => void;
  const lateApproval = new Promise<void>((resolve) => {
    approve = resolve;
  });
  // Worst case: the moderation provider ignores the abort and approves late.
  moderate = async (signal) => {
    reviewSignal = signal;
    reviewing();
    await lateApproval;
    return approved;
  };
  const caller = new AbortController();
  const aborted = runWithCloudBindingsAsync(bindings, () =>
    speak(text, `moderation-${randomUUID()}`, {}, 499, {
      signal: caller.signal,
    }),
  );
  await inReview;
  caller.abort();
  approve();
  await aborted;

  expect(reviewSignal?.aborted).toBe(true);
  expect(safetyReceipts()).toEqual([]);
  expect(providerCalls).toHaveLength(calls);
  expect(await balance()).toBeCloseTo(before, 6);

  // The same text is reviewed again; an uninterrupted approval is cached.
  moderate = async () => approved;
  const repeat = await runWithCloudBindingsAsync(bindings, () =>
    speak(text, `moderation-${randomUUID()}`),
  );
  expect(repeat.headers.get("X-Eliza-TTS-Moderation")).toBe("reviewed");
  expect(safetyReceipts()).toHaveLength(1);
});

test("a caller abort reaches the free Kokoro upstream", async () => {
  const before = await balance();
  const caller = new AbortController();
  const inFlight = stubSpeechUpstream("hold");
  const aborted = speak(
    "A Kokoro reply.",
    `kokoro-${randomUUID()}`,
    { voiceId: "af_heart" },
    499,
    { signal: caller.signal, env: { KOKORO_TTS_URL: "https://kokoro.test" } },
  );
  await inFlight;
  caller.abort();
  await aborted;

  expect(upstream.urls).toEqual(["https://kokoro.test/api/tts"]);
  expect(upstream.signals[0]?.aborted).toBe(true);
  expect(await balance()).toBeCloseTo(before, 6);
});
