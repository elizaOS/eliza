/** Exercises loopback auth, OpenAI response shape, readiness, provenance, and audit redaction offline. */

import { afterEach, describe, expect, it } from "vitest";
import type {
  ClaudeCompletionResult,
  ClaudeSubscriptionGatewayHandle,
  CompletionContext,
  CompletionRunner,
  GatewayContentContract,
} from "../src/index.js";
import {
  ClaudeRateLimitError,
  FairHarnessQueue,
  GatewayStorageError,
  parseGatewayContentContract,
  startClaudeSubscriptionGateway,
} from "../src/index.js";

const ELIZA_TOKEN = "eliza-token-00000000000000000000000000000001";
const HERMES_TOKEN = "hermes-token-0000000000000000000000000000001";
const OPENCLAW_TOKEN = "openclaw-token-00000000000000000000000000001";

class FakeCompletionRunner implements CompletionRunner {
  readonly calls: CompletionContext[] = [];

  async complete(context: CompletionContext) {
    this.calls.push(context);
    return {
      text: "PONG",
      toolCalls: [],
      model: "claude-opus-4-8-actual",
      claudeCodeVersion: "test-cli",
      sdkApiKeySource: "none" as const,
      resultSubtype: "success",
      terminalReason: "completed",
      usage: {
        inputTokens: 11,
        outputTokens: 2,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
      },
    };
  }
}

class FakeToolCompletionRunner implements CompletionRunner {
  readonly calls: CompletionContext[] = [];

  async complete(context: CompletionContext): Promise<ClaudeCompletionResult> {
    this.calls.push(context);
    return {
      text: "",
      toolCalls: [
        { id: "call_weather", name: "weather", arguments: { city: "Paris" } },
      ],
      model: "claude-opus-4-8-actual",
      claudeCodeVersion: "test-cli",
      sdkApiKeySource: "none",
      resultSubtype: "error_max_turns",
      terminalReason: "max_turns",
      usage: {
        inputTokens: 11,
        outputTokens: 2,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 4,
      },
    };
  }
}

function parseSse(body: string): unknown[] {
  return body
    .trim()
    .split("\n\n")
    .map((event) => event.slice("data: ".length))
    .map((data) => (data === "[DONE]" ? data : JSON.parse(data)));
}

const handles: ClaudeSubscriptionGatewayHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

async function start(
  runner:
    | FakeCompletionRunner
    | FakeToolCompletionRunner = new FakeCompletionRunner(),
  contentContract?: GatewayContentContract,
) {
  let monotonic = 0;
  const handle = await startClaudeSubscriptionGateway({
    completionRunner: runner,
    harnessTokens: {
      eliza: ELIZA_TOKEN,
      hermes: HERMES_TOKEN,
      openclaw: OPENCLAW_TOKEN,
    },
    queue: new FairHarnessQueue({ now: () => monotonic }),
    monotonicNow: () => monotonic,
    now: () => new Date("2026-07-20T12:00:00.000Z"),
    requestIdFactory: () => "fixed-request-id",
    contentContract,
  });
  handles.push(handle);
  return { handle, runner, advance: (ms: number) => (monotonic += ms) };
}

describe("startClaudeSubscriptionGateway", () => {
  it("publishes a content-free transport readiness contract and exact harness env", async () => {
    const { handle } = await start();
    const healthResponse = await fetch(handle.healthUrl);
    const health = await healthResponse.json();

    expect(healthResponse.status).toBe(200);
    expect(health).toMatchObject({
      status: "ok",
      readiness: "transport-only",
      bind: { host: "127.0.0.1", loopback: true },
      auth: { scheme: "bearer", harness_tokens: 3 },
      transport: {
        provider: "claude-agent-sdk",
        fresh_session_per_request: true,
        tool_execution: "capture-only",
        response_modes: ["json", "sse"],
      },
    });
    expect(JSON.stringify(health)).not.toContain(ELIZA_TOKEN);
    expect(handle.envForHarness("hermes")).toEqual({
      CLAUDE_SUBSCRIPTION_GATEWAY_URL: handle.origin,
      CLAUDE_SUBSCRIPTION_GATEWAY_TOKEN: HERMES_TOKEN,
      BENCHMARK_BASE_URL: handle.baseUrl,
      OPENAI_BASE_URL: handle.baseUrl,
      OPENAI_API_KEY: HERMES_TOKEN,
      BENCHMARK_MODEL_PROVIDER: "claude-subscription",
      BENCHMARK_HARNESS: "hermes",
      ELIZA_BENCH_HARNESS: "hermes",
    });
  });

  it("serves an authenticated static chat-model catalog without model work", async () => {
    const { handle, runner } = await start();
    const anonymous = await fetch(`${handle.baseUrl}/models`);
    const response = await fetch(`${handle.baseUrl}/models`, {
      headers: { authorization: `Bearer ${ELIZA_TOKEN}` },
    });
    const body = await response.json();

    expect(anonymous.status).toBe(401);
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      object: "list",
      data: expect.arrayContaining([
        {
          id: "claude-sonnet-4-6",
          object: "model",
          created: 0,
          owned_by: "anthropic",
        },
      ]),
    });
    expect(runner.calls).toHaveLength(0);
    expect(handle.auditStore.snapshot()).toHaveLength(0);
  });

  it("keeps embeddings unsupported instead of fabricating vectors", async () => {
    const { handle, runner } = await start();
    const response = await fetch(`${handle.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ELIZA_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: "do not embed",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ error: { code: "not_found" } });
    expect(runner.calls).toHaveLength(0);
    expect(handle.auditStore.snapshot()).toHaveLength(0);
  });

  it("returns canonical SSE text, finish, usage, and DONE events from one completion", async () => {
    const runner = new FakeCompletionRunner();
    const { handle } = await start(runner);
    const response = await fetch(`${handle.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${OPENCLAW_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "PONG" }],
        stream: true,
      }),
    });
    const events = parseSse(await response.text());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({
      object: "chat.completion.chunk",
      choices: [
        {
          delta: { role: "assistant", content: "PONG" },
          finish_reason: null,
        },
      ],
      gateway: { harness: "openclaw" },
    });
    expect(events[1]).toMatchObject({
      choices: [{ delta: {}, finish_reason: "stop" }],
    });
    expect(events[2]).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 18, completion_tokens: 2, total_tokens: 20 },
    });
    expect(events[3]).toBe("[DONE]");
    expect(runner.calls).toHaveLength(1);
    expect(handle.auditStore.snapshot()).toHaveLength(1);
  });

  it("returns indexed complete tool-call deltas before the SSE finish event", async () => {
    const runner = new FakeToolCompletionRunner();
    const { handle } = await start(runner);
    const response = await fetch(`${handle.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${OPENCLAW_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "Weather?" }],
        tools: [
          {
            type: "function",
            function: {
              name: "weather",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
              },
            },
          },
        ],
        stream: true,
      }),
    });
    const events = parseSse(await response.text());

    expect(events).toHaveLength(5);
    expect(events[1]).toMatchObject({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_weather",
                type: "function",
                function: { name: "weather", arguments: '{"city":"Paris"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    expect(events[2]).toMatchObject({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    });
    expect(events[4]).toBe("[DONE]");
    expect(runner.calls).toHaveLength(1);
  });

  it("maps bearer identity to the fair lane and returns OpenAI provenance", async () => {
    const { handle, runner } = await start();
    const secret = "sk-sensitive-prompt-value";
    const response = await fetch(`${handle.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ELIZA_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: secret }],
        reasoning_effort: "high",
        temperature: 0,
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("x-eliza-benchmark-harness")).toBe("eliza");
    expect(body).toMatchObject({
      object: "chat.completion",
      model: "claude-opus-4-8-actual",
      choices: [
        {
          message: { role: "assistant", content: "PONG" },
          finish_reason: "stop",
        },
      ],
      gateway: {
        harness: "eliza",
        transport: "claude-agent-sdk",
        fresh_session: true,
        tool_execution: "capture-only",
        unapplied_parameters: ["temperature"],
      },
    });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].harness).toBe("eliza");
    const auditText = JSON.stringify(handle.auditStore.snapshot());
    expect(auditText).not.toContain(secret);
    expect(auditText).not.toContain(ELIZA_TOKEN);
    expect(auditText).not.toContain("PONG");
    expect(handle.auditStore.snapshot()[0]).toMatchObject({
      harness: "eliza",
      status: "succeeded",
      modelRequested: "claude-opus-4-8",
      reasoningEffort: "high",
      toolExecution: "capture-only",
    });
  });

  it("attests reviewed message content without retaining it", async () => {
    const contract = parseGatewayContentContract({
      schema_version: 1,
      contract_id: "lifecycle_http_test_v1",
      system_hint: "reviewed shared hint",
      public_user_turns: ["reviewed current request"],
      forbidden_text_by_category: {
        scenario_ids: ["hidden_scenario_id"],
      },
      observed_text_by_category: {
        workspace_paths: ["/native/cwd"],
      },
    });
    const { handle } = await start(new FakeCompletionRunner(), contract);
    const response = await fetch(`${handle.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${HERMES_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [
          {
            role: "system",
            content: "reviewed shared hint running in /native/cwd",
          },
          { role: "user", content: "reviewed current request" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const proof = handle.auditStore.snapshot()[0].contentAttestation;
    expect(proof).toMatchObject({
      contractId: "lifecycle_http_test_v1",
      systemHintInstructionOccurrences: 1,
      systemHintUserOccurrences: 0,
      forbiddenIngressMatchCounts: { scenario_ids: 0 },
      forbiddenIngressMatchTotal: 0,
      observedInstructionMatchCounts: { workspace_paths: 1 },
      observedUserMatchCounts: { workspace_paths: 0 },
      observedIngressMatchCounts: { workspace_paths: 1 },
    });
    const serialized = JSON.stringify(proof);
    expect(serialized).not.toContain("reviewed shared hint");
    expect(serialized).not.toContain("reviewed current request");
    expect(serialized).not.toContain("/native/cwd");
  });

  it("rejects role-blind user echoes before queue or model work", async () => {
    const contract = parseGatewayContentContract({
      schema_version: 1,
      contract_id: "lifecycle_preflight_test_v1",
      system_hint: "reviewed shared hint",
      public_user_turns: ["reviewed current request"],
      forbidden_text_by_category: {
        scenario_ids: ["hidden_scenario_id"],
      },
      observed_text_by_category: {
        workspace_paths: ["/native/cwd"],
      },
    });
    const runner = new FakeCompletionRunner();
    const { handle } = await start(runner, contract);
    const response = await fetch(`${handle.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${HERMES_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [
          { role: "system", content: "reviewed shared hint" },
          { role: "user", content: "unrecognized current request" },
          { role: "assistant", content: "reviewed current request" },
        ],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toMatchObject({
      error: { code: "benchmark_public_user_turn_missing" },
    });
    expect(runner.calls).toHaveLength(0);
    expect(handle.auditStore.snapshot()[0]).toMatchObject({
      status: "failed",
      errorCode: "benchmark_public_user_turn_missing",
      contentAttestation: {
        publicUserMatches: {},
        publicUserGeneratedMatches: expect.any(Object),
      },
    });
  });

  it("rejects reviewed user turns leaked into instructions pre-quota", async () => {
    const contract = parseGatewayContentContract({
      schema_version: 1,
      contract_id: "lifecycle_instruction_leak_test_v1",
      system_hint: "reviewed shared hint",
      public_user_turns: ["reviewed current request"],
      forbidden_text_by_category: { scenario_ids: ["hidden_scenario_id"] },
      observed_text_by_category: { workspace_paths: ["/native/cwd"] },
    });
    const runner = new FakeCompletionRunner();
    const { handle } = await start(runner, contract);
    const response = await fetch(`${handle.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${HERMES_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [
          {
            role: "system",
            content: "reviewed shared hint reviewed current request",
          },
          { role: "user", content: "reviewed current request" },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "benchmark_public_user_turn_in_instruction_content" },
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("rejects reviewed workspace paths in user content pre-quota", async () => {
    const contract = parseGatewayContentContract({
      schema_version: 1,
      contract_id: "lifecycle_workspace_user_leak_test_v1",
      system_hint: "reviewed shared hint",
      public_user_turns: ["reviewed current request"],
      forbidden_text_by_category: { scenario_ids: ["hidden_scenario_id"] },
      observed_text_by_category: { workspace_paths: ["/native/cwd"] },
    });
    const runner = new FakeCompletionRunner();
    const { handle } = await start(runner, contract);
    const response = await fetch(`${handle.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${HERMES_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [
          { role: "system", content: "reviewed shared hint" },
          {
            role: "user",
            content: "reviewed current request in /native/cwd",
          },
        ],
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "benchmark_observed_text_in_user_content" },
    });
    expect(runner.calls).toHaveLength(0);
  });

  it("allows generated scoring labels but rejects ingress leakage pre-quota", async () => {
    const contract = parseGatewayContentContract({
      schema_version: 1,
      contract_id: "lifecycle_forbidden_test_v1",
      system_hint: "reviewed shared hint",
      public_user_turns: ["reviewed current request"],
      forbidden_text_by_category: {
        scoring_behavior_labels: ["spawn_subagent"],
      },
      observed_text_by_category: {
        workspace_paths: ["/native/cwd"],
      },
    });
    const generatedRunner = new FakeCompletionRunner();
    const generated = await start(generatedRunner, contract);
    const generatedResponse = await fetch(
      `${generated.handle.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${HERMES_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-opus-4-8",
          messages: [
            { role: "system", content: "reviewed shared hint" },
            { role: "user", content: "reviewed current request" },
            { role: "assistant", content: "spawn_subagent" },
          ],
        }),
      },
    );
    expect(generatedResponse.status).toBe(200);
    expect(generatedRunner.calls).toHaveLength(1);

    const leakedRunner = new FakeCompletionRunner();
    const leaked = await start(leakedRunner, contract);
    const leakedResponse = await fetch(
      `${leaked.handle.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${HERMES_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-opus-4-8",
          messages: [
            {
              role: "system",
              content: "reviewed shared hint spawn_subagent",
            },
            { role: "user", content: "reviewed current request" },
          ],
        }),
      },
    );
    const leakedBody = await leakedResponse.json();
    expect(leakedResponse.status).toBe(400);
    expect(leakedBody).toMatchObject({
      error: { code: "benchmark_forbidden_ingress_content" },
    });
    expect(leakedRunner.calls).toHaveLength(0);
  });

  it("rejects anonymous, invalid, and cross-harness identities before model work", async () => {
    const { handle, runner } = await start();
    const request = {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "PONG" }],
    };
    const anonymous = await fetch(`${handle.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    const mismatch = await fetch(`${handle.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ELIZA_TOKEN}`,
        "content-type": "application/json",
        "x-benchmark-harness": "hermes",
      },
      body: JSON.stringify(request),
    });

    expect(anonymous.status).toBe(401);
    expect(mismatch.status).toBe(403);
    expect(runner.calls).toHaveLength(0);
  });

  it("refuses non-loopback binds", async () => {
    await expect(
      startClaudeSubscriptionGateway({ host: "0.0.0.0" as "127.0.0.1" }),
    ).rejects.toThrow("only loopback");
  });

  it("latches the first exhausted rate limit across all fair-queue lanes", async () => {
    let completionCalls = 0;
    const runner: CompletionRunner = {
      async complete() {
        completionCalls += 1;
        throw new ClaudeRateLimitError(2_000_000_000_000, "seven_day");
      },
    };
    const handle = await startClaudeSubscriptionGateway({
      completionRunner: runner,
      harnessTokens: {
        eliza: ELIZA_TOKEN,
        hermes: HERMES_TOKEN,
        openclaw: OPENCLAW_TOKEN,
      },
      benchmarkNamespace: "rate-latch-test",
      queue: new FairHarnessQueue({ concurrency: 1 }),
    });
    handles.push(handle);
    const request = (token: string) =>
      fetch(`${handle.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-opus-4-8",
          messages: [{ role: "user", content: "PONG" }],
        }),
      });

    const responses = await Promise.all([
      request(ELIZA_TOKEN),
      request(HERMES_TOKEN),
      request(OPENCLAW_TOKEN),
    ]);
    expect(responses.map((response) => response.status)).toEqual([
      429, 429, 429,
    ]);
    expect(completionCalls).toBe(1);
    expect(handle.auditStore.snapshot()).toHaveLength(3);
    expect(
      handle.auditStore
        .snapshot()
        .every(
          (record) =>
            record.status === "paused" &&
            record.pauseReason === "rate_limit" &&
            record.auditEvent === "pause_control",
        ),
    ).toBe(true);
  });

  it("latches storage reserve failures before any provider call", async () => {
    const runner = new FakeCompletionRunner();
    const handle = await startClaudeSubscriptionGateway({
      completionRunner: runner,
      harnessTokens: {
        eliza: ELIZA_TOKEN,
        hermes: HERMES_TOKEN,
        openclaw: OPENCLAW_TOKEN,
      },
      storageGuard: {
        assertReady() {
          throw new GatewayStorageError();
        },
      },
    });
    handles.push(handle);
    const response = await fetch(`${handle.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${ELIZA_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "PONG" }],
      }),
    });

    expect(response.status).toBe(507);
    expect(await response.json()).toMatchObject({
      error: { code: "insufficient_storage" },
    });
    expect(runner.calls).toHaveLength(0);
    expect(handle.auditStore.snapshot()[0]).toMatchObject({
      status: "paused",
      pauseReason: "storage_reserve",
      auditEvent: "pause_control",
    });
  });
});
