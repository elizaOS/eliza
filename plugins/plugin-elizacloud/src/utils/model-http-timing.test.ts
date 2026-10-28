import {listenLoopbackHttp} from "../../../../packages/app/test/fixtures/loopback-server.ts";
import ts from "typescript";
import { expect, test } from "vitest";
import {
  createModelHttpTiming,
  type ModelHttpObservation,
} from "./model-http-timing";
test("real loopback fetch observes headers/body separately without consuming or leaking response", async () => {
  const events: ModelHttpObservation[] = [];
  const server = await listenLoopbackHttp(()=>{
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("PRIVATE_"));
            setTimeout(() => {
              c.enqueue(new TextEncoder().encode("BODY"));
              c.close();
            }, 30);
          },
        }),
        {
          headers: {
            "server-timing":
              'entry_dispatch;dur=20,auth_resolve;dur=10,gateway_preforward;dur=15,unknown;dur=999;desc="PRIVATE_HEADER"',
            "x-eliza-trace-id": "a".repeat(32),
            authorization: "SECRET",
          },
        },
      );
    });
  try {
    const timing = createModelHttpTiming(
      "chat/completions",
      "a".repeat(32),
      (e) => events.push(e),
    );
    const observed = await timing.request(() => fetch(server.url), 3);
    expect(observed.response.bodyUsed).toBe(false);
    expect(await observed.response.text()).toBe("PRIVATE_BODY");
    observed.bodyDone("completed");
    observed.bodyDone("failed");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      phase: "headers",
      queueWaitMs: 3,
      correlated: true,
      serverTimingMs: {
        entry_dispatch: 20,
        auth_resolve: 10,
        gateway_preforward: 15,
      },
    });
    expect(events[1].durationMs).toBeGreaterThanOrEqual(15);
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|SECRET|unknown/);
  } finally {
    await server.close();
  }
});
test("attempts keep one correlation group and malformed headers or sink never alter transport", async () => {
  const events: ModelHttpObservation[] = [];
  const timing = createModelHttpTiming(
    "chat/completions:stream",
    undefined,
    (e) => events.push(e),
  );
  for (const status of [503, 200]) {
    const raw = new Response("opaque", {
      status,
      headers: {
        "server-timing":
          "auth_resolve;dur=NaN,cloud_worker;dur=2,cloud_worker;dur=3",
        "x-eliza-trace-id": "PRIVATE",
      },
    });
    const x = await timing.request(async () => raw);
    expect(x.response).toBe(raw);
    await x.response.text();
    x.bodyDone("completed");
  }
  expect(
    events.filter((e) => e.phase === "headers").map((e) => e.attempt),
  ).toEqual([1, 2]);
  expect(new Set(events.map((e) => e.diagnosticId)).size).toBe(1);
  expect(events[0].upstreamTraceId).toBeUndefined();
  expect(events[0].serverTimingMs).toBeUndefined();
  const x = await createModelHttpTiming("responses", undefined, () => {
    throw Error("sink");
  }).request(async () => new Response("same"));
  expect(await x.response.text()).toBe("same");
  x.bodyDone("completed");
});
test("original transport errors preserve identity and bounded static failed outcome", async () => {
  const rows: ModelHttpObservation[] = [];
  const error = new Error("PRIVATE");
  const t = createModelHttpTiming("responses", undefined, (e) => rows.push(e));
  await expect(
    t.request(async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ phase: "headers", outcome: "failed" });
  expect(JSON.stringify(rows)).not.toContain("PRIVATE");
});

test("real Cloud SDK requestRaw preserves loopback response and private content stays outside diagnostics", async () => {
  const { ElizaCloudClient } = await import("@elizaos/cloud-sdk");
  const events: ModelHttpObservation[] = [];
  const server = await listenLoopbackHttp((req)=>{
      expect(new URL(req.url).pathname).toBe("/api/v1/chat/completions");
      return Response.json(
        { choices: [{ message: { content: "PRIVATE_RESPONSE" } }] },
        {
          headers: {
            "Server-Timing":
              'gateway_auth;dur=11,auth_cache_read;dur=3,upstream_headers;dur=20;desc="PRIVATE_VENDOR"',
            "X-Eliza-Trace-Id": "b".repeat(32),
            "X-Eliza-Auth-Trace":
              "v=1;read=hit;result=authorized_cache;credential=PRIVATE_CREDENTIAL",
          },
        },
      );
    });
  try {
    const client = new ElizaCloudClient({
      baseUrl: server.url.origin,
      apiBaseUrl: server.url.origin + "/api/v1",
      apiKey: "fake-key-only-loopback",
    }).v1;
    const timing = createModelHttpTiming(
      "chat/completions",
      "b".repeat(32),
      (e) => events.push(e),
    );
    const x = await timing.request(() =>
      client.requestRaw("POST", "/chat/completions", {
        json: { messages: [{ role: "user", content: "PRIVATE_PROMPT" }] },
        timeoutMs: 1000,
      }),
    );
    expect(await x.response.json()).toEqual({
      choices: [{ message: { content: "PRIVATE_RESPONSE" } }],
    });
    x.bodyDone("completed");
    expect(events[0]).toMatchObject({
      correlated: true,
      admissionCacheRead: "hit",
      admissionResult: "authorized_cache",
      serverTimingMs: {
        gateway_auth: 11,
        auth_cache_read: 3,
        upstream_headers: 20,
      },
    });
    expect(JSON.stringify(events)).not.toMatch(/PRIVATE|fake-key/);
  } finally {
    await server.close();
  }
});

test("actual production retry wrapper records each attempt and original body while preserving retry control", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../models/text.ts", import.meta.url),
    "utf8",
  );
  const a = src.indexOf("export async function requestNativeWithWarmingRetry("),
    b = src.indexOf("\nconst NATIVE_TOOL_CALL_ERROR_CODE", a);
  expect(a).toBeGreaterThan(0);
  const rows: ModelHttpObservation[] = [];
  const production = new Function(
    "createModelHttpTiming",
    "withNativeChatLimit",
    "recordGatewayResponseTelemetry",
    "nextWarmingRetryDelayMs",
    "isWarmingUnavailableResponse",
    "ElizaCloudGatewayWarmingExhaustedError",
    "logger",
    "sleepMs",
    "WARMING_RETRY_DELAYS_MS",
    ts.transpileModule(src.slice(a, b).replace("export ", ""), {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText + ";return requestNativeWithWarmingRetry;",
  )(
    (route: string, trace?: string) =>
      createModelHttpTiming(route, trace, (e) => rows.push(e)),
    async (fn: () => Promise<unknown>) => fn(),
    () => {},
    (state: { attempt: number }) => (state.attempt++ === 0 ? 0 : undefined),
    () => false,
    Error,
    { warn() {} },
    async () => {},
    [0],
  );
  let calls = 0;
  const result = await production(
    async () =>
      new Response(++calls === 1 ? "warming" : "PRIVATE_FINAL", {
        status: calls === 1 ? 503 : 200,
        headers: {
          "X-Eliza-Trace-Id": "c".repeat(32),
          "Server-Timing": "cloud_worker;dur=17",
        },
      }),
    "chat/completions",
    undefined,
    "c".repeat(32),
  );
  expect(calls).toBe(2);
  expect(result.bodyText).toBe("PRIVATE_FINAL");
  expect(
    rows.filter((e) => e.phase === "headers").map((e) => e.status),
  ).toEqual([503, 200]);
  expect(rows.filter((e) => e.phase === "body")).toHaveLength(2);
  expect(new Set(rows.map((e) => e.diagnosticId)).size).toBe(1);
  expect(JSON.stringify(rows)).not.toContain("PRIVATE_FINAL");
});

test('actual stream limiter diagnostic uses one monotonic clock while legacy wall span stays intact',async()=>{const{readFileSync}=await import('node:fs');const src=readFileSync(new URL('../models/text.ts',import.meta.url),'utf8');const start=src.indexOf('    const waitStartedAt = Date.now();',src.indexOf('const modelHttpTiming = createModelHttpTiming'));expect(start).toBeGreaterThan(0);const end=src.indexOf('    if (response.status !== 503) break;',start);expect(end).toBeGreaterThan(start);let mono=100,observedWait:number|undefined;let wallDuration:number|undefined;const fn=new Function('performance','Date','limiter','recordInferenceSpan','preparedRequest','modelHttpTiming','createCloudApiClient','runtime','headers','requestBody','signal','releasePermit',`return(async()=>{let permitReleased=true,response,bodyDone;${src.slice(start,end)}return response;})();`);const original=new Response('same');const response=await fn({now:()=>mono},{now:()=>1700000000000},{acquire:async()=>{mono=137;}},(_name:string,n:number)=>{wallDuration=n;},{assertBeforeAttempt(){}},{request:async(run:()=>Promise<Response>,queueWait:number)=>{observedWait=queueWait;return{response:await run(),bodyDone(){}};}},()=>({requestRaw:async()=>original}),{}, {},{},undefined,()=>{});expect(response).toBe(original);expect(observedWait).toBe(37);expect(observedWait).toBeGreaterThanOrEqual(0);expect(wallDuration).toBe(0);});
