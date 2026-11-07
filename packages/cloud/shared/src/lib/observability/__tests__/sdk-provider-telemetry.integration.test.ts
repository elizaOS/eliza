import { test } from "bun:test";
import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer } from "node:http";
import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, streamText, tool } from "ai";
import {
  beginSdkStreamTiming,
  bindSdkStreamTiming,
  clearCloudTelemetry,
  getCloudTelemetrySnapshot,
  observeCerebrasFetch,
  observeCloudRequest,
} from "../cloud-backend-observability";

// Real local HTTP/SSE and the locked SDK own transport, parsing and retries.
test("native provider timing preserves HTTP response, SDK output and retry ownership", async () => {
  clearCloudTelemetry();
  const output = "OUTPUT_CANARY_NOT_A_LOG_FIELD";
  const secret = "LOCAL_KEY_CANARY_NOT_A_LOG_FIELD";
  const calls: Array<{ path: string; body: string }> = [];
  const logs: unknown[][] = [];
  const info = console.info;
  const originalFetch = globalThis.fetch;
  let actualResponse: Response | undefined;
  console.info = (...args: unknown[]) => {
    logs.push(args);
  };
  globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
    actualResponse = await originalFetch(...args);
    return actualResponse;
  }) as typeof fetch;
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const bytes of req) body += bytes;
    calls.push({ path: req.url ?? "", body });
    if (req.url?.startsWith("/retry") && calls.filter((call) => call.path === req.url).length < 3) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: { message: "owned fixture unavailable" } }));
      return;
    }
    const timeInfo = req.url?.startsWith("/missing")
      ? undefined
      : req.url?.startsWith("/invalid")
        ? { queue_time: -1, prompt_time: "1", completion_time: 1e10, total_time: null }
        : {
            queue_time: 0.002,
            prompt_time: 0.003,
            completion_time: 0.004,
            total_time: 0.009,
            canary: secret,
          };
    const frame = (choices: unknown[], rest = {}) =>
      `data: ${JSON.stringify({ id: "owned-response", object: "chat.completion.chunk", created: 1, model: "owned-fixture-model", choices, ...rest })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame([{ index: 0, delta: { role: "assistant" }, finish_reason: null }]));
    res.write(
      frame([
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "owned-tool-call",
                type: "function",
                function: { name: "reply", arguments: '{"value":"' },
              },
            ],
          },
          finish_reason: null,
        },
      ]),
    );
    setTimeout(() => {
      res.write(
        frame([
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, function: { arguments: `${output}"}` } }] },
            finish_reason: null,
          },
        ]),
      );
      res.write(
        frame([{ index: 0, delta: {}, finish_reason: "tool_calls" }], {
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
          ...(timeInfo && { time_info: timeInfo }),
        }),
      );
      res.end("data: [DONE]\n\n");
    }, 15);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const run = async (kind: string, instrumented: boolean) =>
    observeCloudRequest(
      { id: kind, traceId: `owned-${kind}`, path: "/api/v1/chat/completions", method: "POST" },
      async () => {
        const timing = instrumented
          ? beginSdkStreamTiming(`owned-${kind}`, "owned-fixture-model")
          : undefined;
        return bindSdkStreamTiming(timing, async () => {
          const provider = createOpenAI({
            apiKey: secret,
            baseURL: `${base}/${kind}/v1`,
            ...(instrumented && { fetch: observeCerebrasFetch as typeof fetch }),
          });
          const parts: unknown[] = [];
          const result = streamText({
            model: provider.chat("owned-fixture-model"),
            prompt: "PROMPT_CANARY_NOT_A_LOG_FIELD",
            includeRawChunks: instrumented,
            maxRetries: 2,
            tools: {
              reply: tool({
                inputSchema: jsonSchema<{ value: string }>({
                  type: "object",
                  properties: { value: { type: "string" } },
                  required: ["value"],
                }),
              }),
            },
            toolChoice: "required",
          });
          let complete = false;
          try {
            for await (const part of result.fullStream) {
              timing?.part(part);
              if (
                ["tool-input-start", "tool-input-delta", "tool-call", "text-delta"].includes(
                  part.type,
                )
              ) {
                timing?.enqueue();
                parts.push(part);
              }
            }
            complete = true;
          } finally {
            timing?.finish(!complete);
            timing?.finish(!complete);
          }
          return { result: parts, status: 200 };
        })();
      },
    );
  try {
    const baseline = await run("normal", false);
    const observed = await run("normal", true);
    assert.deepEqual(observed, baseline);
    assert.equal(calls.filter((call) => call.path === "/normal/v1/chat/completions").length, 2);
    assert.equal(calls[0].body, calls[1].body);
    const event = getCloudTelemetrySnapshot().streamMilestones[0];
    assert.deepEqual(event.providerTimeInfoMs, {
      queueMs: 2,
      promptMs: 3,
      generationMs: 4,
      totalMs: 9,
    });
    assert.equal(event.providerAttempts?.length, 1);
    assert(event.firstToolArgumentsMs !== null && event.firstToolArgumentsMs !== undefined);
    await run("missing", true);
    assert.deepEqual(getCloudTelemetrySnapshot().streamMilestones[0].providerTimeInfoMs, {
      queueMs: null,
      promptMs: null,
      generationMs: null,
      totalMs: null,
    });
    await run("invalid", true);
    assert.deepEqual(getCloudTelemetrySnapshot().streamMilestones[0].providerTimeInfoMs, {
      queueMs: null,
      promptMs: null,
      generationMs: null,
      totalMs: null,
    });
    await run("retry", true);
    assert.equal(calls.filter((call) => call.path === "/retry/v1/chat/completions").length, 3);
    assert.equal(getCloudTelemetrySnapshot().streamMilestones[0].providerAttempts?.length, 3);
    const response = await observeCloudRequest(
      {
        id: "identity",
        traceId: "owned-identity",
        path: "/api/v1/chat/completions",
        method: "POST",
      },
      async () => {
        const timing = beginSdkStreamTiming("owned-identity", "owned-fixture-model");
        return bindSdkStreamTiming(timing, async () => {
          const response = await observeCerebrasFetch(`${base}/identity`, {
            method: "POST",
            body: "owned raw identity request",
          });
          assert.equal(response, actualResponse);
          const bytes = await response.text();
          assert(bytes.includes(output) && bytes.endsWith("data: [DONE]\n\n"));
          timing.finish(false);
          return { result: response, status: 200 };
        })();
      },
    );
    assert.equal(response, actualResponse);
    await observeCloudRequest(
      { id: "cancel", traceId: "owned-cancel", path: "/api/v1/chat/completions", method: "POST" },
      async () => {
        const timing = beginSdkStreamTiming("owned-cancel", "owned-fixture-model");
        return bindSdkStreamTiming(timing, async () => {
          const controller = new AbortController();
          const response = await observeCerebrasFetch(`${base}/cancel`, {
            signal: controller.signal,
          });
          assert.equal(response, actualResponse);
          controller.abort();
          await assert.rejects(response.text());
          timing.finish(true);
          return { result: undefined, status: 200 };
        })();
      },
    );
    assert.equal(getCloudTelemetrySnapshot().streamMilestones[0].aborted, true);
    assert.equal(getCloudTelemetrySnapshot().streamMilestones[0].completionMs, null);
    await observeCloudRequest(
      {
        id: "isolation",
        traceId: "owned-isolation-parent",
        path: "/api/v1/chat/completions",
        method: "POST",
      },
      async () => {
        // Created in the parent before either child; it must not become a stream attempt.
        const background = Promise.resolve().then(async () =>
          (await observeCerebrasFetch(`${base}/background`)).text(),
        );
        const a = beginSdkStreamTiming("owned-child-a", "owned-fixture-model");
        const b = beginSdkStreamTiming("owned-child-b", "owned-fixture-model");
        await Promise.all([
          background,
          bindSdkStreamTiming(a, async () => {
            await (await observeCerebrasFetch(`${base}/child-a`)).text();
            a.finish(false);
          })(),
          bindSdkStreamTiming(b, async () => {
            await (await observeCerebrasFetch(`${base}/child-b`)).text();
            b.finish(false);
          })(),
        ]);
        return { result: undefined, status: 200 };
      },
    );
    for (const trace of ["owned-child-a", "owned-child-b"])
      assert.equal(
        getCloudTelemetrySnapshot().streamMilestones.find((event) => event.traceId === trace)
          ?.providerAttempts?.length,
        1,
      );
    await Promise.all([run("overlap-a", true), run("overlap-b", true)]);
    for (const trace of ["owned-overlap-a", "owned-overlap-b"])
      assert.equal(
        getCloudTelemetrySnapshot().streamMilestones.find((event) => event.traceId === trace)
          ?.providerAttempts?.length,
        1,
      );
    const syncFailure = beginSdkStreamTiming("owned-sync-failure", "owned-fixture-model");
    syncFailure.finish(true);
    const zero = getCloudTelemetrySnapshot().streamMilestones[0];
    assert.deepEqual(zero.providerAttempts, []);
    assert.equal(zero.upstreamHeadersMs, null);
    assert.equal(zero.sdkToProviderDispatchMs, null);
    assert.equal(zero.firstEventMs, null);
    assert.equal(logs.length, 11); // Baseline emits none; duplicate finish emits no extra event.
    const retained = JSON.stringify({
      logs,
      telemetry: getCloudTelemetrySnapshot().streamMilestones,
    });
    for (const canary of [output, secret, "PROMPT_CANARY_NOT_A_LOG_FIELD"])
      assert(!retained.includes(canary));
    assert.equal(calls.length, 14);
  } finally {
    globalThis.fetch = originalFetch;
    console.info = info;
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  }
}, 30_000);
