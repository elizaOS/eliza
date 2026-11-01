/** Real workerd sockets/storage, production coordinator and speech session.
 * Provider/DB boundaries are controlled so any hot-path DB call throws. This
 * proves the transport contract, not live provider latency or production billing.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";

let worker: Miniflare;
const common = `const stats=()=>globalThis.__speechStats??={};
const bootstrap=(name)=>{const s=stats();if(s.locked)throw Error('DB/auth/admission on live speech path');s[name]=(s[name]??0)+1;};`;
beforeAll(async () => {
  const sources: Array<[RegExp, string]> = [
    [
      /\/services\/credits\.ts$/,
      `export class InsufficientCreditsError extends Error {}`,
    ],
    [
      /\/lib\/pricing-constants\.ts$/,
      `export const PLATFORM_MARKUP_MULTIPLIER=1.2;`,
    ],
    [
      /\/db\/client\.ts$/,
      `${common} export async function runWithDbCacheAsync(run){bootstrap('dbContexts');return run();}`,
    ],
    [
      /\/runtime\/cloud-bindings\.ts$/,
      `let current;export async function runWithCloudBindingsAsync(env,run){current=env;return run();}export function getCloudAwareEnv(){return current??{};}export function getCloudBinding(name){return current?.[name];}`,
    ],
    [
      /\/services\/organization-inference-admission\.ts$/,
      `import {InsufficientCreditsError} from '@elizaos/cloud-shared/lib/services/credits'; ${common} export async function admitOrganizationInference(input){bootstrap('admissions');if(stats().decline)throw new InsufficientCreditsError('private provider details');return {async markProviderDispatched(){bootstrap('dispatches');},async settle(cost){const s=stats();s.settlements=(s.settlements??0)+1;},async settleUnknown(){const s=stats();s.unknown=(s.unknown??0)+1;}};}`,
    ],
    [
      /\/services\/content-safety\.ts$/,
      `${common} export const contentSafetyService={async assertSafeForPublicUse(){const s=stats();s.moderation=(s.moderation??0)+1;return {allowed:true,skipped:false,flagged:false,mode:'enforce',issues:[]};}};`,
    ],
    [
      /\/services\/voice-usage-meter\.ts$/,
      `${common} export function createDurableVoiceUsageStore(){bootstrap('quotaStore');return {async checkAndRecord(){bootstrap('quota');return {allowed:true};},async release(){stats().released=true;}};}`,
    ],
    [
      /\/utils\/logger\.ts$/,
      `export const logger={error(){},warn(){},info(){}};`,
    ],
    [
      /\/voice-session\/config\.ts$/,
      `export function resolveVoiceUsageLimits(){return {organizationDailyMinutes:10,userDailyMinutes:10};}`,
    ],
    [
      /\/lib\/provider-socket-factory\.ts$/,
      `export const createWorkerCartesiaFactory=()=>{};export const createWorkerCartesiaInkFactory=()=>{};`,
    ],
    [
      /\/voice\/cartesia-ink\.ts$/,
      `${common} export function createCartesiaInkRealtimeSession({onEvent}){let bytes=0;stats().sttOpened=(stats().sttOpened??0)+1;return {sendAudioChunk(chunk){bytes+=chunk.byteLength;stats().pcmBytes=bytes;onEvent({type:'transcript-update',transcript:'hello'});},cancel(){stats().sttCancelled=true;},async drain(){return {source:'provider-graceful-close',audioBytes:bytes,sampleRate:16000,channels:1,encoding:'pcm_s16le'};}};}`,
    ],
    [
      /\/voice\/cartesia-sonic-tts\.ts$/,
      `${common} export class CartesiaSonicTtsAdapter{createStream(_options,callbacks){stats().ttsOpened=(stats().ttsOpened??0)+1;return {sendPhrase(){queueMicrotask(()=>callbacks.onAudioFrame({bytes:new Uint8Array([7,0,8,0])}));},finish(){queueMicrotask(()=>callbacks.onComplete({frameCount:1}));},cancel(){stats().ttsCancelled=true;}};}close(){stats().ttsClosed=true;}}`,
    ],
  ];
  const result = await Bun.build({
    entrypoints: [
      fileURLToPath(
        new URL("../test/fixtures/speech-relay-worker.ts", import.meta.url),
      ),
    ],
    target: "bun",
    format: "esm",
    conditions: ["eliza-source"],
    external: ["node:crypto"],
    plugins: [
      {
        name: "speech-external-boundaries",
        setup(build) {
          for (const [filter, contents] of sources)
            build.onLoad({ filter }, () => ({ loader: "js", contents }));
        },
      },
    ],
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Speech worker build failed");
  worker = new Miniflare({
    modules: true,
    script: await result.outputs[0].text(),
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      SESSIONS: { className: "TestSpeechRelayCoordinator", useSQLite: true },
    },
    bindings: {
      VOICE_SPEECH_RELAY_ENABLED: "true",
      CARTESIA_API_KEY: "test-provider-boundary",
      VOICE_REALTIME_CARTESIA_VOICE_ID: "test",
      CARTESIA_STT_USD_PER_CREDIT: "0.00004",
    },
  });
});
afterAll(async () => {
  await worker?.dispose();
});
const account = {
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
};
async function call(path: string, body?: unknown) {
  return worker.dispatchFetch(`https://speech-relay.internal${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
}
function next(
  socket: WebSocket,
  predicate: (value: any) => boolean,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", receive);
      reject(Error("Speech frame timed out"));
    }, 5000);
    const receive = (event: MessageEvent) => {
      const value =
        typeof event.data === "string" ? JSON.parse(event.data) : event.data;
      if (predicate(value)) {
        clearTimeout(timer);
        socket.removeEventListener("message", receive);
        resolve(value);
      }
    };
    socket.addEventListener("message", receive);
  });
}
test("ready speech streams PCM and multiple TTS contexts without another DB/auth/admission operation", async () => {
  const token = "private-test-capability";
  const digest = new Bun.CryptoHasher("sha256").update(token).digest("hex");
  expect(
    (
      await call("/initialize", {
        sessionId: "33333333-3333-4333-8333-333333333333",
        tokenDigest: digest,
        expiresAt: Date.now() + 60000,
        caller: {
          user: account,
          apiKeyId: null,
          authSource: "combined_cache",
          appScopeId: null,
        },
      })
    ).status,
  ).toBe(200);
  const refused = await worker.dispatchFetch(
    "https://speech-relay.internal/ws",
    { headers: { Upgrade: "websocket" } },
  );
  const wrong = refused.webSocket!;
  wrong.accept();
  const invalidHello = next(wrong as any, (value) => value.t === "error");
  const refusedClose = new Promise<void>((resolve) =>
    wrong.addEventListener("close", () => resolve()),
  );
  wrong.send(JSON.stringify({ t: "hello", token: "wrong-capability" }));
  expect(await invalidHello).toEqual({ t: "error", code: "unauthorized" });
  await refusedClose;
  const untouched = (await (await call("/test-stats")).json()) as Record<
    string,
    unknown
  >;
  expect(untouched.admissions).toBeUndefined();
  const upgraded = await worker.dispatchFetch(
    "https://speech-relay.internal/ws",
    { headers: { Upgrade: "websocket" } },
  );
  expect(upgraded.status).toBe(101);
  const socket = upgraded.webSocket!;
  socket.accept();
  const ready = next(socket as any, (value) => value.t === "ready");
  socket.send(JSON.stringify({ t: "hello", token }));
  expect(await ready).toMatchObject({
    t: "ready",
    sampleRate: 16000,
    version: 1,
  });
  const baseline = (await (
    await call("/test-lock-bootstrap")
  ).json()) as Record<string, any>;
  expect(baseline.admissions).toBe(2);
  expect(baseline.dispatches).toBe(2);
  const transcript = next(socket as any, (value) => value.t === "stt");
  socket.send(new Uint8Array(3200));
  expect((await transcript).event.transcript).toBe("hello");
  for (const id of ["first", "second"]) {
    const prepared = next(
      socket as any,
      (value) => value.t === "tts_prepared" && value.id === id,
    );
    const audio = next(
      socket as any,
      (value) =>
        typeof value !== "object" ||
        value instanceof ArrayBuffer ||
        ArrayBuffer.isView(value),
    );
    socket.send(
      JSON.stringify({
        t: "tts",
        id,
        text: "This is a finalized phrase.",
        flush: true,
      }),
    );
    await prepared;
    expect((await audio).byteLength).toBeGreaterThan(4);
    const complete = next(
      socket as any,
      (value) => value.t === "complete" && value.id === id,
    );
    socket.send(JSON.stringify({ t: "finish", id }));
    await complete;
  }
  const after = (await (await call("/test-stats")).json()) as Record<
    string,
    any
  >;
  expect(after.dbContexts).toBe(baseline.dbContexts);
  expect(after.admissions).toBe(baseline.admissions);
  expect(after.dispatches).toBe(baseline.dispatches);
  expect(after.pcmBytes).toBe(3200);
  expect(after.ttsOpened).toBe(2);
  // Final accounting may use the primary store after providers stop. The
  // no-DB assertion above concerns live frames and repeated TTS turns.
  await call("/test-allow-settlement");
  expect(
    (
      await call("/revoke", {
        userId: "other",
        organizationId: account.organization_id,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call("/revoke", {
        userId: account.id,
        organizationId: account.organization_id,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await worker.dispatchFetch("https://speech-relay.internal/ws", {
        headers: { Upgrade: "websocket" },
      })
    ).status,
  ).toBe(410);
});

test("a refused credit reservation preserves the allowlisted recovery reason before providers open", async () => {
  const request = (path: string, body?: unknown) =>
    worker.dispatchFetch(`https://speech-relay.internal${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-test-session": "credit-decline",
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const token = "refused-test-capability";
  await request("/initialize", {
    sessionId: "44444444-4444-4444-8444-444444444444",
    tokenDigest: new Bun.CryptoHasher("sha256").update(token).digest("hex"),
    expiresAt: Date.now() + 60000,
    caller: {
      user: account,
      apiKeyId: null,
      authSource: "combined_cache",
      appScopeId: null,
    },
  });
  const baseline = (await (await request("/test-decline")).json()) as Record<
    string,
    number
  >;
  const upgraded = await worker.dispatchFetch(
    "https://speech-relay.internal/ws",
    {
      headers: { "x-test-session": "credit-decline", Upgrade: "websocket" },
    },
  );
  const socket = upgraded.webSocket!;
  socket.accept();
  const refused = next(socket as any, (value) => value.t === "error");
  socket.send(JSON.stringify({ t: "hello", token, errorReasons: true }));
  expect(await refused).toEqual({
    t: "error",
    code: "unavailable",
    reason: "insufficient_credits",
  });
  const after = (await (await request("/test-stats")).json()) as Record<
    string,
    number
  >;
  expect(after.sttOpened).toBe(baseline.sttOpened);
  expect(after.ttsOpened).toBe(baseline.ttsOpened);
});

test("legacy speech clients receive no unnegotiated billing reason", async () => {
  const token = "legacy-refused-capability";
  await worker.dispatchFetch("https://speech-relay.internal/initialize", {
    method: "POST",
    headers: {
      "x-test-session": "legacy-credit-decline",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sessionId: "55555555-5555-4555-8555-555555555555",
      tokenDigest: new Bun.CryptoHasher("sha256").update(token).digest("hex"),
      expiresAt: Date.now() + 60000,
      caller: {
        user: account,
        apiKeyId: null,
        authSource: "combined_cache",
        appScopeId: null,
      },
    }),
  });
  const upgraded = await worker.dispatchFetch(
    "https://speech-relay.internal/ws",
    {
      headers: {
        "x-test-session": "legacy-credit-decline",
        Upgrade: "websocket",
      },
    },
  );
  const socket = upgraded.webSocket!;
  socket.accept();
  const refused = next(socket as any, (value) => value.t === "error");
  socket.send(JSON.stringify({ t: "hello", token }));
  expect(await refused).toEqual({ t: "error", code: "unavailable" });
});
