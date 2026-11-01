/**
 * Paid STT lanes bill the audio the provider transcribed. The container header
 * duration only sizes the reservation: a header can state a shorter length
 * than the audio it holds, and the provider transcribes all of it.
 */
import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { ApiError } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import * as aiBilling from "@elizaos/cloud-shared/lib/services/ai-billing";
import * as aiPricing from "@elizaos/cloud-shared/lib/services/ai-pricing";
import { InsufficientCreditsError } from "@elizaos/cloud-shared/lib/services/credits";
import * as usage from "@elizaos/cloud-shared/lib/services/usage";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";

import { Hono } from "hono";
import * as generativeRouteAuth from "../src/lib/generative-route-auth";

const phaseRows: Array<Record<string, unknown>> = [];
const phaseLog = spyOn(logger, "audit").mockImplementation((name, data) => {
  if (name === "[CloudSpeech] phase timing")
    phaseRows.push(data as Record<string, unknown>);
});
let authCalls = 0,
  billingCalls = 0,
  providerCalls = 0;
let admissionFailure: Error | undefined;
let authenticationFailure: Error | undefined;
let admissions = 0;
let duringAdmission: (() => void) | undefined;
const admittedRequestIds: string[] = [];
let dispatched = 0;
let settledUnknown = 0;
let settlementFailures = 0;
/** Every settlement the route started, in order, including failed ones. */
const settlementAttempts: string[] = [];
const reconciled: number[] = [];
const pricedSeconds: number[] = [];

/** While failures remain, a settlement attempt throws like a billing outage. */
function failSettlementAttempt(): void {
  if (settlementFailures === 0) return;
  settlementFailures--;
  throw new Error("synthetic settlement failure");
}

mock.module("@/api-app/lib/generative-route-auth", () => ({
  ...generativeRouteAuth,
  requireGenerativeRouteCaller: async () => {
    authCalls++;
    if (authenticationFailure) throw authenticationFailure;
    return {
      user: { id: "user-1", organization_id: "org-1" },
      apiKeyId: null,
      admissionSnapshot: null,
      credential: undefined,
    };
  },
  admitFlatGenerativeOperation: async (params: {
    context: { requestId: string };
    cost: { totalCost: number };
  }) => {
    admissions++;
    admittedRequestIds.push(params.context.requestId);
    duringAdmission?.();
    if (admissionFailure) throw admissionFailure;
    return {
      reservation: {
        reservedAmount: params.cost.totalCost,
        reconcile: async (actual: number) => {
          settlementAttempts.push(`reconcile(${actual})`);
          failSettlementAttempt();
          reconciled.push(actual);
        },
      },
      settleUnknown: async () => {
        settlementAttempts.push("unknown");
        failSettlementAttempt();
        settledUnknown++;
      },
      markProviderDispatched: async () => {
        dispatched++;
      },
    };
  },
}));

// One credit per transcribed second keeps the billed seconds visible.
mock.module("@elizaos/cloud-shared/lib/services/ai-pricing", () => ({
  ...aiPricing,
  calculateSTTCostFromCatalog: async (params: { durationSeconds: number }) => {
    pricedSeconds.push(params.durationSeconds);
    return {
      totalCost: params.durationSeconds,
      baseTotalCost: params.durationSeconds,
      platformMarkup: 0,
    };
  },
}));

mock.module("@elizaos/cloud-shared/lib/services/ai-billing", () => ({
  ...aiBilling,
  billFlatUsage: async (
    _context: unknown,
    cost: { totalCost: number; baseTotalCost: number; platformMarkup: number },
    reservation?: { reconcile(actual: number): Promise<void> },
  ) => {
    billingCalls++;
    await reservation?.reconcile(cost.totalCost);
    return { ...cost };
  },
}));

mock.module("@elizaos/cloud-shared/lib/services/usage", () => ({
  ...usage,
  usageService: { create: async () => undefined },
}));

const { default: sttApp } = await import("../v1/voice/stt/route");

/** 16 kHz mono 16-bit PCM WAV whose header and data both say one second. */
function oneSecondWav(): Uint8Array<ArrayBuffer> {
  const dataBytes = 16_000 * 2;
  const buf = new Uint8Array(new ArrayBuffer(44 + dataBytes));
  const view = new DataView(buf.buffer);
  const ascii = (offset: number, text: string) =>
    buf.set(new TextEncoder().encode(text), offset);
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  return buf;
}

/** Records this test's failed-transcription settlement logs. */
function captureSettlementLogs() {
  const logs = {
    warnings: [] as unknown[],
    failures: [] as unknown[],
  };
  const warn = spyOn(logger, "warn").mockImplementation((message, data) => {
    if (message === "[Voice STT API] Settled failed paid transcription")
      logs.warnings.push(data);
  });
  const error = spyOn(logger, "error").mockImplementation((message, data) => {
    if (
      message ===
        "[Voice STT API] Failed paid transcription settlement failed" ||
      message === "[Voice STT API] Failed-transcription settlement failed"
    )
      logs.failures.push(data);
  });
  restoreLogSpies.push(() => {
    warn.mockRestore();
    error.mockRestore();
  });
  return logs;
}
const restoreLogSpies: Array<() => void> = [];

const PROVIDER_SECONDS = 3600;
const realFetch = globalThis.fetch;

function stubProvider(host: string, payload: unknown): void {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      input instanceof Request ? input.url : new URL(String(input)).href;
    if (new URL(url).host === host) {
      providerCalls++;
      return Response.json(payload);
    }
    return realFetch(input, init);
  }) as typeof fetch;
}

async function transcribe(
  env: Record<string, string>,
  canonical = false,
): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const form = new FormData();
  form.append(
    "audio",
    new File([oneSecondWav()], "note.wav", { type: "audio/wav" }),
  );
  const response = await (canonical
    ? new Hono().route("/api/v1/voice/stt", sttApp)
    : sttApp
  ).request(
    canonical ? "http://cloud.test/api/v1/voice/stt" : "http://cloud.test/",
    { method: "POST", body: form },
    env,
    {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { duration_ms: number };
  expect(body).toMatchObject({ transcript: "hello" });
  // Every paid lane reports each step it ran; transcription equals the body.
  expect(
    (response.headers.get("Server-Timing") ?? "")
      .split(", ")
      .map((entry) => entry.split(";dur=")),
  ).toEqual([
    ["upload", expect.any(String)],
    ["auth", expect.any(String)],
    ["admission", expect.any(String)],
    ["transcription", String(body.duration_ms)],
  ]);
  await Promise.all(pending);
}

beforeEach(() => {
  phaseRows.length = 0;
  authCalls = 0;
  billingCalls = 0;
  providerCalls = 0;
  admissionFailure = undefined;
  authenticationFailure = undefined;
  admissions = 0;
  duringAdmission = undefined;
  admittedRequestIds.length = 0;
  dispatched = 0;
  settledUnknown = 0;
  settlementFailures = 0;
  settlementAttempts.length = 0;
  reconciled.length = 0;
  pricedSeconds.length = 0;
  for (const restore of restoreLogSpies.splice(0)) restore();
});

afterAll(() => {
  for (const restore of restoreLogSpies.splice(0)) restore();
  phaseLog.mockRestore();
  globalThis.fetch = realFetch;
});

test("Deepgram lane bills the duration Deepgram transcribed", async () => {
  stubProvider("api.deepgram.com", {
    metadata: { duration: PROVIDER_SECONDS },
    results: {
      channels: [{ alternatives: [{ transcript: "hello", words: [] }] }],
    },
  });

  await transcribe({
    VOICE_BATCH_STT_PROVIDER: "deepgram",
    DEEPGRAM_API_KEY: "dg-test",
  });

  expect(pricedSeconds[0]).toBe(1); // reservation from the header
  expect(reconciled).toEqual([PROVIDER_SECONDS]);
});

test("ElevenLabs lane bills the duration ElevenLabs transcribed", async () => {
  stubProvider("api.elevenlabs.io", {
    language_code: "eng",
    language_probability: 1,
    text: "hello",
    words: [{ text: "hello", start: 0, end: 0.5, type: "word", logprob: 0 }],
    audio_duration_secs: PROVIDER_SECONDS,
  });

  await transcribe({
    VOICE_BATCH_STT_PROVIDER: "elevenlabs",
    ELEVENLABS_API_KEY: "el-test",
  });

  expect(pricedSeconds[0]).toBe(1); // reservation from the header
  expect(reconciled).toEqual([PROVIDER_SECONDS]);
});

test("ElevenLabs lane falls back to the last word end", async () => {
  stubProvider("api.elevenlabs.io", {
    language_code: "eng",
    language_probability: 1,
    text: "hello",
    words: [
      {
        text: "hello",
        start: PROVIDER_SECONDS - 1,
        end: PROVIDER_SECONDS,
        type: "word",
        logprob: 0,
      },
    ],
  });

  await transcribe({
    VOICE_BATCH_STT_PROVIDER: "elevenlabs",
    ELEVENLABS_API_KEY: "el-test",
  });

  expect(reconciled).toEqual([PROVIDER_SECONDS]);
});

test("ElevenLabs lane never bills less than the file for a word end inside it", async () => {
  // A word end is where speech stops, not where the audio ends: trailing
  // silence after it was still sent and is billed by ElevenLabs.
  stubProvider("api.elevenlabs.io", {
    language_code: "eng",
    language_probability: 1,
    text: "hello",
    words: [{ text: "hello", start: 0, end: 0.4, type: "word", logprob: 0 }],
  });

  await transcribe({
    VOICE_BATCH_STT_PROVIDER: "elevenlabs",
    ELEVENLABS_API_KEY: "el-test",
  });

  expect(reconciled).toEqual([1]);
});

// The ElevenLabs SDK error carries the HTTP status: a rejection releases the
// reservation, while a failure without a status keeps it as possibly billed.
// The settlement log names the settlement that ran.
test.each([
  ["rejected request", 422, "synthetic rejection", 500, [0], 0, "released"],
  [
    "trial-tier refusal",
    403,
    "Not available on the trial tier",
    402,
    [0],
    0,
    "released",
  ],
  ["transport failure", undefined, "", 500, [], 1, "unknown"],
] as const)(
  "ElevenLabs lane settles a %s",
  async (_label, status, message, expected, released, unknown, settlement) => {
    const settled = captureSettlementLogs();
    globalThis.fetch = (async (input) => {
      const host = new URL(input instanceof Request ? input.url : String(input))
        .host;
      if (host !== "api.elevenlabs.io")
        throw Error("Unexpected external provider dispatch");
      if (status === undefined)
        throw new TypeError("synthetic transport failure");
      return Response.json({ detail: { message } }, { status });
    }) as typeof fetch;
    const form = new FormData();
    form.append(
      "audio",
      new File([oneSecondWav()], "note.wav", { type: "audio/wav" }),
    );
    const response = await sttApp.request(
      "http://cloud.test/",
      { method: "POST", body: form },
      { VOICE_BATCH_STT_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "el-test" },
    );

    expect(response.status).toBe(expected);
    expect(dispatched).toBe(1);
    expect(reconciled).toEqual([...released]);
    expect(settledUnknown).toBe(unknown);
    expect(settled.warnings).toEqual([
      expect.objectContaining({
        providerDispatchState: "possibly_dispatched",
        settlement,
      }),
    ]);
  },
);

test("a Cartesia refusal after dispatch is released and logged as released", async () => {
  const settled = captureSettlementLogs();
  globalThis.fetch = (async () => {
    providerCalls++;
    return Response.json({ error: "unsupported audio" }, { status: 422 });
  }) as unknown as typeof fetch;
  const response = await transcribeWithCartesia(
    new AbortController().signal,
    "2000",
  );

  expect(response.status).toBe(502);
  expect(dispatched).toBe(1);
  expect(reconciled).toEqual([0]);
  expect(settledUnknown).toBe(0);
  expect(settled.warnings).toEqual([
    expect.objectContaining({
      provider: "cartesia",
      providerDispatchState: "possibly_dispatched",
      settlement: "released",
    }),
  ]);
});

test("in a Worker, a failed settlement of a failed transcription is logged as failed, never as settled", async () => {
  const settled = captureSettlementLogs();
  settlementFailures = 1;
  globalThis.fetch = (async () =>
    Response.json(
      { detail: { message: "synthetic rejection" } },
      { status: 422 },
    )) as typeof fetch;
  const form = new FormData();
  form.append(
    "audio",
    new File([oneSecondWav()], "note.wav", { type: "audio/wav" }),
  );
  const pending: Promise<unknown>[] = [];
  const response = await sttApp.request(
    "http://cloud.test/",
    { method: "POST", body: form },
    { VOICE_BATCH_STT_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "el-test" },
    {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    },
  );
  expect(response.status).toBe(500);
  await Promise.all(pending);

  expect(settlementFailures).toBe(0);
  expect(reconciled).toEqual([]);
  expect(settled.warnings).toEqual([]);
  expect(settled.failures).toEqual([
    expect.objectContaining({ errorType: "Error" }),
  ]);
});

test("a response without a duration bills the header estimate", async () => {
  stubProvider("api.deepgram.com", {
    results: {
      channels: [{ alternatives: [{ transcript: "hello", words: [] }] }],
    },
  });

  await transcribe({
    VOICE_BATCH_STT_PROVIDER: "deepgram",
    DEEPGRAM_API_KEY: "dg-test",
  });

  expect(reconciled).toEqual([1]);
});

// Drive the existing route boundary: provider choice does not change auth or money policy.
test.each([
  ["explicit Cartesia", ["cartesia"], 200],
  ["absent provider keeps ElevenLabs default", [], 200],
  ["blank", [""], 400],
  ["case variant", ["Cartesia"], 400],
  ["whitespace", [" cartesia "], 400],
  ["other provider", ["whisper"], 400],
  ["duplicate", ["cartesia", "cartesia"], 400],
  ["file", [new File(["cartesia"], "provider.txt")], 400],
] as const)("request provider: %s", async (_label, providers, expected) => {
  const calls: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const host = new URL(input instanceof Request ? input.url : String(input))
      .host;
    calls.push(host);
    if (host === "api.cartesia.ai") {
      const body = init?.body;
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get("model")).toBe("ink-whisper");
      return Response.json({ text: "hello", duration: 1 });
    }
    if (host === "api.elevenlabs.io")
      return Response.json({
        text: "hello",
        audio_duration_secs: 1,
        language_code: "eng",
        language_probability: 1,
        words: [],
      });
    throw Error("Unexpected external provider dispatch");
  }) as typeof fetch;
  const form = new FormData();
  form.append(
    "audio",
    new File([oneSecondWav()], "note.wav", { type: "audio/wav" }),
  );
  for (const provider of providers) form.append("provider", provider);
  const pending: Promise<unknown>[] = [];
  const response = await sttApp.request(
    "http://cloud.test/",
    { method: "POST", body: form },
    {
      ELEVENLABS_API_KEY: "el-test",
      CARTESIA_API_KEY: "cartesia-test",
      CARTESIA_STT_USD_PER_CREDIT: "0.001",
      ...(providers.length ? { VOICE_BATCH_STT_PROVIDER: "deepgram" } : {}),
    },
    {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    },
  );
  expect(response.status, await response.clone().text()).toBe(expected);
  await Promise.all(pending);
  if (expected === 400) {
    expect(calls).toEqual([]);
    expect(admissions).toBe(0);
    expect(dispatched).toBe(0);
  } else {
    const selected = providers.length > 0;
    expect(calls).toEqual([selected ? "api.cartesia.ai" : "api.elevenlabs.io"]);
    expect(response.headers.get("X-Eliza-STT-Provider")).toBe(
      selected ? "cartesia" : null,
    );
    expect(response.headers.get("X-Eliza-STT-Model")).toBe(
      selected ? "ink-whisper" : null,
    );
    expect(admissions).toBe(1);
    expect(reconciled).toHaveLength(1);
  }
});

test.each([
  "missing-key",
  "invalid-config",
  "credits",
  "auth",
  "upstream",
  "malformed",
  "transport",
] as const)(
  "explicit Cartesia retains %s refusal without fallback or false attestation",
  async (failure) => {
    if (failure === "credits")
      admissionFailure = new InsufficientCreditsError(1, 0);
    if (failure === "auth") authenticationFailure = new ApiError(401);
    const calls: string[] = [];
    globalThis.fetch = (async (input) => {
      const host = new URL(input instanceof Request ? input.url : String(input))
        .host;
      calls.push(host);
      if (failure === "transport")
        throw new TypeError("synthetic transport failure");
      return failure === "upstream"
        ? new Response("private upstream body", { status: 500 })
        : Response.json({ unexpected: "private malformed response" });
    }) as typeof fetch;
    const form = new FormData();
    form.append(
      "audio",
      new File([oneSecondWav()], "note.wav", { type: "audio/wav" }),
    );
    form.append("provider", "cartesia");
    const response = await sttApp.request(
      "http://cloud.test/",
      { method: "POST", body: form },
      {
        ELEVENLABS_API_KEY: "el-test",
        WHISPER_STT_URL: "https://whisper.test",
        CARTESIA_STT_USD_PER_CREDIT: "0.001",
        ...(failure === "missing-key"
          ? {}
          : { CARTESIA_API_KEY: "cartesia-test" }),
        ...(failure === "invalid-config"
          ? { VOICE_BATCH_STT_PROVIDER: "invalid" }
          : {}),
      },
    );
    expect(response.status).toBe(
      failure === "credits"
        ? 402
        : failure === "auth"
          ? 401
          : ["missing-key", "invalid-config"].includes(failure)
            ? 503
            : 502,
    );
    if (failure === "credits")
      expect(response.headers.get("Server-Timing")).toContain("admission;dur=");
    expect(response.headers.get("X-Eliza-STT-Provider")).toBeNull();
    expect(response.headers.get("X-Eliza-STT-Model")).toBeNull();
    expect(calls).toEqual(
      ["upstream", "malformed", "transport"].includes(failure)
        ? ["api.cartesia.ai"]
        : [],
    );
    if (["missing-key", "invalid-config", "auth"].includes(failure))
      expect(admissions).toBe(0);
    expect(dispatched).toBe(
      ["upstream", "malformed", "transport"].includes(failure) ? 1 : 0,
    );
    expect(await response.text()).not.toContain("private");
  },
);

/**
 * Explicit Cartesia request whose caller can abort it; the key stays fixed.
 * It runs in a Worker unless `pending` is null.
 */
function transcribeWithCartesia(
  signal: AbortSignal,
  timeoutMs: string,
  pending: Promise<unknown>[] | null = [],
) {
  const form = new FormData();
  form.append(
    "audio",
    new File([oneSecondWav()], "note.wav", { type: "audio/wav" }),
  );
  form.append("provider", "cartesia");
  return sttApp.request(
    "http://cloud.test/",
    {
      method: "POST",
      headers: { "Idempotency-Key": "one-utterance" },
      body: form,
      signal,
    },
    {
      CARTESIA_API_KEY: "cartesia-test",
      CARTESIA_STT_USD_PER_CREDIT: "0.001",
      CARTESIA_BATCH_STT_TIMEOUT_MS: timeoutMs,
    },
    pending
      ? {
          waitUntil: (promise: Promise<unknown>) => pending.push(promise),
          passThroughOnException: () => undefined,
          props: {},
        }
      : undefined,
  );
}

/** Cartesia accepts the request, then holds the headers or body until its signal aborts. */
function holdCartesia(phase: "headers" | "body"): Promise<void> {
  let accepted!: () => void;
  const dispatchedRequest = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  globalThis.fetch = (async (_input, init) => {
    providerCalls++;
    accepted();
    const signal = init?.signal;
    const aborted = new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    });
    if (phase === "headers") return aborted;
    return new Response(
      new ReadableStream({
        start(controller) {
          aborted.catch((reason) => controller.error(reason));
        },
      }),
    );
  }) as typeof fetch;
  return dispatchedRequest;
}

test("a caller abort before Cartesia dispatch calls no provider and releases only the unstarted reservation", async () => {
  const caller = new AbortController();
  duringAdmission = () => caller.abort();
  stubProvider("api.cartesia.ai", { text: "hello", duration: 1 });

  const response = await transcribeWithCartesia(caller.signal, "2000");

  expect(response.status).toBe(499);
  expect(await response.json()).toMatchObject({
    error: "Speech-to-text cancelled",
  });
  expect(admissions).toBe(1);
  expect(dispatched).toBe(0);
  expect(providerCalls).toBe(0);
  expect(reconciled).toEqual([0]);
  expect(settledUnknown).toBe(0);
});

test.each(["headers", "body"] as const)(
  "a caller abort after Cartesia dispatch, before the %s, keeps the unknown outcome and is not a timeout",
  async (phase) => {
    const caller = new AbortController();
    const dispatchedRequest = holdCartesia(phase);
    const aborted = transcribeWithCartesia(caller.signal, "2000");
    await dispatchedRequest;
    caller.abort();
    const response = await aborted;

    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({
      error: "Speech-to-text cancelled",
    });
    expect(dispatched).toBe(1);
    expect(settledUnknown).toBe(1);
    expect(reconciled).toEqual([]);

    // STT mints a fresh billing id per request and ignores Idempotency-Key, so
    // the retry is a new paid transcription, never a replayed success.
    stubProvider("api.cartesia.ai", { text: "hello", duration: 1 });
    const pending: Promise<unknown>[] = [];
    const retry = await transcribeWithCartesia(
      new AbortController().signal,
      "2000",
      pending,
    );
    await Promise.all(pending);

    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ transcript: "hello" });
    expect(retry.headers.get("X-Eliza-STT-Provider")).toBe("cartesia");
    expect(providerCalls).toBe(2);
    expect(new Set(admittedRequestIds).size).toBe(2);
    expect(dispatched).toBe(2);
    expect(settledUnknown).toBe(1);
    expect(reconciled).toHaveLength(1);
  },
);

test.each(["headers", "body"] as const)(
  "the Cartesia hard timeout before the %s still answers 504 with an unknown outcome",
  async (phase) => {
    holdCartesia(phase);

    const response = await transcribeWithCartesia(
      new AbortController().signal,
      "50",
    );

    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({
      error: "Speech-to-text timed out",
    });
    expect(dispatched).toBe(1);
    expect(settledUnknown).toBe(1);
    expect(reconciled).toEqual([]);
  },
);

// A failed-transcription settlement runs off the response under waitUntil in
// a Worker (the lease alarm is its durable recovery); outside a Worker it is
// awaited and its failure reaches the outer catch. A caller abort takes the
// same settlement path as a Cartesia transport failure in both.
test.each([
  ["in a Worker", "before dispatch", undefined],
  ["in a Worker", "after dispatch, before the headers", "headers"],
  ["in a Worker", "after dispatch, before the body", "body"],
  ["outside a Worker", "before dispatch", undefined],
  ["outside a Worker", "after dispatch, before the headers", "headers"],
  ["outside a Worker", "after dispatch, before the body", "body"],
] as const)(
  "%s, a caller abort %s whose settlement fails is settled like a Cartesia transport failure, never logged as settled",
  async (mode, _label, phase) => {
    const worker = mode === "in a Worker";
    const logs = captureSettlementLogs();
    // Reference: a transport failure whose settlement attempt throws.
    settlementFailures = 1;
    globalThis.fetch = (async () => {
      throw new TypeError("synthetic transport failure");
    }) as unknown as typeof fetch;
    const referenceSettlements: Promise<unknown>[] = [];
    const reference = await transcribeWithCartesia(
      new AbortController().signal,
      "2000",
      worker ? referenceSettlements : null,
    );
    await Promise.all(referenceSettlements);
    const referenceBody = await reference.json();
    // A Worker answers the provider failure without waiting on the settlement.
    expect(reference.status).toBe(worker ? 502 : 500);
    expect(settlementFailures).toBe(0);
    expect(settlementAttempts).toEqual(["unknown"]);
    expect(logs.warnings).toEqual([]);
    expect(logs.failures).toHaveLength(worker ? 1 : 0);

    settlementAttempts.length = 0;
    logs.warnings.length = 0;
    logs.failures.length = 0;
    settlementFailures = 1;
    const caller = new AbortController();
    const dispatchedRequest = phase && holdCartesia(phase);
    if (!phase) duringAdmission = () => caller.abort();
    const settlements: Promise<unknown>[] = [];
    const cancelled = transcribeWithCartesia(
      caller.signal,
      "2000",
      worker ? settlements : null,
    );
    if (dispatchedRequest) {
      await dispatchedRequest;
      caller.abort();
    }
    const response = await cancelled;
    await Promise.all(settlements);

    expect(settlementFailures).toBe(0);
    // One attempt, the settlement the dispatch state calls for: a release
    // before dispatch, the unknown outcome after it. None succeeded.
    expect(settlementAttempts).toEqual([phase ? "unknown" : "reconcile(0)"]);
    expect(reconciled).toEqual([]);
    expect(settledUnknown).toBe(0);
    expect(logs.warnings).toEqual([]);
    if (worker) {
      // The cancellation stays a cancellation; the failure is logged.
      expect(response.status).toBe(499);
      expect(await response.json()).toMatchObject({
        error: "Speech-to-text cancelled",
      });
      expect(logs.failures).toEqual([
        expect.objectContaining({ error: "synthetic settlement failure" }),
      ]);
    } else {
      expect(response.status).toBe(reference.status);
      expect(await response.text()).toBe(JSON.stringify(referenceBody));
      expect(logs.failures).toEqual([]);
    }
  },
);

test("speech phase diagnostics preserve STT order, auth, dispatch and billing counts", async () => {
  stubProvider("api.deepgram.com", {
    metadata: { duration: PROVIDER_SECONDS },
    results: {
      channels: [{ alternatives: [{ transcript: "hello", words: [] }] }],
    },
  });
  await transcribe(
    { VOICE_BATCH_STT_PROVIDER: "deepgram", DEEPGRAM_API_KEY: "fixture" },
    true,
  );
  expect(phaseRows.map((row) => row.phase)).toEqual([
    "upload_read",
    "multipart_decode",
    "audio_buffer",
    "audio_sniff",
    "audio_metadata",
  ]);
  expect(authCalls).toBe(1);
  expect(admissions).toBe(1);
  expect(dispatched).toBe(1);
  expect(providerCalls).toBe(1);
  expect(billingCalls).toBe(1);
  expect(reconciled).toEqual([PROVIDER_SECONDS]);
});

test("oversized STT still stops before auth, decoding, provider and billing", async () => {
  const app = new Hono().route("/api/v1/voice/stt", sttApp);
  const response = await app.request(
    "http://cloud.test/api/v1/voice/stt",
    {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=fixture" },
      body: "x".repeat(128),
    },
    { VOICE_STT_MAX_MULTIPART_BYTES: "32" },
  );
  expect(response.status).toBe(413);
  expect(phaseRows.map((row) => row.phase)).toEqual(["upload_read"]);
  expect(authCalls).toBe(0);
  expect(admissions).toBe(0);
  expect(dispatched).toBe(0);
  expect(providerCalls).toBe(0);
  expect(billingCalls).toBe(0);
});

test("STT auth failure preserves refusal and never reaches decoding or effects", async () => {
  authenticationFailure = new ApiError(401);
  const app = new Hono().route("/api/v1/voice/stt", sttApp);
  const form = new FormData();
  form.append(
    "audio",
    new File([oneSecondWav()], "fixture.wav", { type: "audio/wav" }),
  );
  const response = await app.request(
    "http://cloud.test/api/v1/voice/stt",
    { method: "POST", body: form },
    {},
  );
  expect(response.status).toBe(401);
  expect(authCalls).toBe(1);
  expect(phaseRows.map((row) => row.phase)).toEqual(["upload_read"]);
  expect(admissions).toBe(0);
  expect(providerCalls).toBe(0);
  expect(billingCalls).toBe(0);
});
