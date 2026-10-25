/**
 * Paid STT lanes bill the audio the provider transcribed. The container header
 * duration only sizes the reservation: a header can state a shorter length
 * than the audio it holds, and the provider transcribes all of it.
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import * as aiBilling from "@elizaos/cloud-shared/lib/services/ai-billing";
import * as aiPricing from "@elizaos/cloud-shared/lib/services/ai-pricing";
import * as usage from "@elizaos/cloud-shared/lib/services/usage";
import * as generativeRouteAuth from "../src/lib/generative-route-auth";

const reconciled: number[] = [];
const pricedSeconds: number[] = [];

mock.module("@/api-app/lib/generative-route-auth", () => ({
  ...generativeRouteAuth,
  requireGenerativeRouteCaller: async () => ({
    user: { id: "user-1", organization_id: "org-1" },
    apiKeyId: null,
    admissionSnapshot: null,
    credential: undefined,
  }),
  admitFlatGenerativeOperation: async (params: {
    cost: { totalCost: number };
  }) => ({
    reservation: {
      reservedAmount: params.cost.totalCost,
      reconcile: async (actual: number) => {
        reconciled.push(actual);
      },
    },
    settleUnknown: async () => undefined,
    markProviderDispatched: async () => undefined,
  }),
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

const PROVIDER_SECONDS = 3600;
const realFetch = globalThis.fetch;

function stubProvider(host: string, payload: unknown): void {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      input instanceof Request ? input.url : new URL(String(input)).href;
    if (new URL(url).host === host) return Response.json(payload);
    return realFetch(input, init);
  }) as typeof fetch;
}

async function transcribe(env: Record<string, string>): Promise<void> {
  const pending: Promise<unknown>[] = [];
  const form = new FormData();
  form.append(
    "audio",
    new File([oneSecondWav()], "note.wav", { type: "audio/wav" }),
  );
  const response = await sttApp.request(
    "http://cloud.test/",
    { method: "POST", body: form },
    env,
    {
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      passThroughOnException: () => undefined,
      props: {},
    },
  );
  expect(response.status, await response.clone().text()).toBe(200);
  expect(await response.json()).toMatchObject({ transcript: "hello" });
  await Promise.all(pending);
}

beforeEach(() => {
  reconciled.length = 0;
  pricedSeconds.length = 0;
});

afterAll(() => {
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
