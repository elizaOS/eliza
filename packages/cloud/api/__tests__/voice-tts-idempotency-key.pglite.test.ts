/**
 * `POST /api/v1/voice/tts` replays a credit reservation for a retried
 * `Idempotency-Key` (#16425). The key names one utterance: a second utterance
 * sent under the same key is a new paid request, while a retry of the same
 * utterance still replays. An ElevenLabs rejection releases the reservation.
 * A caller abort reaches moderation and the speech upstreams: before admission
 * it gets no reservation, before dispatch it releases the reservation, after
 * dispatch it keeps the unknown charge. A released reservation frees its key,
 * so a keyed retry pays once. A WAV synthesis that ends while its dispatch
 * mark is pending settles on the mark, also under a Worker waitUntil: a commit
 * keeps the unknown charge, a refusal releases. The settlement log reports the
 * settlement that ran, once it has succeeded, and a failed one is logged as
 * failed. Two requests in flight under one key pay once, in either order. A
 * billing failure never escapes as an unhandled rejection. The WAV hard
 * deadline still answers 500.
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
import * as cartesiaSynthesis from "../v1/voice/tts/cartesia-synthesis";

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
/** Runs once admission has reserved; the route continues when it settles. */
let afterAdmission: (() => void | Promise<void>) | undefined;
/** The gate's dispatch acknowledgement; local admission has none. */
let acknowledgeDispatch: (() => Promise<void>) | undefined;
/** A short WAV synthesis deadline in place of the 15 s default. */
let wavDeadlineMs: number | undefined;
const { admitFlatGenerativeOperation } = generativeRouteAuth;
const { synthesizeCartesiaWav } = cartesiaSynthesis;

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
  admitFlatGenerativeOperation: async (
    params: Parameters<typeof admitFlatGenerativeOperation>[0],
  ) => {
    // Worker-mode requests also reserve through the local credits lane.
    const admission = await admitFlatGenerativeOperation({
      ...params,
      c: {} as typeof params.c,
    });
    await afterAdmission?.();
    return { ...admission, markProviderDispatched: acknowledgeDispatch };
  },
}));
mock.module("../v1/voice/tts/cartesia-synthesis", () => ({
  ...cartesiaSynthesis,
  synthesizeCartesiaWav: (args: Parameters<typeof synthesizeCartesiaWav>[0]) =>
    synthesizeCartesiaWav({
      ...args,
      timeoutMs: wavDeadlineMs ?? args.timeoutMs,
    }),
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
const { creditsService } = await import(
  "@elizaos/cloud-shared/lib/services/credits"
);
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
  afterAdmission = undefined;
  acknowledgeDispatch = undefined;
  wavDeadlineMs = undefined;
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
 * returns audio. `hold` accepts the request and sends no audio, so only a
 * cancellation or a deadline can end it. Resolves once a held request is in
 * flight.
 */
function stubSpeechUpstream(mode: "answer" | "hold"): Promise<void> {
  let accepted!: () => void;
  const inFlight = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  globalThis.fetch = (async (input, init) => {
    const signal = init?.signal ?? undefined;
    // Like fetch, an aborted signal rejects before any request is sent.
    signal?.throwIfAborted();
    upstream.urls.push(String(input));
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

/** Every ledger row of the organization: reservations, refunds and charges. */
async function ledgerRows(): Promise<number> {
  const { rows } = await pg().query<{ count: string }>(
    "SELECT count(*)::text AS count FROM credit_transactions WHERE organization_id=$1",
    [orgId],
  );
  return Number(rows[0]?.count);
}

/** Requests that reached ElevenLabs, Cartesia or Kokoro in this test. */
const providerRequests = () => providerCalls.length + upstream.urls.length;

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

test("an ElevenLabs rejection releases the reservation and a keyed retry pays once; a failure without a status stays charged", async () => {
  const rejected = "Please confirm the table for two.";
  const rejectedKey = `rejected-${randomUUID()}`;
  providerFailures.set(rejected, new ElevenLabs.UnprocessableEntityError({}));
  const beforeRejection = await balance();
  await speak(rejected, rejectedKey, {}, 500);
  expect(await balance()).toBeCloseTo(beforeRejection, 6);

  // The released reservation paid for nothing: a retry under its key that
  // gets audio is charged once.
  providerFailures.delete(rejected);
  await speak(rejected, rejectedKey);
  const afterRetry = await balance();
  expect(afterRetry).toBeCloseTo(
    beforeRejection - rejected.length * COST_PER_CHAR,
    6,
  );

  const timedOut = "Your order is on its way.";
  providerFailures.set(timedOut, new ElevenLabsTimeoutError("timed out"));
  await speak(timedOut, `timeout-${randomUUID()}`, {}, 500);
  expect(await balance()).toBeCloseTo(
    afterRetry - timedOut.length * COST_PER_CHAR,
    6,
  );
  expect(providerCalls.slice(-3)).toEqual([rejected, rejected, timedOut]);
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
  "a caller abort before %s dispatch calls no provider and charges nothing; a keyed retry pays once and its replay is free",
  async (lane, identity, env) => {
    for (const abortAt of ["pricing", "admission"] as const) {
      const text = `Cancelled before ${lane} dispatch, at ${abortAt}.`;
      const key = `pre-dispatch-${randomUUID()}`;
      const before = await balance(),
        rows = await ledgerRows(),
        requests = providerRequests();
      const caller = new AbortController();
      if (abortAt === "pricing") duringPricing = () => caller.abort();
      else afterAdmission = () => caller.abort();
      stubSpeechUpstream("answer");

      await speak(text, key, identity, 499, { signal: caller.signal, env });
      duringPricing = undefined;
      afterAdmission = undefined;

      expect(providerRequests()).toBe(requests);
      expect(await openReservations()).toBe(0);
      expect(await balance()).toBeCloseTo(before, 6);
      const rowsAfterAbort = await ledgerRows();

      // The retry under the key synthesizes and pays once. Its own retry
      // replays that completed reservation for free.
      for (const charge of [text.length * COST_PER_CHAR, 0]) {
        const paid = await balance();
        stubSpeechUpstream("answer");
        const retry = await speak(text, key, identity, 200, { env });
        expect(retry.audio.byteLength).toBeGreaterThan(0);
        expect(await balance()).toBeCloseTo(paid - charge, 6);
      }
      expect(providerRequests()).toBe(requests + 2);
      // A caller gone before admission got no reservation at all. One that
      // left after admission had its reservation released.
      if (abortAt === "pricing") expect(rowsAfterAbort).toBe(rows);
    }
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

test.each([
  ["a caller abort", 499],
  ["the synthesis deadline", 500],
] as const)(
  "%s while the WAV dispatch mark is pending settles on the mark: a commit keeps the unknown charge, a refusal releases",
  async (ending, status) => {
    const text = "Your WAV reply ended during dispatch.";
    stubSpeechUpstream("answer");
    if (status === 500) wavDeadlineMs = 50;
    let routeFailed: (() => void) | undefined;
    const errorLog = spyOn(logger, "error").mockImplementation((message) => {
      if (message === "[Voice TTS API] Request failed") routeFailed?.();
    });
    const settlements: unknown[] = [];
    const warnLog = spyOn(logger, "warn").mockImplementation(
      (message, data) => {
        if (message === "[Voice TTS API] Settled failed paid synthesis")
          settlements.push(data);
      },
    );
    try {
      // A dispatch refused before the synthesis ends is released.
      let before = await balance();
      acknowledgeDispatch = async () => {
        throw new Error("synthetic dispatch refusal");
      };
      await speak(
        text,
        `refused-dispatch-${randomUUID()}`,
        { format: "wav" },
        502,
        { env: CARTESIA },
      );
      expect(await balance()).toBeCloseTo(before, 6);
      expect(await openReservations()).toBe(0);

      for (const outcome of ["commit", "refusal"] as const) {
        before = await balance();
        let marking!: () => void;
        const markingStarted = new Promise<void>((resolve) => {
          marking = resolve;
        });
        let finishMark!: () => void;
        const markFinished = new Promise<void>((resolve) => {
          finishMark = resolve;
        });
        acknowledgeDispatch = async () => {
          marking();
          await markFinished;
          // A refusal before any gate contact, like a stale policy check.
          if (outcome === "refusal")
            throw new Error("synthetic dispatch refusal");
        };
        const failed = new Promise<void>((resolve) => {
          routeFailed = resolve;
        });
        const caller = new AbortController();
        const ended = speak(
          text,
          `pending-${outcome}-${randomUUID()}`,
          { format: "wav" },
          status,
          { signal: caller.signal, env: CARTESIA },
        );
        await markingStarted;
        if (ending === "a caller abort") caller.abort();
        // The synthesis has failed while the mark is still in flight.
        await failed;
        finishMark();
        await ended;
        await new Promise((resolve) => setTimeout(resolve, 0));

        // A committed mark is durable at the gate: the outcome is unknown and
        // the estimate stays charged. A refused mark dispatched nothing: the
        // reservation is released.
        expect(await balance()).toBeCloseTo(
          outcome === "commit" ? before - text.length * COST_PER_CHAR : before,
          6,
        );
        expect(await openReservations()).toBe(0);
        expect(settlements.at(-1)).toMatchObject(
          outcome === "commit"
            ? {
                providerDispatchState: "possibly_dispatched",
                settlement: "unknown",
              }
            : {
                providerDispatchState: "not_dispatched",
                settlement: "released",
              },
        );
        // The upgrade after a late commit has an aborted signal, so no
        // provider request is sent.
        expect(upstream.urls).toEqual([]);
        expect(upstream.frames).toEqual([]);
      }
    } finally {
      errorLog.mockRestore();
      warnLog.mockRestore();
    }
  },
  10_000,
);

test("in a Worker, a caller abort while the WAV dispatch mark is pending answers at once and settles on the mark under waitUntil", async () => {
  const text = "Your WAV reply ended during dispatch in a Worker.";
  stubSpeechUpstream("answer");
  const settlements: unknown[] = [];
  const warnLog = spyOn(logger, "warn").mockImplementation((message, data) => {
    if (message === "[Voice TTS API] Settled failed paid synthesis")
      settlements.push(data);
  });
  try {
    for (const outcome of ["commit", "refusal"] as const) {
      const before = await balance(),
        logged = settlements.length;
      let marking!: () => void;
      const markingStarted = new Promise<void>((resolve) => {
        marking = resolve;
      });
      let finishMark!: () => void;
      const markFinished = new Promise<void>((resolve) => {
        finishMark = resolve;
      });
      acknowledgeDispatch = async () => {
        marking();
        await markFinished;
        if (outcome === "refusal")
          throw new Error("synthetic dispatch refusal");
      };
      const background: Promise<unknown>[] = [];
      const executionCtx = {
        waitUntil(task: Promise<unknown>) {
          background.push(task);
        },
        passThroughOnException() {},
        props: {},
      };
      const caller = new AbortController();
      const response = app.request(
        "/api/v1/voice/tts",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": `worker-pending-${outcome}-${randomUUID()}`,
          },
          body: JSON.stringify({ text, format: "wav" }),
          signal: caller.signal,
        },
        { NODE_ENV: "test", ...CARTESIA },
        executionCtx,
      );
      await markingStarted;
      caller.abort();

      // The Worker answers without waiting for the mark; the settlement waits.
      const answered = await Promise.race([
        response,
        new Promise<undefined>((resolve) => setTimeout(resolve, 2_000)),
      ]);
      expect(answered?.status).toBe(499);
      expect(await openReservations()).toBe(1);
      expect(settlements).toHaveLength(logged);

      finishMark();
      await Promise.all(background);
      expect(await openReservations()).toBe(0);
      expect(settlements).toHaveLength(logged + 1);
      expect(await balance()).toBeCloseTo(
        outcome === "commit" ? before - text.length * COST_PER_CHAR : before,
        6,
      );
      expect(settlements.at(-1)).toMatchObject(
        outcome === "commit"
          ? {
              providerDispatchState: "possibly_dispatched",
              settlement: "unknown",
            }
          : { providerDispatchState: "not_dispatched", settlement: "released" },
      );
      expect(upstream.urls).toEqual([]);
    }
  } finally {
    warnLog.mockRestore();
  }
}, 10_000);

test("the settlement log reports the settlement that ran, and only once it has succeeded", async () => {
  const text = "Please hold the table for four.";
  providerFailures.set(text, new ElevenLabs.UnprocessableEntityError({}));
  const before = await balance();
  const settlements: unknown[] = [];
  const warnLog = spyOn(logger, "warn").mockImplementation((message, data) => {
    if (message === "[Voice TTS API] Settled failed paid synthesis")
      settlements.push(data);
  });
  const reconcile = creditsService.reconcile.bind(creditsService);
  let release: Parameters<typeof reconcile>[0] | undefined;
  const settle = spyOn(creditsService, "reconcile").mockImplementationOnce(
    async (params) => {
      release = params;
      throw new Error("synthetic settlement failure");
    },
  );
  try {
    // A release that fails is not logged as settled.
    await speak(text, `unsettled-${randomUUID()}`, {}, 500);
    expect(release?.actualCost).toBe(0);
    expect(settlements).toEqual([]);
    expect(await openReservations()).toBe(1);

    // The provider refused after dispatch, so the reservation is released.
    await speak(text, `refused-${randomUUID()}`, {}, 500);
    expect(settlements).toEqual([
      expect.objectContaining({
        providerDispatchState: "possibly_dispatched",
        settlement: "released",
      }),
    ]);
  } finally {
    settle.mockRestore();
    warnLog.mockRestore();
    providerFailures.delete(text);
    // Settle the held reservation so later tests start with none open.
    if (release) await reconcile(release);
  }
  expect(await openReservations()).toBe(0);
  expect(await balance()).toBeCloseTo(before, 6);
});

/**
 * Waits for the detached billing after an audio response: the balance reaches
 * `expected` and no reservation stays open.
 */
async function billingSettlesAt(expected: number): Promise<number> {
  for (let i = 0; i < 200; i++) {
    if (
      Math.abs((await balance()) - expected) < 1e-6 &&
      (await openReservations()) === 0
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return await balance();
}

/** Holds the next admitted request until `resume`; resolves `admitted` first. */
function holdNextAdmission() {
  let admitted!: () => void;
  let resume!: () => void;
  const held = {
    admitted: new Promise<void>((resolve) => {
      admitted = resolve;
    }),
    resume: () => resume(),
  };
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  afterAdmission = async () => {
    afterAdmission = undefined;
    admitted();
    await resumed;
  };
  return held;
}

test("two requests in flight under one Idempotency-Key: whichever order, the one that synthesizes pays once", async () => {
  const text = "Your two requests share one utterance.";
  const cost = text.length * COST_PER_CHAR;
  const settlements: unknown[] = [];
  const warnLog = spyOn(logger, "warn").mockImplementation((message, data) => {
    if (message === "[Voice TTS API] Settled failed paid synthesis")
      settlements.push(data);
  });
  try {
    // B replays A's open reservation; A's caller leaves before dispatch and
    // A releases it; then B synthesizes.
    let before = await balance();
    let key = `two-in-flight-${randomUUID()}`;
    const callerA = new AbortController();
    const a = holdNextAdmission();
    const aDone = speak(text, key, {}, 499, { signal: callerA.signal });
    await a.admitted;
    const b = holdNextAdmission();
    const bDone = speak(text, key);
    await b.admitted;
    expect(await balance()).toBeCloseTo(before - cost, 6);
    callerA.abort();
    a.resume();
    await aDone;
    expect(await balance()).toBeCloseTo(before, 6);
    b.resume();
    await bDone;
    // B's audio is paid once, under a new reservation for the key.
    expect(await billingSettlesAt(before - cost)).toBeCloseTo(before - cost, 6);
    expect(await openReservations()).toBe(0);
    // A third request replays B's paid reservation for free.
    await speak(text, key);
    expect(await balance()).toBeCloseTo(before - cost, 6);
    expect(settlements.at(-1)).toMatchObject({ settlement: "released" });

    // B synthesizes and pays while A is held; A's late release moves nothing.
    before = await balance();
    key = `two-in-flight-${randomUUID()}`;
    const callerA2 = new AbortController();
    const a2 = holdNextAdmission();
    const a2Done = speak(text, key, {}, 499, { signal: callerA2.signal });
    await a2.admitted;
    await speak(text, key);
    expect(await balance()).toBeCloseTo(before - cost, 6);
    callerA2.abort();
    a2.resume();
    await a2Done;
    expect(await balance()).toBeCloseTo(before - cost, 6);
    expect(settlements.at(-1)).toMatchObject({
      providerDispatchState: "not_dispatched",
      settlement: "already_settled",
    });
  } finally {
    warnLog.mockRestore();
  }
});

test("a billing failure whose conservative settlement also fails stays observable and never escapes as an unhandled rejection", async () => {
  const text = "Your reply arrived during a billing outage.";
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  const errors: string[] = [];
  const errorLog = spyOn(logger, "error").mockImplementation((message) => {
    errors.push(String(message));
  });
  const reconcile = creditsService.reconcile.bind(creditsService);
  let held: Parameters<typeof reconcile>[0] | undefined;
  const outage = spyOn(creditsService, "reconcile").mockImplementation(
    async (params) => {
      held = params;
      throw new Error("synthetic billing outage");
    },
  );
  const before = await balance();
  try {
    const response = await app.request(
      "/api/v1/voice/tts",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `billing-outage-${randomUUID()}`,
        },
        body: JSON.stringify({ text }),
      },
      { NODE_ENV: "test" },
    );
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    for (let i = 0; i < 200; i++) {
      if (errors.includes("[Voice TTS API] Failed to create usage record"))
        break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toContain("[Voice TTS API] Conservative settlement failed");
    expect(errors).toContain("[Voice TTS API] Failed to create usage record");
    expect(rejections).toEqual([]);
  } finally {
    outage.mockRestore();
    errorLog.mockRestore();
    process.off("unhandledRejection", onRejection);
    // The audio was delivered: settle the held reservation at its charge.
    if (held) await reconcile(held);
  }
  expect(await openReservations()).toBe(0);
  expect(await balance()).toBeCloseTo(before - text.length * COST_PER_CHAR, 6);
});

test("in a Worker, a failed settlement of a failed synthesis is logged as failed, never as settled", async () => {
  const text = "Please hold the Worker table.";
  providerFailures.set(text, new ElevenLabs.UnprocessableEntityError({}));
  const settled: unknown[] = [];
  const failed: unknown[] = [];
  const warnLog = spyOn(logger, "warn").mockImplementation((message, data) => {
    if (message === "[Voice TTS API] Settled failed paid synthesis")
      settled.push(data);
  });
  const errorLog = spyOn(logger, "error").mockImplementation(
    (message, data) => {
      if (message === "[Voice TTS API] Failed paid synthesis settlement failed")
        failed.push(data);
    },
  );
  const reconcile = creditsService.reconcile.bind(creditsService);
  let release: Parameters<typeof reconcile>[0] | undefined;
  const settle = spyOn(creditsService, "reconcile").mockImplementationOnce(
    async (params) => {
      release = params;
      throw new Error("synthetic settlement failure");
    },
  );
  const before = await balance();
  const background: Promise<unknown>[] = [];
  try {
    const response = await app.request(
      "/api/v1/voice/tts",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `worker-unsettled-${randomUUID()}`,
        },
        body: JSON.stringify({ text }),
      },
      { NODE_ENV: "test" },
      {
        waitUntil(task: Promise<unknown>) {
          background.push(task);
        },
        passThroughOnException() {},
        props: {},
      },
    );
    expect(response.status).toBe(500);
    await Promise.all(background);
    expect(settled).toEqual([]);
    expect(failed).toEqual([expect.objectContaining({ errorType: "Error" })]);
    expect(await openReservations()).toBe(1);
  } finally {
    settle.mockRestore();
    warnLog.mockRestore();
    errorLog.mockRestore();
    providerFailures.delete(text);
    if (release) await reconcile(release);
  }
  expect(await openReservations()).toBe(0);
  expect(await balance()).toBeCloseTo(before, 6);
});

test("the WAV hard deadline still ends a silent synthesis with a 500 and keeps the unknown charge", async () => {
  const text = "Your WAV reply went silent.";
  const before = await balance();
  wavDeadlineMs = 50;
  const inFlight = stubSpeechUpstream("hold");

  const failed = await speak(
    text,
    `wav-deadline-${randomUUID()}`,
    { format: "wav" },
    500,
    { env: CARTESIA },
  );
  await inFlight;

  expect(JSON.parse(new TextDecoder().decode(failed.audio))).toEqual({
    error: "Failed to generate speech. Please try again.",
  });
  // The deadline cancels the socket stream.
  expect(upstream.frames).toContainEqual({
    context_id: "cloud-tts",
    cancel: true,
  });
  // Dispatched work has an unknown outcome: the estimate stays charged.
  expect(await balance()).toBeCloseTo(before - text.length * COST_PER_CHAR, 6);
  expect(await openReservations()).toBe(0);
}, 10_000);

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
