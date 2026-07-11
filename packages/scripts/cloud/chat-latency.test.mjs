import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenAiRequestBody,
  consumeOpenAiEvent,
  parseProbeCase,
  parseServerTiming,
  readSse,
  safeHttpError,
  selectedResponseHeaders,
} from "./chat-latency.mjs";

test("parseProbeCase preserves model, reasoning mode, and token cap", () => {
  assert.deepEqual(parseProbeCase("zai-glm-4.7@none@512"), {
    model: "zai-glm-4.7",
    reasoningEffort: "none",
    maxTokens: 512,
  });
  assert.deepEqual(parseProbeCase("gemma-4-31b"), {
    model: "gemma-4-31b",
    reasoningEffort: "omit",
    maxTokens: 512,
  });
  assert.throws(
    () => parseProbeCase("zai-glm-4.7@invalid@512"),
    /Unsupported reasoning effort/,
  );
  assert.throws(
    () => parseProbeCase("gemma-4-31b@none@0"),
    /max_tokens must be an integer/,
  );
});

test("buildOpenAiRequestBody omits rather than fabricates reasoning_effort", () => {
  const omitted = buildOpenAiRequestBody(
    parseProbeCase("gemma-4-31b@omit@512"),
    "private prompt",
  );
  assert.equal("reasoning_effort" in omitted, false);
  assert.equal(omitted.max_tokens, 512);

  const disabled = buildOpenAiRequestBody(
    parseProbeCase("zai-glm-4.7@none@512"),
    "private prompt",
  );
  assert.equal(disabled.reasoning_effort, "none");
});

test("parseServerTiming returns only valid non-negative durations", () => {
  assert.deepEqual(
    parseServerTiming(
      'gateway_auth;dur=2.25, gateway_middle;dur="10", bad;dur=-1, no-duration',
    ),
    {
      gateway_auth: 2.25,
      gateway_middle: 10,
    },
  );
});

test("selectedResponseHeaders excludes authorization and arbitrary headers", () => {
  const selected = selectedResponseHeaders(
    new Headers({
      authorization: "Bearer secret",
      "cf-ray": "ray-id",
      "server-timing": "gateway_auth;dur=2",
      "x-untrusted": "private",
    }),
  );
  assert.deepEqual(selected, {
    "cf-ray": "ray-id",
    "server-timing": "gateway_auth;dur=2",
  });
});

test("consumeOpenAiEvent separates hidden reasoning from visible content", () => {
  assert.deepEqual(
    consumeOpenAiEvent({
      choices: [
        {
          delta: {
            reasoning_content: "hidden",
            content: "visible",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 7,
        total_tokens: 12,
        private_internal_counter: 99,
      },
    }),
    {
      content: "visible",
      reasoning: "hidden",
      finishReason: "stop",
      usage: {
        prompt_tokens: 5,
        completion_tokens: 7,
        total_tokens: 12,
      },
      providerError: null,
    },
  );
});

test("readSse records first event, reasoning, visible token, and usage", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
        ),
      );
      controller.enqueue(
        encoder.encode(
          'data: {"choices":[{"delta":{"content":"proof"}}],"usage":{"total_tokens":9}}\n',
        ),
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  const readings = [110, 112, 130];
  const result = await readSse(body, 100, consumeOpenAiEvent, () =>
    readings.shift(),
  );

  assert.equal(result.firstEventMs, 10);
  assert.equal(result.firstReasoningMs, 12);
  assert.equal(result.firstTokenMs, 30);
  assert.equal(result.reasoningCharacters, 5);
  assert.equal(result.outputCharacters, 5);
  assert.equal(result.outputText, "proof");
  assert.deepEqual(result.usage, { total_tokens: 9 });
});

test("safeHttpError never returns an upstream message or body", async () => {
  const response = new Response(
    JSON.stringify({
      error: {
        type: "invalid_request_error",
        code: "bad_model",
        message: "prompt and credential-like detail must stay private",
      },
    }),
    { status: 400 },
  );
  const error = await safeHttpError(response);
  assert.deepEqual(error, {
    status: 400,
    type: "invalid_request_error",
    code: "bad_model",
  });
  assert.equal("message" in error, false);
});
