/** Real workerd sockets/storage, production coordinator and speech session.
 * Provider/DB boundaries are controlled so any hot-path DB call throws. This
 * proves the transport contract, not live provider latency or production billing.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { CARTESIA_PUBLISHED_USD_PER_CREDIT } from "../v1/voice/stt/cartesia-pricing";

let worker: Miniflare;
let outboundAttempts = 0;
const common = `const stats=()=>globalThis.__speechStats??={};
const bootstrap=(name)=>{const s=stats();if(s.locked)throw Error('DB/auth/admission on live speech path');s[name]=(s[name]??0)+1;};`;
beforeAll(async () => {
  const sources: Array<[RegExp, string]> = [
    [
      /\/services\/inference-billing-fast-path\.ts$/,
      `export class InferenceBillingUnavailableError extends Error {}`,
    ],
    [
      /\/inference-admission-recovery\.ts$/,
      `export async function recoverExpiredInferenceAdmissionLease(){throw Error("Unexpected recovery");}`,
    ],
    [
      /\/maps-request-allowance-controller\.ts$/,
      `export class MapsRequestAllowanceController {}`,
    ],
    [
      /\/inference-funded-budget-controller\.ts$/,
      `export class InferenceFundedBudgetController { constructor(){ throw Error("Unused budget controller"); } }`,
    ],
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
      `import {AsyncLocalStorage} from 'node:async_hooks';${common}
const dbContexts=new AsyncLocalStorage();
export function testDbContext(){return dbContexts.getStore();}
export async function runWithDbCacheAsync(run){bootstrap('dbContexts');return dbContexts.run(stats().dbContexts,run);}`,
    ],
    // Use the real AsyncLocalStorage binding implementation; a global fake
    // would leak the opening context into unrelated socket events.
    [
      /\/services\/organization-inference-admission\.ts$/,
      `import {InsufficientCreditsError} from '@elizaos/cloud-shared/lib/services/credits';
import {getCloudBinding} from '@elizaos/cloud-shared/lib/runtime/cloud-bindings';
import {testDbContext} from '@elizaos/cloud-shared/db/client';${common}
export async function admitOrganizationInference(input){bootstrap('admissions');if(stats().decline)throw new InsufficientCreditsError('private provider details');const openedIn=testDbContext();let settled=false;
const account=()=>{const s=stats();if(getCloudBinding('HYPERDRIVE')?.connectionString!=='postgres://boundary-test.invalid/not-used'||!testDbContext())throw Error('Missing settlement binding/context');if(settled)throw Error('Duplicate admission settlement');settled=true;(s.settlementContexts??=[]).push({openedIn,settledIn:testDbContext(),hasHyperdrive:true});};
return {async markProviderDispatched(){bootstrap('dispatches');},async settle(cost){account();const s=stats();s.settlements=(s.settlements??0)+1;(s.settledAmounts??=[]).push({model:input.context.model,cost});(s.allSettlementCalls??=[]).push({requestId:input.context.requestId,model:input.context.model,cost,kind:'actual'});},async settleUnknown(){account();const s=stats();s.unknown=(s.unknown??0)+1;(s.allSettlementCalls??=[]).push({requestId:input.context.requestId,model:input.context.model,cost:input.flatCost.totalCost,kind:'unknown'});}};}`,
    ],
    [
      /\/services\/content-safety\.ts$/,
      `${common} export const contentSafetyService={async assertSafeForPublicUse(){throw new Error('content moderation must not run on the speech path');}};`,
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
      `${common} export const CARTESIA_INK_CHUNK_BYTES=3200;export function createCartesiaInkRealtimeSession({onEvent}){let bytes=0;stats().sttOpened=(stats().sttOpened??0)+1;return {sendAudioChunk(chunk){if(chunk.byteLength!==3200)throw Error('Invalid Ink frame');bytes+=chunk.byteLength;stats().pcmBytes=bytes;onEvent({type:'transcript-update',transcript:'hello'});},cancel(){stats().sttCancelled=true;},async drain(){stats().sttDrained=true;stats().sttDrains=(stats().sttDrains??0)+1;if(stats().sttDrainUnknown)throw Error('controlled unknown STT drain');return {source:'provider-graceful-close',audioBytes:bytes,sampleRate:16000,channels:1,encoding:'pcm_s16le'};}};}`,
    ],
    [
      /\/voice\/cartesia-sonic-tts\.ts$/,
      `${common} export const CARTESIA_SONIC_MODEL_ID="sonic-3.6";export class CartesiaSonicTtsAdapter{createStream(_options,callbacks){stats().ttsOpened=(stats().ttsOpened??0)+1;return {sendPhrase(){queueMicrotask(()=>callbacks.onAudioFrame({bytes:new Uint8Array([7,0,8,0])}));},finish(){queueMicrotask(()=>callbacks.onComplete({frameCount:1}));},cancel(){stats().ttsCancelled=true;stats().ttsCancels=(stats().ttsCancels??0)+1;}};}close(){stats().ttsClosed=true;}async closeAndConfirm(){stats().ttsClosed=true;return stats().ttsUnknown ? "unknown" : "transport_closed";}}`,
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
          build.onResolve({ filter: /^@elizaos\/core$/ }, () => ({
            path: "speech-test-core",
            namespace: "speech-test",
          }));
          build.onLoad({ filter: /.*/, namespace: "speech-test" }, () => ({
            loader: "js",
            contents: "export class ElizaError extends Error {}",
          }));
          for (const [filter, contents] of sources)
            build.onLoad({ filter }, () => ({ loader: "js", contents }));
        },
      },
    ],
  });
  if (!result.success)
    throw new AggregateError(result.logs, "Speech worker build failed");
  worker = new Miniflare({
    outboundService() {
      outboundAttempts++;
      throw new Error("Unexpected outbound request in speech fixture");
    },
    modules: true,
    script: await result.outputs[0].text(),
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat"],
    durableObjects: {
      SESSIONS: { className: "TestSpeechRelayCoordinator", useSQLite: true },
      INFERENCE_ADMISSION_GATES: {
        className: "InferenceAdmissionGate",
        useSQLite: true,
      },
    },
    bindings: {
      VOICE_SPEECH_RELAY_ENABLED: "true",
      HYPERDRIVE: {
        connectionString: "postgres://boundary-test.invalid/not-used",
      },
      CARTESIA_API_KEY: "test-provider-boundary",
      VOICE_REALTIME_CARTESIA_VOICE_ID: "test",
      // No account rate: subscription speech sizes reservations at the
      // published upper bound instead of refusing to open.
    },
  });
});
afterAll(async () => {
  await worker?.dispose();
  expect(outboundAttempts).toBe(0);
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
          credential: {
            kind: "api_key",
            credentialId: "test-key",
            userId: account.id,
          },
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
  for (const length of [1024, 1024, 1024, 128])
    socket.send(new Uint8Array(length));
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
      credential: {
        kind: "api_key",
        credentialId: "test-key",
        userId: account.id,
      },
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
        credential: {
          kind: "api_key",
          credentialId: "test-key",
          userId: account.id,
        },
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

async function openTestSession(input: {
  name: string;
  sessionId: string;
  organizationId?: string;
  environment?: string;
  expiresAt?: number;
}) {
  const headers: Record<string, string> = {
    "x-test-session": input.name,
    "Content-Type": "application/json",
  };
  const request = (path: string, body?: unknown) =>
    worker.dispatchFetch(`https://speech-relay.internal${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const token = `${input.name}-capability`;
  await request("/test-allow-admission");
  await request("/initialize", {
    sessionId: input.sessionId,
    tokenDigest: new Bun.CryptoHasher("sha256").update(token).digest("hex"),
    expiresAt: input.expiresAt ?? Date.now() + 60000,
    caller: {
      user: {
        ...account,
        organization_id: input.organizationId ?? account.organization_id,
      },
      apiKeyId: "timing-key",
      authSource: "combined_cache",
      appScopeId: null,
      credential: {
        kind: "api_key",
        credentialId: "timing-key",
        userId: account.id,
      },
    },
  });
  const upgraded = await worker.dispatchFetch(
    "https://speech-relay.internal/ws",
    {
      headers: {
        ...headers,
        Upgrade: "websocket",
        ...(input.environment
          ? { "x-test-environment": input.environment }
          : {}),
      },
    },
  );
  const socket = upgraded.webSocket!;
  socket.accept();
  return { socket, token, request };
}

test("staging reports numeric bootstrap phases only to a client that asked in hello", async () => {
  const staged = await openTestSession({
    name: "timings-staging",
    sessionId: "88888888-8888-4888-8888-888888888881",
    environment: "staging",
  });
  const frames: any[] = [];
  staged.socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") frames.push(JSON.parse(event.data));
  });
  const timings = next(staged.socket as any, (value) => value.t === "timings");
  staged.socket.send(
    JSON.stringify({ t: "hello", token: staged.token, timings: true }),
  );
  const frame = await timings;
  // Ready is first, so exact-key clients see the unchanged ready contract.
  expect(frames[0]?.t).toBe("ready");
  expect(Object.keys(frames[0]).sort()).toEqual(
    ["channels", "expiresAt", "sampleRate", "t", "version"].sort(),
  );
  for (const [key, value] of Object.entries(frame)) {
    if (key === "t") continue;
    expect([
      "claimMs",
      "revocationMs",
      "admissionMs",
      "relayMs",
      "activateMs",
      "openMs",
    ]).toContain(key);
    expect(typeof value).toBe("number");
    expect(value as number).toBeGreaterThanOrEqual(0);
  }
  expect(frame.openMs).toBeGreaterThanOrEqual(0);
  staged.socket.close();

  const production = await openTestSession({
    name: "timings-production",
    sessionId: "88888888-8888-4888-8888-888888888882",
    environment: "production",
  });
  const productionFrames: any[] = [];
  production.socket.addEventListener("message", (event) => {
    if (typeof event.data === "string")
      productionFrames.push(JSON.parse(event.data));
  });
  const ready = next(production.socket as any, (value) => value.t === "ready");
  production.socket.send(
    JSON.stringify({ t: "hello", token: production.token, timings: true }),
  );
  await ready;
  const transcript = next(
    production.socket as any,
    (value) => value.t === "stt",
  );
  production.socket.send(new Uint8Array(3200));
  await transcript;
  expect(productionFrames.some((value) => value.t === "timings")).toBe(false);
  production.socket.close();
});

test("a refused revocation fence releases the concurrently admitted leases before any provider opens", async () => {
  const organizationId = "66666666-6666-4666-8666-666666666666";
  await worker.dispatchFetch("https://speech-relay.internal/test-lifecycle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      path: "/organization/set-active",
      organizationId,
      active: false,
    }),
  });
  const session = await openTestSession({
    name: "fence-refused",
    sessionId: "88888888-8888-4888-8888-888888888883",
    organizationId,
  });
  const before = (await (
    await session.request("/test-stats")
  ).json()) as Record<string, any>;
  const refused = next(session.socket as any, (value) => value.t === "error");
  session.socket.send(JSON.stringify({ t: "hello", token: session.token }));
  expect(await refused).toEqual({ t: "error", code: "unavailable" });
  let after: Record<string, any> = {};
  for (let attempt = 0; attempt < 50; attempt++) {
    after = (await (await session.request("/test-stats")).json()) as Record<
      string,
      any
    >;
    if ((after.settlements ?? 0) - (before.settlements ?? 0) >= 2) break;
    await Bun.sleep(20);
  }
  expect(after.sttOpened).toBe(before.sttOpened);
  expect(after.ttsOpened).toBe(before.ttsOpened);
  const admitted = (after.admissions ?? 0) - (before.admissions ?? 0);
  const settled = (after.settledAmounts ?? []).slice(
    (before.settledAmounts ?? []).length,
  );
  // Admission overlaps the fence, so both leases exist and both settle to zero.
  expect(admitted).toBe(2);
  expect(settled.length).toBe(admitted);
  for (const entry of settled) expect(entry.cost).toBe(0);
});

test("authoritative org, API-key and session-cutoff revocations stop active speech through the internal socket", async () => {
  const cases = [
    {
      name: "org-disable",
      activeTts: false,
      path: "/organization/set-active",
      mutation: { active: false },
      credential: {
        kind: "api_key",
        credentialId: "org-key",
        userId: account.id,
      },
    },
    {
      name: "api-revoke",
      activeTts: true,
      path: "/credential/revoke",
      mutation: { kind: "api_key", credentialId: "revoked-key" },
      credential: {
        kind: "api_key",
        credentialId: "revoked-key",
        userId: account.id,
      },
    },
    {
      name: "session-cutoff",
      activeTts: false,
      path: "/session/revoke-through",
      mutation: { userId: account.id, issuedAt: 1000 },
      credential: {
        kind: "steward_session",
        userId: account.id,
        stewardUserId: "steward-test",
        issuedAt: 1000,
      },
    },
  ];
  for (const [index, entry] of cases.entries()) {
    const organizationId = `99999999-9999-4999-8999-99999999999${index}`;
    const headers = {
      "x-test-session": entry.name,
      "Content-Type": "application/json",
    };
    const token = `${entry.name}-capability`;
    const request = (path: string, body?: unknown) =>
      worker.dispatchFetch(`https://speech-relay.internal${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    await request("/test-allow-admission");
    await request("/initialize", {
      sessionId: `77777777-7777-4777-8777-77777777777${index}`,
      tokenDigest: new Bun.CryptoHasher("sha256").update(token).digest("hex"),
      expiresAt: Date.now() + 60000,
      caller: {
        user: { ...account, organization_id: organizationId },
        apiKeyId:
          entry.credential.kind === "api_key"
            ? entry.credential.credentialId
            : null,
        authSource: "combined_cache",
        appScopeId: null,
        credential: entry.credential,
      },
    });
    const upgraded = await worker.dispatchFetch(
      "https://speech-relay.internal/ws",
      { headers: { ...headers, Upgrade: "websocket" } },
    );
    const socket = upgraded.webSocket!;
    socket.accept();
    const ready = next(socket as any, (value) => value.t === "ready");
    socket.send(JSON.stringify({ t: "hello", token }));
    await ready;
    const transcript = next(socket as any, (value) => value.t === "stt");
    socket.send(new Uint8Array(3200));
    await transcript;
    if (entry.activeTts) {
      const prepared = next(
        socket as any,
        (value) => value.t === "tts_prepared",
      );
      socket.send(
        JSON.stringify({
          t: "tts",
          id: "active",
          text: "A finalized reply in progress.",
          flush: true,
        }),
      );
      await prepared;
    }
    const before = (await (await request("/test-stats")).json()) as Record<
      string,
      number
    >;
    const closed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Revoked speech socket remained open")),
        3000,
      );
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    const denied = next(socket as any, (value) => value.t === "error");
    const mutation = await worker.dispatchFetch(
      `https://speech-relay.internal/test-lifecycle`,
      {
        method: "POST",
        headers: {
          "x-test-org": organizationId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          path: entry.path,
          organizationId,
          ...entry.mutation,
        }),
      },
    );
    expect(mutation.status).toBe(200);
    expect(await denied).toEqual({ t: "error", code: "unauthorized" });
    await closed;
    const stats = (await (await request("/test-stats")).json()) as Record<
      string,
      unknown
    >;
    expect(stats.sttDrains).toBe((before.sttDrains ?? 0) + 1);
    if (entry.activeTts) expect(stats.ttsCancelled).toBe(true);
    // The durable fence rejects a new subscription even if the old capability
    // remains within its 60-second wall-clock lifetime.
    const retry = await worker.dispatchFetch(
      "https://speech-relay.internal/test-gate/speech/subscribe",
      {
        headers: {
          "x-test-org": organizationId,
          Upgrade: "websocket",
          "X-Eliza-Speech-Identity": JSON.stringify({
            organizationId,
            credential: entry.credential,
            expiresAt: Date.now() + 30000,
          }),
        },
      },
    );
    expect(retry.status).toBe(403);
  }
});

test("barge-in settles only the submitted TTS characters across contexts, not the full reserved monthly allowance", async () => {
  const headers = {
    "x-test-session": "barge-in",
    "Content-Type": "application/json",
  };
  const token = "barge-in-capability";
  const request = (path: string, body?: unknown) =>
    worker.dispatchFetch(`https://speech-relay.internal${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  await request("/test-allow-admission");
  await request("/initialize", {
    sessionId: "88888888-8888-4888-8888-888888888888",
    tokenDigest: new Bun.CryptoHasher("sha256").update(token).digest("hex"),
    expiresAt: Date.now() + 60000,
    caller: {
      user: {
        ...account,
        organization_id: "abababab-abab-4bab-8bab-abababababab",
      },
      apiKeyId: "barge-key",
      authSource: "combined_cache",
      appScopeId: null,
      credential: {
        kind: "api_key",
        credentialId: "barge-key",
        userId: account.id,
      },
    },
  });
  const upgraded = await worker.dispatchFetch(
    "https://speech-relay.internal/ws",
    { headers: { ...headers, Upgrade: "websocket" } },
  );
  const socket = upgraded.webSocket!;
  socket.accept();
  const ready = next(socket as any, (value) => value.t === "ready");
  socket.send(JSON.stringify({ t: "hello", token }));
  await ready;
  const phrases = ["A short first answer.", "A second interrupted answer."];
  for (const [index, text] of phrases.entries()) {
    const id = `interrupted-${index}`;
    const prepared = next(
      socket as any,
      (value) => value.t === "tts_prepared" && value.id === id,
    );
    socket.send(JSON.stringify({ t: "tts", id, text, flush: true }));
    await prepared;
    socket.send(JSON.stringify({ t: "cancel", id }));
  }
  const closed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Barge-in session did not close")),
      3000,
    );
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  socket.send(JSON.stringify({ t: "stop" }));
  await closed;
  const stats = (await (await request("/test-stats")).json()) as {
    settledAmounts: Array<{ model: string; cost: number }>;
  };
  const settled = stats.settledAmounts
    .filter((entry) => entry.model === "sonic-3.6")
    .at(-1)!;
  expect(settled.cost).toBe(
    Math.round(
      phrases.join("").length * CARTESIA_PUBLISHED_USD_PER_CREDIT * 1.2 * 1e6,
    ) / 1e6,
  );
  expect(settled.cost).toBeLessThan(
    4096 * CARTESIA_PUBLISHED_USD_PER_CREDIT * 1.2,
  );
});

test("the Cloud client's prepare-first frames speak, finish silently and cancel with one tts_prepared per context", async () => {
  const headers = {
    "x-test-session": "prepare-first",
    "Content-Type": "application/json",
  };
  const token = "prepare-first-capability";
  const request = (path: string, body?: unknown) =>
    worker.dispatchFetch(`https://speech-relay.internal${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  await request("/test-allow-admission");
  await request("/initialize", {
    sessionId: "66666666-6666-4666-8666-666666666666",
    tokenDigest: new Bun.CryptoHasher("sha256").update(token).digest("hex"),
    expiresAt: Date.now() + 60000,
    caller: {
      user: {
        ...account,
        organization_id: "cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",
      },
      apiKeyId: "prepare-key",
      authSource: "combined_cache",
      appScopeId: null,
      credential: {
        kind: "api_key",
        credentialId: "prepare-key",
        userId: account.id,
      },
    },
  });
  const upgraded = await worker.dispatchFetch(
    "https://speech-relay.internal/ws",
    { headers: { ...headers, Upgrade: "websocket" } },
  );
  const socket = upgraded.webSocket!;
  socket.accept();
  const received: any[] = [];
  socket.addEventListener("message", (event: { data: unknown }) =>
    received.push(
      typeof event.data === "string" ? JSON.parse(event.data) : event.data,
    ),
  );
  const ready = next(socket as any, (value) => value.t === "ready");
  socket.send(JSON.stringify({ t: "hello", token }));
  await ready;
  const before = (await (await request("/test-stats")).json()) as Record<
    string,
    number
  >;
  // Frames exactly as cloud-speech-relay-client sends them: createStream
  // sends prepare before any text, then tts phrases, then finish or cancel.
  const send = (value: unknown) => socket.send(JSON.stringify(value));
  const binary = (value: unknown) =>
    value instanceof ArrayBuffer || ArrayBuffer.isView(value);
  const spoken = crypto.randomUUID();
  const spokenPrepared = next(
    socket as any,
    (value) => value.t === "tts_prepared" && value.id === spoken,
  );
  send({ t: "prepare", id: spoken });
  await spokenPrepared;
  const audio = next(socket as any, binary);
  send({
    t: "tts",
    id: spoken,
    text: "This is a finalized phrase.",
    flush: true,
  });
  expect((await audio).byteLength).toBeGreaterThan(4);
  const spokenComplete = next(
    socket as any,
    (value) => value.t === "complete" && value.id === spoken,
  );
  send({ t: "finish", id: spoken });
  await spokenComplete;
  // A reply with no speech: prepare, then finish with no text.
  const silent = crypto.randomUUID();
  const silentComplete = next(
    socket as any,
    (value) => value.t === "complete" && value.id === silent,
  );
  send({ t: "prepare", id: silent });
  send({ t: "finish", id: silent });
  await silentComplete;
  // Barge-in before the first phrase.
  const dropped = crypto.randomUUID();
  const droppedPrepared = next(
    socket as any,
    (value) => value.t === "tts_prepared" && value.id === dropped,
  );
  send({ t: "prepare", id: dropped });
  await droppedPrepared;
  send({ t: "cancel", id: dropped });
  // An older client's tts-first context is unchanged.
  const legacy = "legacy-context";
  const legacyPrepared = next(
    socket as any,
    (value) => value.t === "tts_prepared" && value.id === legacy,
  );
  const legacyAudio = next(socket as any, binary);
  send({ t: "tts", id: legacy, text: "An older client.", flush: true });
  await legacyPrepared;
  await legacyAudio;
  const legacyComplete = next(
    socket as any,
    (value) => value.t === "complete" && value.id === legacy,
  );
  send({ t: "finish", id: legacy });
  await legacyComplete;
  // The cancel tore down the prepared context's provider stream; stats are
  // shared across this file, so compare counts rather than a flag.
  const settled = (await (await request("/test-stats")).json()) as Record<
    string,
    number
  >;
  expect(settled.ttsCancels).toBe((before.ttsCancels ?? 0) + 1);
  const closed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Prepared session did not close")),
      3000,
    );
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  send({ t: "stop" });
  await closed;
  expect(received.filter((value) => value.t === "error")).toEqual([]);
  for (const id of [spoken, silent, dropped, legacy])
    expect(
      received.filter((value) => value.t === "tts_prepared" && value.id === id),
    ).toHaveLength(1);
  const after = (await (await request("/test-stats")).json()) as Record<
    string,
    unknown
  >;
  expect(after.ttsOpened).toBe((before.ttsOpened ?? 0) + 4);
  // Completed and cancelled contexts left nothing open for stop to cancel.
  expect(after.ttsCancels).toBe(settled.ttsCancels);
});

test("socket Stop settles with the DO bindings and a fresh DB context before a later revoke", async () => {
  const sessionName = "stop-settlement-context";
  const scopedCall = (path: string, body?: unknown) =>
    worker.dispatchFetch(`https://speech-relay.internal${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-test-session": sessionName,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  await scopedCall("/test-allow-admission");
  const token = "stop-boundary-test-token";
  const digest = new Bun.CryptoHasher("sha256").update(token).digest("hex");
  expect(
    (
      await scopedCall("/initialize", {
        sessionId: "44444444-4444-4444-8444-444444444444",
        tokenDigest: digest,
        expiresAt: Date.now() + 60000,
        caller: {
          user: account,
          apiKeyId: null,
          authSource: "combined_cache",
          appScopeId: null,
          credential: {
            kind: "api_key",
            credentialId: "test-key",
            userId: account.id,
          },
        },
      })
    ).status,
  ).toBe(200);
  const response = await worker.dispatchFetch(
    "https://speech-relay.internal/ws",
    {
      headers: { Upgrade: "websocket", "x-test-session": sessionName },
    },
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket!;
  socket.accept();
  const ready = next(socket as any, (frame) => frame.t === "ready");
  socket.send(JSON.stringify({ t: "hello", token }));
  await ready;
  const before = (await (
    await scopedCall("/test-lock-bootstrap")
  ).json()) as Record<string, any>;
  const transcript = next(socket as any, (frame) => frame.t === "stt");
  socket.send(new Uint8Array(3200));
  await transcript;
  const streaming = (await (await scopedCall("/test-stats")).json()) as Record<
    string,
    any
  >;
  expect(streaming.dbContexts).toBe(before.dbContexts);
  expect(streaming.admissions).toBe(before.admissions);
  expect(streaming.settlements ?? 0).toBe(before.settlements ?? 0);
  await scopedCall("/test-allow-settlement");
  const closed = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(Error("Stop did not close the relay")),
      5000,
    );
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
  socket.send(JSON.stringify({ t: "stop" }));
  await closed;
  // The real coordinator's revoke awaits its retained close promise. It must
  // succeed even though socket Stop initiated settlement in another callback.
  expect(
    (
      await scopedCall("/revoke", {
        userId: account.id,
        organizationId: account.organization_id,
      })
    ).status,
  ).toBe(200);
  const after = (await (await scopedCall("/test-stats")).json()) as Record<
    string,
    any
  >;
  expect(after.settlements - (before.settlements ?? 0)).toBe(2);
  const contexts = after.settlementContexts.slice(
    (before.settlementContexts ?? []).length,
  );
  expect(contexts).toHaveLength(2);
  for (const context of contexts) {
    expect(context.hasHyperdrive).toBe(true);
    expect(context.settledIn).not.toBe(context.openedIn);
  }
  const settled = after.settlements;
  expect(
    (
      await scopedCall("/revoke", {
        userId: account.id,
        organizationId: account.organization_id,
      })
    ).status,
  ).toBe(200);
  const repeated = (await (await scopedCall("/test-stats")).json()) as Record<
    string,
    any
  >;
  expect(repeated.settlements).toBe(settled);
});

test("an extending client keeps one live session past its minted end with a fresh fence and reservation", async () => {
  const token = "extend-capability";
  const session = { "x-test-session": "native-extend" };
  await worker.dispatchFetch(
    "https://speech-relay.internal/test-allow-admission",
    { headers: session },
  );
  const before = (await (
    await worker.dispatchFetch("https://speech-relay.internal/test-stats", {
      headers: session,
    })
  ).json()) as Record<string, number>;
  // Renewal is due 10 s before the end, so it starts almost immediately.
  const mintedEnd = Date.now() + 10_400;
  await worker.dispatchFetch("https://speech-relay.internal/initialize", {
    method: "POST",
    headers: { ...session, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: "88888888-8888-4888-8888-888888888888",
      tokenDigest: new Bun.CryptoHasher("sha256").update(token).digest("hex"),
      expiresAt: mintedEnd,
      caller: {
        user: account,
        apiKeyId: null,
        authSource: "combined_cache",
        appScopeId: null,
        credential: {
          kind: "api_key",
          credentialId: "test-key",
          userId: account.id,
        },
      },
    }),
  });
  const upgraded = await worker.dispatchFetch(
    "https://speech-relay.internal/ws",
    { headers: { ...session, Upgrade: "websocket" } },
  );
  const socket = upgraded.webSocket!;
  socket.accept();
  const ready = next(socket as any, (value) => value.t === "ready");
  const extended = next(socket as any, (value) => value.t === "extended");
  socket.send(JSON.stringify({ t: "hello", token, extend: true }));
  await ready;
  const renewal = await extended;
  expect(Date.parse(renewal.expiresAt)).toBeGreaterThan(mintedEnd);
  expect(Date.parse(renewal.expiresAt)).toBeLessThanOrEqual(
    Date.now() + 60_000,
  );
  const after = (await (
    await worker.dispatchFetch("https://speech-relay.internal/test-stats", {
      headers: session,
    })
  ).json()) as Record<string, number>;
  // Two admissions (STT + TTS) per window: bootstrap and one renewal.
  expect(after.admissions - (before.admissions ?? 0)).toBe(4);
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
      id: "turn-1",
      text: "Still here.",
      flush: true,
    }),
  );
  expect((await audio).byteLength).toBeGreaterThan(4);
  await worker.dispatchFetch("https://speech-relay.internal/revoke", {
    method: "POST",
    headers: { ...session, "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: account.id,
      organizationId: account.organization_id,
    }),
  });
  const closed = (await (
    await worker.dispatchFetch("https://speech-relay.internal/test-stats", {
      headers: session,
    })
  ).json()) as Record<string, number>;
  // Every lease of both windows is settled exactly once.
  expect(
    (closed.settlements ?? 0) +
      (closed.unknown ?? 0) -
      (before.settlements ?? 0) -
      (before.unknown ?? 0),
  ).toBe(4);
});

test("a declined renewal keeps the minted end and holds no lease for it", async () => {
  const token = "declined-extend-capability";
  const session = { "x-test-session": "native-extend-declined" };
  await worker.dispatchFetch(
    "https://speech-relay.internal/test-allow-admission",
    { headers: session },
  );
  const stats = async () =>
    (await (
      await worker.dispatchFetch("https://speech-relay.internal/test-stats", {
        headers: session,
      })
    ).json()) as Record<string, number>;
  const before = await stats();
  const mintedEnd = Date.now() + 10_800;
  await worker.dispatchFetch("https://speech-relay.internal/initialize", {
    method: "POST",
    headers: { ...session, "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: "88888888-8888-4888-8888-888888888889",
      tokenDigest: new Bun.CryptoHasher("sha256").update(token).digest("hex"),
      expiresAt: mintedEnd,
      caller: {
        user: account,
        apiKeyId: null,
        authSource: "combined_cache",
        appScopeId: null,
        credential: {
          kind: "api_key",
          credentialId: "test-key",
          userId: account.id,
        },
      },
    }),
  });
  const upgraded = await worker.dispatchFetch(
    "https://speech-relay.internal/ws",
    { headers: { ...session, Upgrade: "websocket" } },
  );
  const socket = upgraded.webSocket!;
  socket.accept();
  const frames: any[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") frames.push(JSON.parse(event.data));
  });
  const ready = next(socket as any, (value) => value.t === "ready");
  socket.send(JSON.stringify({ t: "hello", token, extend: true }));
  await ready;
  // The account runs out of credit before the renewal is due.
  await worker.dispatchFetch("https://speech-relay.internal/test-decline", {
    headers: session,
  });
  try {
    for (let n = 0; n < 100; n++) {
      if ((await stats()).admissions - (before.admissions ?? 0) >= 4) break;
      await Bun.sleep(20);
    }
    await Bun.sleep(50);
    expect((await stats()).admissions - (before.admissions ?? 0)).toBe(4);
    expect(frames.some((value) => value.t === "extended")).toBe(false);
    expect(frames.some((value) => value.t === "error")).toBe(false);
  } finally {
    await worker.dispatchFetch(
      "https://speech-relay.internal/test-allow-admission",
      { headers: session },
    );
  }
  await worker.dispatchFetch("https://speech-relay.internal/revoke", {
    method: "POST",
    headers: { ...session, "Content-Type": "application/json" },
    body: JSON.stringify({
      userId: account.id,
      organizationId: account.organization_id,
    }),
  });
  const closed = await stats();
  // Only the bootstrap window's two leases existed, and each settled once.
  expect(
    (closed.settlements ?? 0) +
      (closed.unknown ?? 0) -
      (before.settlements ?? 0) -
      (before.unknown ?? 0),
  ).toBe(2);
});

test("pre-hello revoke closes the public socket and late hello cannot open providers", async () => {
  const name = `prehello-${crypto.randomUUID()}`;
  const request = (path: string, body?: unknown) =>
    worker.dispatchFetch(`https://speech-relay.internal${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-test-session": name,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  await request("/test-allow-settlement");
  const token = "prehello-test-capability";
  const sessionId = crypto.randomUUID();
  expect(
    (
      await request("/initialize", {
        sessionId,
        tokenDigest: new Bun.CryptoHasher("sha256").update(token).digest("hex"),
        expiresAt: Date.now() + 60000,
        caller: { user: account },
        proofVersion: 1,
      })
    ).status,
  ).toBe(200);
  const before = (await (await request("/test-stats")).json()) as Record<
    string,
    number
  >;
  const upgrade = await worker.dispatchFetch(
    "https://speech-relay.internal/ws",
    { headers: { Upgrade: "websocket", "x-test-session": name } },
  );
  expect(upgrade.status).toBe(101);
  const socket = upgrade.webSocket!;
  socket.accept();
  const closed = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Pre-hello socket stayed open")),
      2000,
    );
    socket.addEventListener(
      "close",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
  const revoked = await request("/revoke", {
    userId: account.id,
    organizationId: account.organization_id,
    proofVersion: 1,
  });
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toMatchObject({
    revoked: true,
    retirement: { state: "confirmed", mode: "never_started" },
  });
  await closed;
  try {
    socket.send(JSON.stringify({ t: "hello", token }));
  } catch {
    /* A closed public socket cannot accept a late hello. */
  }
  expect(
    (
      await worker.dispatchFetch("https://speech-relay.internal/ws", {
        headers: { Upgrade: "websocket", "x-test-session": name },
      })
    ).status,
  ).toBe(410);
  const after = (await (await request("/test-stats")).json()) as Record<
    string,
    number
  >;
  expect(after.sttOpened ?? 0).toBe(before.sttOpened ?? 0);
});

test("real coordinator forwards STT-only selection and bounds unknown TTS money without confirming proof", async () => {
  const name = "unknown-tts-selection";
  const named = (path: string, body?: unknown) =>
    worker.dispatchFetch(`https://speech-relay.internal${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "x-test-session": name,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  await named("/test-allow-settlement");
  await named("/test-unknown-tts");
  const before = (await (await named("/test-stats")).json()) as any;
  const initialCount = before.settledAmounts?.length ?? 0;
  const token = "unknown-tts-test-only";
  const sessionId = "77777777-7777-4777-8777-777777777777";
  await named("/initialize", {
    sessionId,
    tokenDigest: new Bun.CryptoHasher("sha256").update(token).digest("hex"),
    expiresAt: Date.now() + 60000,
    proofVersion: 1,
    caller: {
      user: account,
      credential: {
        kind: "api_key",
        credentialId: "test-key",
        userId: account.id,
      },
    },
  });
  const upgrade = await worker.dispatchFetch(
    "https://speech-relay.internal/ws",
    { headers: { Upgrade: "websocket", "x-test-session": name } },
  );
  const socket = upgrade.webSocket!;
  socket.accept();
  const ready = next(socket as any, (value) => value.t === "ready");
  socket.send(JSON.stringify({ t: "hello", token }));
  await ready;
  const prepared = next(socket as any, (value) => value.t === "tts_prepared");
  socket.send(JSON.stringify({ t: "prepare", id: "empty-context" }));
  await prepared;
  const revoke = () =>
    named("/revoke", {
      userId: account.id,
      organizationId: account.organization_id,
      proofVersion: 1,
    });
  expect((await revoke()).status).toBe(409);
  const partial = (await (await named("/test-stats")).json()) as any;
  expect(partial.settledAmounts.slice(initialCount)).toHaveLength(1);
  expect(partial.settledAmounts[initialCount].model).toBe("ink-2");
  await named("/test-force-alarm");
  await named("/test-force-alarm");
  const final = (await (await named("/test-stats")).json()) as any;
  expect(final.settledAmounts.slice(initialCount)).toHaveLength(2);
  expect(final.settledAmounts[initialCount + 1]).toMatchObject({ cost: 0 });
  const result = await revoke();
  expect(result.status).toBe(409);
  expect(await result.json()).toMatchObject({
    revoked: false,
    retirement: { state: "unconfirmed" },
  });
});

test("unknown STT drain charges one initial hold and zero for an unused renewal", async () => {
  const token = "unused-stt-window-capability";
  const sessionId = "99999999-9999-4999-8999-999999999941";
  const headers = { "x-test-session": "unused-stt-window" };
  const request = (path: string, body?: unknown) =>
    worker.dispatchFetch(`https://speech-relay.internal${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  await request("/test-allow-admission");
  await request("/test-stt-drain-mode", { unknown: true });
  let socket: any;
  try {
    await request("/initialize", {
      sessionId,
      tokenDigest: new Bun.CryptoHasher("sha256").update(token).digest("hex"),
      expiresAt: Date.now() + 10_400,
      caller: {
        user: account,
        apiKeyId: null,
        authSource: "combined_cache",
        appScopeId: null,
        credential: {
          kind: "api_key",
          credentialId: "test-key",
          userId: account.id,
        },
      },
    });
    const upgraded = await worker.dispatchFetch(
      "https://speech-relay.internal/ws",
      {
        headers: { ...headers, Upgrade: "websocket" },
      },
    );
    socket = upgraded.webSocket!;
    socket.accept();
    const ready = next(socket, (value) => value.t === "ready");
    const extended = next(socket, (value) => value.t === "extended");
    socket.send(JSON.stringify({ t: "hello", token, extend: true }));
    await ready;
    await extended;
    socket.send(JSON.stringify({ t: "stop" }));
    type Charge = {
      requestId: string;
      model: string;
      cost: number;
      kind: string;
    };
    let charges: Charge[] = [];
    for (let n = 0; n < 100; n++) {
      const stats = (await (await request("/test-stats")).json()) as {
        allSettlementCalls?: Charge[];
      };
      charges = (stats.allSettlementCalls ?? []).filter((row) =>
        row.requestId.startsWith(`speech:${sessionId}:`),
      );
      if (charges.length === 4) break;
      await Bun.sleep(20);
    }
    expect(charges).toHaveLength(4);
    expect(new Set(charges.map((row) => row.requestId)).size).toBe(4);
    const stt = charges.filter((row) => row.model === "ink-2");
    const expectedHold =
      Math.round(
        (60 * 3 * CARTESIA_PUBLISHED_USD_PER_CREDIT * 1.2 + Number.EPSILON) *
          1e6,
      ) / 1e6;
    expect(stt).toHaveLength(2);
    expect(
      stt.find((row) => row.requestId === `speech:${sessionId}:stt`),
    ).toEqual({
      requestId: `speech:${sessionId}:stt`,
      model: "ink-2",
      cost: expectedHold,
      kind: "unknown",
    });
    expect(
      stt.find((row) => row.requestId === `speech:${sessionId}:stt:1`),
    ).toEqual({
      requestId: `speech:${sessionId}:stt:1`,
      model: "ink-2",
      cost: 0,
      kind: "actual",
    });
    expect(stt.reduce((sum, row) => sum + row.cost, 0)).toBe(expectedHold);
    expect(
      charges
        .filter((row) => row.model !== "ink-2")
        .every((row) => row.cost === 0),
    ).toBe(true);
  } finally {
    await request("/test-stt-drain-mode", { unknown: false });
    socket?.close();
  }
});

test("complete STT drain charges exact PCM once and zero for the unused renewed budget", async () => {
  const sessionId = "99999999-9999-4999-8999-999999999942";
  const f = await openTestSession({
    name: "complete-stt-window-amounts",
    sessionId,
    expiresAt: Date.now() + 10_400,
  });
  try {
    await f.request("/test-stt-drain-mode", { unknown: false });
    const ready = next(f.socket as any, (value) => value.t === "ready");
    const extended = next(f.socket as any, (value) => value.t === "extended");
    f.socket.send(JSON.stringify({ t: "hello", token: f.token, extend: true }));
    await ready;
    await extended;
    const transcript = next(f.socket as any, (value) => value.t === "stt");
    f.socket.send(new Uint8Array(3_200));
    await transcript;
    f.socket.send(JSON.stringify({ t: "stop" }));
    type Charge = {
      requestId: string;
      model: string;
      cost: number;
      kind: string;
    };
    let charges: Charge[] = [];
    for (let n = 0; n < 100; n++) {
      const stats = (await (await f.request("/test-stats")).json()) as {
        allSettlementCalls?: Charge[];
      };
      charges = (stats.allSettlementCalls ?? []).filter((row) =>
        row.requestId.startsWith(`speech:${sessionId}:`),
      );
      if (charges.length === 4) break;
      await Bun.sleep(20);
    }
    expect(charges).toHaveLength(4);
    expect(new Set(charges.map((row) => row.requestId)).size).toBe(4);
    const stt = charges.filter((row) => row.model === "ink-2");
    const expectedCost =
      Math.round(
        (0.1 * 3 * CARTESIA_PUBLISHED_USD_PER_CREDIT * 1.2 + Number.EPSILON) *
          1e6,
      ) / 1e6;
    expect(
      stt.find((row) => row.requestId === `speech:${sessionId}:stt`),
    ).toEqual({
      requestId: `speech:${sessionId}:stt`,
      model: "ink-2",
      cost: expectedCost,
      kind: "actual",
    });
    expect(
      stt.find((row) => row.requestId === `speech:${sessionId}:stt:1`),
    ).toEqual({
      requestId: `speech:${sessionId}:stt:1`,
      model: "ink-2",
      cost: 0,
      kind: "actual",
    });
    expect(stt.reduce((sum, row) => sum + row.cost, 0)).toBe(expectedCost);
    expect(charges.every((row) => row.kind === "actual")).toBe(true);
    expect(
      charges
        .filter((row) => row.model !== "ink-2")
        .every((row) => row.cost === 0),
    ).toBe(true);
  } finally {
    f.socket.close();
  }
});

test("a consent warm instantiates the session object without a ledger, and one mint owns it", async () => {
  const session = "44444444-4444-8444-8444-444444444444";
  const at = async (path: string, body?: unknown) => {
    const result = await worker.dispatchFetch(
      `https://speech-relay.internal${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-test-session": session,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    // Consume each response before Bun/Miniflare reuses its loopback connection.
    await result.arrayBuffer();
    return result;
  };
  const warmed = await at("/warm");
  expect(warmed.status).toBe(200);
  // The warm stored nothing: the object still has no session to revoke.
  expect(
    (
      await at("/revoke", {
        userId: account.id,
        organizationId: account.organization_id,
      })
    ).status,
  ).toBe(404);
  const mint = (token: string) =>
    at("/initialize", {
      sessionId: session,
      tokenDigest: new Bun.CryptoHasher("sha256").update(token).digest("hex"),
      expiresAt: Date.now() + 60000,
      caller: {
        user: account,
        apiKeyId: null,
        authSource: "combined_cache",
        appScopeId: null,
      },
    });
  expect((await mint("first-capability")).status).toBe(200);
  // A replayed consent derives the same name; its new capability is refused.
  expect((await mint("replayed-capability")).status).toBe(409);
});
