/**
 * Captures credential-redacted wire and trajectory evidence from real Cerebras
 * calls, including success surfaces and provider/transport failures.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type IAgentRuntime, logger, ModelType, runWithTrajectoryContext } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildLiveHarness,
  type LiveAgentHarness,
} from "../../../packages/app-core/test/helpers/live-agent-test";
import {
  type CapturedWireCall,
  type CerebrasWireCapture,
  serializeCerebrasProviderError,
  startCerebrasWireCapture,
  writeCerebrasEvidenceArtifacts,
} from "./helpers/cerebras-wire-capture";

const PUBLIC_MODELS_URL = "https://api.cerebras.ai/public/v1/models";
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY?.trim() ?? "";
const HAS_CEREBRAS_KEY = CEREBRAS_KEY.length > 0;
const INVALID_CEREBRAS_KEY = "csk-invalid-evidence-key";
const MISSING_MODEL = "cerebras-evidence-model-does-not-exist";
const OVERSIZED_TOKEN_COUNT = 140_000;

interface TextUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

interface TextResult {
  text: string;
  finishReason?: string;
  usage?: TextUsage;
  toolCalls?: unknown[];
  providerMetadata?: unknown;
}

interface StreamResult {
  textStream: AsyncIterable<string>;
  text: PromiseLike<string>;
  usage: PromiseLike<TextUsage | undefined>;
  finishReason: PromiseLike<string | undefined>;
}

const receipts: Array<Record<string, unknown>> = [];
const trajectories: Array<Record<string, unknown>> = [];
let providerCatalog: unknown;
let capture: CerebrasWireCapture | null = null;
let harness: LiveAgentHarness | null = null;

const previousEnvironment = {
  ELIZA_PROVIDER: process.env.ELIZA_PROVIDER,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
};

if (!HAS_CEREBRAS_KEY) {
  const reason = "missing CEREBRAS_API_KEY (required for raw-wire evidence)";
  process.env.SKIP_REASON ||= reason;
  logger.warn(`[OpenAICerebrasEvidence] ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  return typeof (value as { then?: unknown }).then === "function";
}

function requireHarness(): LiveAgentHarness {
  if (!harness) throw new Error("[OpenAICerebrasEvidence] Harness is not initialized.");
  return harness;
}

function requireTextResult(value: unknown): TextResult {
  if (!isRecord(value) || typeof value.text !== "string") {
    throw new Error(
      `[OpenAICerebrasEvidence] Expected native text result: ${JSON.stringify(value)}`
    );
  }
  const usage = isRecord(value.usage)
    ? {
        promptTokens:
          typeof value.usage.promptTokens === "number" ? value.usage.promptTokens : undefined,
        completionTokens:
          typeof value.usage.completionTokens === "number"
            ? value.usage.completionTokens
            : undefined,
        totalTokens:
          typeof value.usage.totalTokens === "number" ? value.usage.totalTokens : undefined,
        reasoningTokens:
          typeof value.usage.reasoningTokens === "number" ? value.usage.reasoningTokens : undefined,
      }
    : undefined;
  return {
    text: value.text,
    ...(typeof value.finishReason === "string" ? { finishReason: value.finishReason } : {}),
    ...(usage ? { usage } : {}),
    ...(Array.isArray(value.toolCalls) ? { toolCalls: value.toolCalls } : {}),
    ...(value.providerMetadata !== undefined ? { providerMetadata: value.providerMetadata } : {}),
  };
}

function requireStreamResult(value: unknown): StreamResult {
  if (
    !isRecord(value) ||
    !value.textStream ||
    typeof (value.textStream as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !==
      "function" ||
    !isPromiseLike(value.text) ||
    !isPromiseLike(value.usage) ||
    !isPromiseLike(value.finishReason)
  ) {
    throw new Error("[OpenAICerebrasEvidence] Expected native streaming result.");
  }
  return value as unknown as StreamResult;
}

function requireJsonRequest(call: CapturedWireCall): Record<string, unknown> {
  const parsed = call.request?.parsedBody;
  if (parsed?.kind !== "json" || !isRecord(parsed.value)) {
    throw new Error(
      `[OpenAICerebrasEvidence] Wire call ${call.id} did not contain a JSON request.`
    );
  }
  return parsed.value;
}

function attachTrajectoryCapture(runtime: IAgentRuntime): void {
  const trajectoryLogger = {
    isEnabled: () => true,
    logLlmCall: (params: Record<string, unknown>) => {
      trajectories.push(params);
    },
  };
  const originalByType = runtime.getServicesByType.bind(runtime);
  runtime.getServicesByType = ((type: string) => {
    if (type === "trajectories") return [trajectoryLogger];
    return originalByType(type);
  }) as typeof runtime.getServicesByType;
  const originalByName = runtime.getService.bind(runtime);
  runtime.getService = ((name: string) => {
    if (name === "trajectories") return trajectoryLogger;
    return originalByName(name);
  }) as typeof runtime.getService;
}

async function waitForWireCallsToSettle(startIndex: number): Promise<CapturedWireCall[]> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const calls = capture?.calls.slice(startIndex) ?? [];
    if (calls.length > 0 && calls.every((call) => call.completedAt)) return calls;
    if (Date.now() >= deadline) {
      throw new Error("[OpenAICerebrasEvidence] Wire call did not settle before artifact capture.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function waitForWireRequest(startIndex: number): Promise<CapturedWireCall> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const call = capture?.calls[startIndex];
    if (call?.request) return call;
    if (Date.now() >= deadline) {
      throw new Error("[OpenAICerebrasEvidence] Provider request did not reach the wire proxy.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runCaptured<T>(
  name: string,
  stepId: string,
  operation: () => Promise<T>
): Promise<{ result: T; wireCalls: CapturedWireCall[] }> {
  if (!capture) throw new Error("[OpenAICerebrasEvidence] Wire capture is not initialized.");
  const startIndex = capture.calls.length;
  const result = await runWithTrajectoryContext({ trajectoryStepId: stepId }, operation);
  const wireCalls = await waitForWireCallsToSettle(startIndex);
  expect(wireCalls, `${name} should make one provider request`).toHaveLength(1);
  return { result, wireCalls };
}

async function runCapturedError(
  name: string,
  operation: () => Promise<unknown>,
  options: { minimumWireCalls?: number } = {}
): Promise<{
  error: ReturnType<typeof serializeCerebrasProviderError>;
  wireCalls: CapturedWireCall[];
}> {
  if (!capture) throw new Error("[OpenAICerebrasEvidence] Wire capture is not initialized.");
  const startIndex = capture.calls.length;
  let thrown: unknown;
  try {
    await operation();
  } catch (error) {
    // error-policy:J1 boundary translation — the live test converts the thrown
    // provider failure into a typed receipt and still asserts the wire status.
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`[OpenAICerebrasEvidence] ${name} unexpectedly succeeded.`);
  }
  const wireCalls = await waitForWireCallsToSettle(startIndex);
  if (options.minimumWireCalls === undefined) {
    expect(wireCalls, `${name} should make one provider request`).toHaveLength(1);
  } else {
    expect(wireCalls.length, `${name} should exercise provider retries`).toBeGreaterThanOrEqual(
      options.minimumWireCalls
    );
  }
  return { error: serializeCerebrasProviderError(thrown), wireCalls };
}

function catalogModel(modelId: string): Record<string, unknown> {
  if (!isRecord(providerCatalog) || !Array.isArray(providerCatalog.data)) {
    throw new Error("[OpenAICerebrasEvidence] Public model catalog has an invalid shape.");
  }
  const model = providerCatalog.data.find(
    (candidate) => isRecord(candidate) && candidate.id === modelId
  );
  if (!isRecord(model)) {
    throw new Error(`[OpenAICerebrasEvidence] ${modelId} is absent from the public model catalog.`);
  }
  return model;
}

function calculatedCost(modelId: string, usage: TextUsage | undefined): Record<string, unknown> {
  const model = catalogModel(modelId);
  if (!isRecord(model.pricing)) {
    throw new Error(`[OpenAICerebrasEvidence] ${modelId} has no public pricing record.`);
  }
  const promptRate = Number(model.pricing.prompt);
  const completionRate = Number(model.pricing.completion);
  if (!Number.isFinite(promptRate) || !Number.isFinite(completionRate)) {
    throw new Error(`[OpenAICerebrasEvidence] ${modelId} pricing is not numeric.`);
  }
  const promptTokens = usage?.promptTokens;
  const completionTokens = usage?.completionTokens;
  if (typeof promptTokens !== "number" || typeof completionTokens !== "number") {
    throw new Error(`[OpenAICerebrasEvidence] ${modelId} usage is incomplete.`);
  }
  return {
    currency: "USD",
    source: PUBLIC_MODELS_URL,
    promptRatePerToken: promptRate,
    completionRatePerToken: completionRate,
    calculatedAmount: promptTokens * promptRate + completionTokens * completionRate,
    providerReportedAmount: null,
    providerReportedAmountReason: "The chat response exposes usage but no billed-cost field.",
  };
}

function observedLatencyMs(wireCalls: readonly CapturedWireCall[]): number {
  const durationMs = wireCalls[0]?.durationMs;
  if (typeof durationMs !== "number") {
    throw new Error("[OpenAICerebrasEvidence] Wire latency was not finalized.");
  }
  return durationMs;
}

function restoreEnvironment(): void {
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

describe.skipIf(!HAS_CEREBRAS_KEY)("plugin-openai Cerebras evidence", () => {
  beforeAll(async () => {
    capture = await startCerebrasWireCapture();
    process.env.ELIZA_PROVIDER = "cerebras";
    process.env.OPENAI_BASE_URL = capture.baseUrl;
    harness = await buildLiveHarness({
      provider: "cerebras",
      requiredEnv: ["CEREBRAS_API_KEY"],
    });
    attachTrajectoryCapture(harness.runtime);

    const catalogResponse = await fetch(PUBLIC_MODELS_URL);
    expect(catalogResponse.status).toBe(200);
    providerCatalog = (await catalogResponse.json()) as unknown;
    for (const modelId of ["gpt-oss-120b", "zai-glm-4.7"]) {
      const model = catalogModel(modelId);
      expect(model.capabilities).toEqual(
        expect.objectContaining({
          streaming: true,
          structured_outputs: true,
          tools: true,
          reasoning: true,
        })
      );
    }
  }, 120_000);

  afterAll(async () => {
    const teardownFailures: unknown[] = [];
    try {
      if (harness) {
        const [result] = await Promise.allSettled([harness.close()]);
        if (result.status === "rejected") teardownFailures.push(result.reason);
        harness = null;
      }
      if (capture) {
        const [result] = await Promise.allSettled([capture.close()]);
        if (result.status === "rejected") teardownFailures.push(result.reason);
        const artifactDirectory =
          process.env.ELIZA_LIVE_TEST_ARTIFACT_DIR?.trim() ||
          join(tmpdir(), `eliza-cerebras-evidence-${process.pid}`);
        const rateLimitCallIds = capture.calls
          .filter((call) => call.response?.status === 429)
          .map((call) => call.id);
        const paths = await writeCerebrasEvidenceArtifacts({
          artifactDirectory,
          ...(process.env.ELIZA_LIVE_TEST_LLM_CALLS_JSONL?.trim()
            ? { trajectoryPath: process.env.ELIZA_LIVE_TEST_LLM_CALLS_JSONL.trim() }
            : {}),
          calls: capture.calls,
          trajectories,
          receipts: [
            ...receipts,
            rateLimitCallIds.length > 0
              ? {
                  name: "rate-limit-429",
                  status: "observed",
                  wireCallIds: rateLimitCallIds,
                }
              : {
                  name: "rate-limit-429",
                  status: "not-exercised",
                  reason:
                    "Cerebras exposes no deterministic 429 trigger; the evidence lane does not manufacture provider output or intentionally exhaust shared quota.",
                },
          ],
          providerCatalog,
          secrets: [CEREBRAS_KEY, INVALID_CEREBRAS_KEY],
          metadata: {
            issue: 16298,
            supersedesPullRequestEvidence: 16299,
            headSha: process.env.GITHUB_SHA ?? "local",
            githubRunId: process.env.GITHUB_RUN_ID ?? "local",
            upstreamBaseUrl: "https://api.cerebras.ai/v1",
          },
        });
        logger.info(paths, "[OpenAICerebrasEvidence] Wrote reviewed-artifact inputs");
        capture = null;
      }
    } finally {
      restoreEnvironment();
    }
    if (teardownFailures.length > 0) {
      throw new AggregateError(teardownFailures, "Cerebras evidence teardown failed.");
    }
  }, 120_000);

  it("captures the gpt-oss reasoning floor on the actual request", async () => {
    const runtime = requireHarness().runtime;
    const { result: rawResult, wireCalls } = await runCaptured(
      "gpt-oss reasoning floor",
      "cerebras-evidence-reasoning-floor",
      () =>
        runtime.useModel(ModelType.TEXT_LARGE, {
          model: "gpt-oss-120b",
          messages: [{ role: "user", content: "Respond with exactly READY and nothing else." }],
          maxTokens: 160,
        })
    );
    const result = requireTextResult(rawResult);
    expect(result.text.trim().toUpperCase()).toContain("READY");
    expect(result.finishReason).toBe("stop");
    expect(result.usage?.promptTokens).toBeGreaterThan(0);
    expect(result.usage?.completionTokens).toBeGreaterThan(0);
    const request = requireJsonRequest(wireCalls[0]);
    expect(request).toMatchObject({ model: "gpt-oss-120b", reasoning_effort: "low" });
    expect(wireCalls[0].response?.status).toBe(200);

    receipts.push({
      name: "gpt-oss-reasoning-floor",
      status: "passed",
      wireCallIds: wireCalls.map((call) => call.id),
      result,
      latencyMs: observedLatencyMs(wireCalls),
      cost: calculatedCost("gpt-oss-120b", result.usage),
    });
  }, 120_000);

  it("captures GLM thinking-off and the raw SSE stream", async () => {
    const runtime = requireHarness().runtime;
    const { result: rawStream, wireCalls } = await runCaptured(
      "GLM streaming thinking-off",
      "cerebras-evidence-glm-stream",
      async () => {
        const stream = requireStreamResult(
          await runtime.useModel(ModelType.TEXT_LARGE, {
            model: "zai-glm-4.7",
            messages: [{ role: "user", content: "Reply with exactly PONG and no punctuation." }],
            maxTokens: 160,
            stream: true,
            providerOptions: { eliza: { thinking: "off" } },
          })
        );
        const iterated: string[] = [];
        for await (const chunk of stream.textStream) iterated.push(chunk);
        return {
          text: await stream.text,
          usage: await stream.usage,
          finishReason: await stream.finishReason,
          iterated,
        };
      }
    );
    expect(rawStream.text.trim().toUpperCase()).toContain("PONG");
    expect(rawStream.finishReason).toBe("stop");
    expect(rawStream.usage?.reasoningTokens ?? 0).toBe(0);
    expect(rawStream.iterated.join("")).toBe(rawStream.text);
    const request = requireJsonRequest(wireCalls[0]);
    expect(request).toMatchObject({
      model: "zai-glm-4.7",
      stream: true,
      reasoning_effort: "none",
    });
    expect(wireCalls[0].response?.headers).toContainEqual(
      expect.objectContaining({
        name: "content-type",
        value: expect.stringContaining("text/event-stream"),
      })
    );
    expect(wireCalls[0].response?.chunks.length).toBeGreaterThan(0);
    expect(wireCalls[0].response?.body?.utf8).toContain("data:");
    expect(wireCalls[0].response?.body?.utf8).toContain("[DONE]");

    receipts.push({
      name: "glm-thinking-off-stream",
      status: "passed",
      wireCallIds: wireCalls.map((call) => call.id),
      result: rawStream,
      parsedChunks: rawStream.iterated,
      latencyMs: observedLatencyMs(wireCalls),
      cost: calculatedCost("zai-glm-4.7", rawStream.usage),
    });
  }, 120_000);

  it("captures a real Cerebras tool call through plugin normalization", async () => {
    const runtime = requireHarness().runtime;
    const { result: rawResult, wireCalls } = await runCaptured(
      "tool call",
      "cerebras-evidence-tool",
      () =>
        runtime.useModel(ModelType.TEXT_LARGE, {
          model: "gpt-oss-120b",
          messages: [
            { role: "system", content: "Call the requested tool; do not answer in prose." },
            {
              role: "user",
              content: "Call RECORD_EVIDENCE with verdict verified and count 2.",
            },
          ],
          tools: [
            {
              name: "RECORD_EVIDENCE",
              description: "Record the evidence verdict.",
              parameters: {
                type: "object",
                properties: {
                  verdict: { type: "string", enum: ["verified"] },
                  count: { type: "number" },
                },
                required: ["verdict", "count"],
                additionalProperties: false,
              },
            },
          ],
          toolChoice: { type: "tool", name: "RECORD_EVIDENCE" },
          maxTokens: 160,
        })
    );
    const result = requireTextResult(rawResult);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls?.[0]).toMatchObject({
      toolName: "RECORD_EVIDENCE",
      input: { verdict: "verified", count: 2 },
    });
    const request = requireJsonRequest(wireCalls[0]);
    expect(request.tools).toEqual(expect.any(Array));
    expect(request.tool_choice).toEqual(expect.objectContaining({ type: "function" }));
    expect(wireCalls[0].response?.body?.utf8).toContain("tool_calls");

    receipts.push({
      name: "tool-call",
      status: "passed",
      wireCallIds: wireCalls.map((call) => call.id),
      result,
      latencyMs: observedLatencyMs(wireCalls),
      cost: calculatedCost("gpt-oss-120b", result.usage),
    });
  }, 120_000);

  it("captures and parses real Cerebras JSON-mode structured output", async () => {
    const runtime = requireHarness().runtime;
    const responseSchema = {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["verified"] },
        count: { type: "number" },
      },
      required: ["verdict", "count"],
      additionalProperties: false,
    };
    const { result: rawResult, wireCalls } = await runCaptured(
      "structured output",
      "cerebras-evidence-structured-output",
      () =>
        runtime.useModel(ModelType.TEXT_LARGE, {
          model: "gpt-oss-120b",
          messages: [
            {
              role: "user",
              content: 'Return only JSON with verdict "verified" and count 2.',
            },
          ],
          responseSchema,
          responseFormat: { type: "json_object" },
          maxTokens: 160,
        })
    );
    const result = requireTextResult(rawResult);
    const parsed = JSON.parse(result.text) as unknown;
    expect(parsed).toEqual({ verdict: "verified", count: 2 });
    const request = requireJsonRequest(wireCalls[0]);
    expect(request.response_format).toEqual({ type: "json_object" });
    expect(wireCalls[0].response?.status).toBe(200);

    receipts.push({
      name: "structured-output",
      status: "passed",
      wireCallIds: wireCalls.map((call) => call.id),
      responseSchema,
      parsed,
      result,
      latencyMs: observedLatencyMs(wireCalls),
      cost: calculatedCost("gpt-oss-120b", result.usage),
    });
  }, 120_000);

  it("captures the real authentication failure without retaining the bad Authorization header", async () => {
    const runtime = requireHarness().runtime;
    runtime.setSetting("CEREBRAS_API_KEY", INVALID_CEREBRAS_KEY, true);
    let evidence: Awaited<ReturnType<typeof runCapturedError>>;
    try {
      evidence = await runCapturedError("bad key", () =>
        runtime.useModel(ModelType.TEXT_LARGE, {
          model: "gpt-oss-120b",
          prompt: "Authentication failure evidence.",
          maxTokens: 8,
        })
      );
    } finally {
      runtime.setSetting("CEREBRAS_API_KEY", CEREBRAS_KEY, true);
    }
    expect(evidence.error.statusCode).toBe(401);
    expect(evidence.wireCalls[0].response?.status).toBe(401);
    expect(evidence.wireCalls[0].request?.headers).toContainEqual({
      name: "authorization",
      value: "[REDACTED]",
    });
    receipts.push({
      name: "bad-key",
      status: "passed",
      wireCallIds: evidence.wireCalls.map((call) => call.id),
      error: evidence.error,
    });
  }, 120_000);

  it("captures the provider model-not-found response", async () => {
    const runtime = requireHarness().runtime;
    const evidence = await runCapturedError("model not found", () =>
      runtime.useModel(ModelType.TEXT_LARGE, {
        model: MISSING_MODEL,
        prompt: "Model-not-found evidence.",
        maxTokens: 8,
      })
    );
    expect(evidence.error.statusCode).toBe(404);
    expect(evidence.wireCalls[0].response?.status).toBe(404);
    expect(requireJsonRequest(evidence.wireCalls[0]).model).toBe(MISSING_MODEL);
    receipts.push({
      name: "model-not-found",
      status: "passed",
      wireCallIds: evidence.wireCalls.map((call) => call.id),
      error: evidence.error,
    });
  }, 120_000);

  it("captures the provider context-limit response using the published limit", async () => {
    const runtime = requireHarness().runtime;
    const model = catalogModel("gpt-oss-120b");
    expect(model.limits).toEqual(expect.objectContaining({ max_context_length: 131_072 }));
    const oversizedPrompt = "x ".repeat(OVERSIZED_TOKEN_COUNT);
    const evidence = await runCapturedError("oversized context", () =>
      runtime.useModel(ModelType.TEXT_LARGE, {
        model: "gpt-oss-120b",
        prompt: oversizedPrompt,
        maxTokens: 8,
      })
    );
    expect(evidence.error.statusCode).toBe(400);
    expect(evidence.wireCalls[0].response?.status).toBe(400);
    const request = requireJsonRequest(evidence.wireCalls[0]);
    expect(JSON.stringify(request).length).toBeGreaterThan(OVERSIZED_TOKEN_COUNT);
    receipts.push({
      name: "oversized-context",
      status: "passed",
      wireCallIds: evidence.wireCalls.map((call) => call.id),
      publishedMaxContextTokens: 131_072,
      repeatedPromptTokens: OVERSIZED_TOKEN_COUNT,
      error: evidence.error,
    });
  }, 120_000);

  it("aborts an in-flight provider request through the caller signal", async () => {
    const runtime = requireHarness().runtime;
    if (!capture) throw new Error("[OpenAICerebrasEvidence] Capture is not initialized.");
    const startIndex = capture.calls.length;
    const abortController = new AbortController();
    const evidence = await runCapturedError("caller abort", async () => {
      const pending = runtime.useModel(ModelType.TEXT_LARGE, {
        model: "gpt-oss-120b",
        prompt: "Caller-abort evidence; generate a detailed explanation of model serving.",
        maxTokens: 160,
        signal: abortController.signal,
      });
      // error-policy:J1 boundary translation — attach an observer immediately,
      // then rethrow the provider error after the wire proxy confirms receipt.
      const observed = pending.then(
        (value) => ({ status: "fulfilled", value }) as const,
        (error: unknown) => ({ status: "rejected", error }) as const
      );
      await waitForWireRequest(startIndex);
      abortController.abort(new DOMException("Evidence caller aborted the request.", "AbortError"));
      const outcome = await observed;
      if (outcome.status === "rejected") throw outcome.error;
      return outcome.value;
    });
    expect(evidence.error.message.toLowerCase()).toMatch(/abort|timeout|terminated/);
    expect(evidence.wireCalls[0].transport.outcome).toMatch(/client-aborted|proxy-error/);
    receipts.push({
      name: "caller-abort",
      status: "passed",
      wireCallIds: evidence.wireCalls.map((call) => call.id),
      abortedAfterProxyReceivedRequest: true,
      error: evidence.error,
      transport: evidence.wireCalls[0].transport,
    });
  }, 120_000);

  it("surfaces a mid-stream transport disconnect after a real upstream chunk", async () => {
    const runtime = requireHarness().runtime;
    if (!capture) throw new Error("[OpenAICerebrasEvidence] Capture is not initialized.");
    // The SDK has a bounded internal retry budget. Faulting more attempts than
    // that budget proves terminal truncation instead of accidentally proving
    // its transparent retry path.
    capture.armFault({ kind: "disconnect-after-first-response-chunk", attempts: 8 });
    const evidence = await runCapturedError(
      "mid-stream disconnect",
      async () => {
        const stream = requireStreamResult(
          await runtime.useModel(ModelType.TEXT_LARGE, {
            model: "gpt-oss-120b",
            prompt: "Stream the words ALPHA BETA GAMMA slowly.",
            maxTokens: 64,
            stream: true,
          })
        );
        for await (const _chunk of stream.textStream) {
          // The proxy severs every retry before forwarding the captured chunk.
        }
        await Promise.all([stream.text, stream.usage, stream.finishReason]);
      },
      { minimumWireCalls: 2 }
    );
    for (const wireCall of evidence.wireCalls) {
      expect(wireCall.fault).toEqual({
        kind: "disconnect-after-first-response-chunk",
        triggered: true,
      });
      expect(wireCall.transport.outcome).toBe("injected-disconnect");
      expect(wireCall.response?.chunks).toHaveLength(1);
    }
    expect(evidence.error.message.length).toBeGreaterThan(0);
    receipts.push({
      name: "mid-stream-disconnect",
      status: "passed",
      wireCallIds: evidence.wireCalls.map((call) => call.id),
      error: evidence.error,
      capturedUpstreamChunks: evidence.wireCalls.map((call) => call.response?.chunks[0]),
    });
  }, 120_000);
});
