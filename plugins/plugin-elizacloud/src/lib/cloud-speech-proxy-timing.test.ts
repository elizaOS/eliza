import ts from "typescript";
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { timeSpeechProxyFetch, speechUpstreamTraceId } from "./cloud-speech-proxy-timing";
import { warmingRetryWaitSeconds } from "../utils/warming";
test("failed attempt, unchanged retry decision and successful headers retain separate safe trace timing", async () => {
  const logs: any[] = [];
  let calls = 0;
  const scope = { kind: "tts" as const, proxyRequestId: "local-request", candidate: 0 };
  const failed = await timeSpeechProxyFetch(
    async () => {
      calls++;
      return Response.json(
        {
          error: {
            code: "service_unavailable",
            type: "service_unavailable",
            reason: "rate_limit_unavailable",
            message: "never retain speech or key",
          },
        },
        { status: 503, headers: { "X-Eliza-Trace-Id": "a".repeat(32), "CF-Ray":"0123456789abcdef-LAX", "Server-Timing":'entry_dispatch;dur=9900, cloud_worker;dur=1850, auth;dur=1750;desc="never retain speech or key"' } }
      );
    },
    { ...scope, attempt: 1 },
    (x) => logs.push(x)
  );
  const wait = await warmingRetryWaitSeconds(failed, (x) =>
    logs.push({ ...scope, phase: "retry_decision", ...x })
  );
  expect(wait).toBe(1.5);
  const ok = await timeSpeechProxyFetch(
    async () => {
      calls++;
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "X-Eliza-Trace-Id": "b".repeat(32), "CF-Ray":"fedcba9876543210-SJC", "Server-Timing":"entry_dispatch;dur=800, cloud_worker;dur=700, auth;dur=12" },
      });
    },
    { ...scope, attempt: 2 },
    (x) => logs.push(x)
  );
  expect(new Uint8Array(await ok.arrayBuffer()).length).toBe(3);
  expect(calls).toBe(2);
  expect(logs[0].status).toBe(503);
  expect(logs[0].upstreamTraceId).toBe("a".repeat(32));
  expect(logs[0]).toMatchObject({attempt:1,upstreamCfRay:"0123456789abcdef-LAX",upstreamServerTimingMs:{entry_dispatch:9900,cloud_worker:1850,auth:1750}});
  expect(logs[1].reason).toBe("rate_limit_unavailable");
  expect(logs[2].status).toBe(200);
  expect(logs[2]).toMatchObject({attempt:2,upstreamCfRay:"fedcba9876543210-SJC",upstreamTraceId:"b".repeat(32),upstreamServerTimingMs:{entry_dispatch:800,cloud_worker:700,auth:12}});
  expect(JSON.stringify(logs)).not.toContain("never retain");
});
test("paid refusal retry decisions and caller abort identity remain unchanged", async () => {
  for (const status of [400, 401, 402, 403, 429, 500])
    expect(await warmingRetryWaitSeconds(new Response("{}", { status }))).toBeNull();
  expect(
    await warmingRetryWaitSeconds(
      Response.json({ code: "service_unavailable", retryAfter: 9 }, { status: 503 })
    )
  ).toBe(3);
  expect(
    await warmingRetryWaitSeconds(Response.json({ code: "other" }, { status: 503 }))
  ).toBeNull();
  const stopped = new DOMException("stopped", "AbortError");
  let calls = 0;
  await expect(
    timeSpeechProxyFetch(
      async () => {
        calls++;
        throw stopped;
      },
      { kind: "tts", proxyRequestId: "owned", candidate: 0, attempt: 1 },
      () => {
        throw Error("sink");
      }
    )
  ).rejects.toBe(stopped);
  expect(calls).toBe(1);
});
test("unknown machine fields and arbitrary trace headers are never retained", async () => {
  const rows: any[] = [];
  await warmingRetryWaitSeconds(
    Response.json(
      {
        error: {
          code: "service_unavailable",
          reason: "eliza_privatecredential",
          message: "secret",
          type: "injected header",
        },
      },
      { status: 503 }
    ),
    (x) => rows.push(x)
  );
  expect(rows[0].reason).toBeUndefined();
  expect(rows[0].type).toBeUndefined();
  expect(JSON.stringify(rows)).not.toContain("privatecredential");
  expect(
    speechUpstreamTraceId(new Response("", { headers: { "X-Eliza-Trace-Id": "untrusted-value" } }))
  ).toBeUndefined();
});
test("actual TTS body drain and attempt wrappers execute without buffering extra audio", async () => {
  const source = readFileSync(new URL("./server-cloud-tts.ts", import.meta.url), "utf8");
  const from = source.indexOf("        const drainStarted=Date.now();"),
    to = source.indexOf("        client.signal.throwIfAborted();", from);
  const body = ts.transpileModule("async function runDrain(){" + source.slice(from, to) + ";return audioBuffer;}", {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const logs: any[] = [];
  const run = new Function(
    "cloudResponse",
    "emitSpeechProxyTiming",
    "timingSink",
    "proxyRequestId",
    "successfulCandidate",
    "speechUpstreamTraceId",
    body + ";return runDrain();"
  );
  const result = await run(
    new Response(new Uint8Array([1, 2, 3])),
    (sink: any, value: any) => sink(value),
    (value: any) => logs.push(value),
    "owned",
    0,
    speechUpstreamTraceId
  );
  expect(result.length).toBe(3);
  expect(logs[0]).toMatchObject({ phase: "body_drain", outcome: "returned", bytes: 3 });
  expect(typeof logs[0].durationMs).toBe("number");
  expect(source).not.toContain("authorization cache warming (503), retry");
  expect((source.match(/attempt = await timeSpeechProxyFetch/g) || []).length).toBe(2);
  expect(source).toContain("warmingRetries >= 2");
  expect(source).toContain("shouldRetryCloudTtsUpstream(attempt.status)");
});

test("response diagnostics drop malformed, oversized, duplicate and description-injected timing without changing responses", async () => {
  const samples = [
    {raw:'entry_dispatch;dur=1;desc="secret, auth;dur=999", auth;dur=2',metrics:{entry_dispatch:1,auth:2}},
    {raw:'auth;dur=NaN, cloud_worker;dur=-1, synthesis;dur=600001, pricing;dur=1e3, unknown;dur=5',metrics:undefined},
    {raw:'auth;dur=1, auth;dur=2, auth;dur=3, entry_dispatch;dur=4',metrics:{entry_dispatch:4}},
    {raw:'auth;dur=3;dur=4',metrics:undefined},
    {raw:'auth;dur=3;desc="unterminated',metrics:undefined},
    {raw:'auth;dur=3;desc="'+ 'secret'.repeat(700)+'"',metrics:undefined},
  ];
  for (const {raw,metrics} of samples) {
    const rows:any[]=[];
    const response=new Response("unchanged",{status:403,headers:{"Server-Timing":raw,"CF-Ray":"secret, untrusted","X-Eliza-Trace-Id":"private-key","Authorization":"Bearer secret","X-Secret":"secret"}});
    expect(await timeSpeechProxyFetch(async()=>response,{kind:"stt",proxyRequestId:"owned",candidate:0,attempt:1},value=>rows.push(value))).toBe(response);
    expect(rows[0].upstreamServerTimingMs).toEqual(metrics);
    expect(rows[0].upstreamCfRay).toBeUndefined();
    expect(rows[0].upstreamTraceId).toBeUndefined();
    expect(JSON.stringify(rows)).not.toMatch(/secret|private-key|Authorization|X-Secret|desc=/);
  }
});
