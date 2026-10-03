import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import {
  buildMetric,
  checkShouldRespondSchema,
  summarize,
  tryParseJson,
} from "../src/metrics.ts";
import { CerebrasMode } from "../src/modes/cerebras.ts";
import { buildTableRows } from "../src/report.ts";
import type { ModeRequest } from "../src/types.ts";

const request: ModeRequest = {
  taskId: "should_respond",
  caseId: "case",
  systemPrompt: "Output JSON",
  userPrompt: "Hello",
  jsonSchema: { type: "object" },
  skeletonHint: { type: "object", freeFields: [] },
  maxTokens: 256,
};
for (const usage of [undefined, 0, 7]) {
  test(`HTTP usage ${usage} survives scoring and report rendering`, async () => {
    const server = createServer((req, res) => {
      req.resume();
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: '{"shouldRespond":"RESPOND"}',
              },
            },
          ],
          ...(usage === undefined
            ? {}
            : {
                usage: {
                  completion_tokens: usage,
                  prompt_tokens: 2,
                  total_tokens: usage + 2,
                },
              }),
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const mode = new CerebrasMode({
        apiKey: "local-fixture",
        endpoint: `http://127.0.0.1:${address.port}/completions`,
      });
      assert.equal(await mode.available(), null);
      const result = await mode.generate(request);
      assert.equal(result.tokensGenerated, usage ?? null);
      const metric = buildMetric({
        taskId: "should_respond",
        modeId: "cerebras",
        caseId: "case",
        result,
        parse_success: true,
        schema_valid: true,
        label_match: true,
      });
      assert.equal(metric.tokens_generated, usage ?? null);
      const summary = summarize([metric])[0];
      assert.equal(
        summary.token_usage_observed_cases,
        usage === undefined ? 0 : 1,
      );
      if (usage === undefined) {
        assert.equal(summary.mean_tokens_per_second, null);
        assert.equal(buildTableRows([summary])[1].at(-1), "n/a");
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
}

test("parse failures remain in accuracy denominator and prose is not repaired", () => {
  for (const raw of [
    'prose {"shouldRespond":"RESPOND"}',
    '```json\n{"shouldRespond":"RESPOND"}\n```',
    '{"shouldRespond":"RESPOND"} trailing',
  ])
    assert.equal(tryParseJson(raw), null);
  assert.equal(
    checkShouldRespondSchema({ shouldRespond: "RESPOND", extra: true }),
    false,
  );
  const base = {
    taskId: "should_respond" as const,
    modeId: "cerebras" as const,
    caseId: "case",
    result: {
      rawOutput: "",
      firstTokenLatencyMs: null,
      totalLatencyMs: 100,
      tokensGenerated: null,
    },
    parse_success: false,
    schema_valid: false,
    label_match: null,
  };
  const failed = buildMetric(base);
  const passed = buildMetric({
    ...base,
    parse_success: true,
    schema_valid: true,
    label_match: true,
  });
  assert.equal(summarize([failed, passed])[0].label_match_rate, 0.5);
});

test("HTTP fallback attempts sum observed usage over the measured duration", async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    calls++;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: "assistant",
              content: calls === 1 ? "" : '{"shouldRespond":"RESPOND"}',
            },
          },
        ],
        usage: {
          prompt_tokens: 2,
          completion_tokens: calls === 1 ? 3 : 5,
          total_tokens: 10,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const mode = new CerebrasMode({
      apiKey: "local-fixture",
      endpoint: `http://127.0.0.1:${address.port}`,
    });
    await mode.available();
    const result = await mode.generate(request);
    assert.equal(calls, 2);
    assert.equal(result.tokensGenerated, 8);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
