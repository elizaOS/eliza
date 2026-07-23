/**
 * Captures exact-head Cerebras tool-call events through the Cloud SSE
 * translator and executes the reconstructed synthetic input. The opt-in run
 * writes a schema-limited artifact with no credential or request-header data.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

const LIVE = process.env.ELIZA_TOOLCALL_STREAM_LIVE === "1";
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY?.trim();
const EXPECTED_SHA = process.env.ELIZA_TOOLCALL_EXPECTED_SHA?.trim();
const EVIDENCE_PATH =
  process.env.ELIZA_TOOLCALL_EVIDENCE_PATH?.trim() ??
  "reports/16997-toolcall-stream-live.json";
const MODEL = "gpt-oss-120b";
const PROVIDER = "cerebras";
const PROVIDER_BASE_URL = "https://api.cerebras.ai/v1";
const TOOL_NAME = "record_stream_probe";

type StreamTextConfig = Parameters<typeof import("ai")["streamText"]>[0];
type StreamingHandler =
  typeof import("../v1/chat/completions/route")["__streamingCreditTestHooks"]["handleStreamingRequest"];

type ProbeInput = {
  nonce: string;
  count: number;
  labels: string[];
  payload: string;
};

type ProjectedProviderEvent = {
  type: string;
  id?: string;
  toolCallId?: string;
  toolName?: string;
  delta?: string;
  input?: ProbeInput;
  finishReason?: string;
  totalUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
};

type OpenAIToolCallFragment = {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

const providerEvents: ProjectedProviderEvent[] = [];
const aiActual = require("ai") as typeof import("ai");
let handleStreamingRequest: StreamingHandler | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function projectProviderEvent(value: unknown): ProjectedProviderEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Provider emitted a stream event without a string type");
  }

  const event: ProjectedProviderEvent = { type: value.type };
  if (typeof value.id === "string") event.id = value.id;
  if (typeof value.toolCallId === "string") {
    event.toolCallId = value.toolCallId;
  }
  if (typeof value.toolName === "string") event.toolName = value.toolName;
  if (typeof value.delta === "string") event.delta = value.delta;
  if (value.input !== undefined) event.input = requireProbeInput(value.input);
  if (typeof value.finishReason === "string") {
    event.finishReason = value.finishReason;
  }
  if (isRecord(value.totalUsage)) {
    const totalUsage: ProjectedProviderEvent["totalUsage"] = {};
    for (const field of [
      "inputTokens",
      "outputTokens",
      "totalTokens",
    ] as const) {
      if (typeof value.totalUsage[field] === "number") {
        totalUsage[field] = value.totalUsage[field];
      }
    }
    event.totalUsage = totalUsage;
  }
  return event;
}

if (LIVE) {
  const liveStreamText = (config: StreamTextConfig) => {
    const result = aiActual.streamText({
      ...config,
      maxRetries: 0,
      onFinish: undefined,
      onError: undefined,
      onAbort: undefined,
    } as StreamTextConfig);

    return {
      fullStream: (async function* () {
        for await (const part of result.fullStream) {
          providerEvents.push(projectProviderEvent(part));
          yield part;
        }
      })(),
    };
  };

  mock.module("ai", () => ({
    ...aiActual,
    streamText: liveStreamText,
  }));

  const route = await import("../v1/chat/completions/route");
  handleStreamingRequest =
    route.__streamingCreditTestHooks.handleStreamingRequest;
}

afterAll(() => {
  if (LIVE) {
    mock.module("ai", () => aiActual);
  }
});

function requireExactHead(): string {
  const checkoutSha = process.env.GITHUB_SHA?.trim();
  if (!EXPECTED_SHA || !/^[a-f0-9]{40}$/.test(EXPECTED_SHA)) {
    throw new Error("ELIZA_TOOLCALL_EXPECTED_SHA must be a lowercase SHA-1");
  }
  if (checkoutSha !== EXPECTED_SHA) {
    throw new Error(
      `Live evidence checkout ${checkoutSha ? "is present" : "is missing"} but does not match the requested SHA`,
    );
  }
  return checkoutSha;
}

function requireProbeInput(value: unknown): ProbeInput {
  if (
    !isRecord(value) ||
    typeof value.nonce !== "string" ||
    typeof value.count !== "number" ||
    !Array.isArray(value.labels) ||
    !value.labels.every((label) => typeof label === "string") ||
    typeof value.payload !== "string"
  ) {
    throw new Error("Executed tool input does not match the probe schema");
  }
  return {
    nonce: value.nonce,
    count: value.count,
    labels: [...value.labels],
    payload: value.payload,
  };
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])]),
  );
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return (
    JSON.stringify(canonicalJson(left)) === JSON.stringify(canonicalJson(right))
  );
}

function executeProbe(value: unknown) {
  const input = requireProbeInput(value);
  return {
    input,
    result: {
      accepted: true,
      receipt: `${input.nonce}:${input.count}:${input.labels.join("|")}`,
      payloadBytes: new TextEncoder().encode(input.payload).byteLength,
    },
  };
}

async function collectSse(response: Response) {
  const body = await response.text();
  const dataLines = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length).trim());
  const jsonFrames = dataLines
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
  return { body, dataLines, jsonFrames };
}

function reconstructToolCalls(jsonFrames: Array<Record<string, unknown>>) {
  const calls = new Map<
    number,
    { id?: string; name?: string; argumentsText: string }
  >();
  for (const frame of jsonFrames) {
    const choices = frame.choices as
      | Array<{ delta?: { tool_calls?: OpenAIToolCallFragment[] } }>
      | undefined;
    for (const choice of choices ?? []) {
      for (const fragment of choice.delta?.tool_calls ?? []) {
        const call = calls.get(fragment.index) ?? { argumentsText: "" };
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.name = fragment.function.name;
        call.argumentsText += fragment.function?.arguments ?? "";
        calls.set(fragment.index, call);
      }
    }
  }
  return calls;
}

function finalFinishReason(jsonFrames: Array<Record<string, unknown>>) {
  for (let index = jsonFrames.length - 1; index >= 0; index -= 1) {
    const choices = jsonFrames[index]?.choices as
      | Array<{ finish_reason?: string | null }>
      | undefined;
    if (choices?.[0]?.finish_reason) return choices[0].finish_reason;
  }
  return null;
}

async function invokeLiveRoute(target: ProbeInput) {
  if (!handleStreamingRequest) {
    throw new Error("Live streaming handler was not initialized");
  }

  return await handleStreamingRequest(
    MODEL,
    undefined,
    [
      {
        role: "user",
        content:
          `Call ${TOOL_NAME} exactly once with this JSON input and no prose: ` +
          JSON.stringify(target),
      },
    ] as never,
    {
      model: MODEL,
      messages: [
        {
          role: "user",
          content:
            `Call ${TOOL_NAME} exactly once with this JSON input and no prose: ` +
            JSON.stringify(target),
        },
      ],
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      max_tokens: 2048,
      tools: [
        {
          type: "function",
          function: {
            name: TOOL_NAME,
            description: "Records a synthetic exact-head stream probe.",
            parameters: {
              type: "object",
              additionalProperties: false,
              required: ["nonce", "count", "labels", "payload"],
              properties: {
                nonce: { type: "string", enum: [target.nonce] },
                count: { type: "integer", enum: [target.count] },
                labels: {
                  type: "array",
                  items: { type: "string" },
                },
                payload: { type: "string", enum: [target.payload] },
              },
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: TOOL_NAME },
      },
    } as never,
    {
      id: "00000000-0000-4000-8000-0000000000bb",
      organization_id: "00000000-0000-4000-8000-0000000000aa",
    },
    null,
    null,
    "issue-16997-live-evidence",
    "issue-16997-live-evidence",
    null,
    Date.now(),
    undefined,
    120_000,
    128,
    async () => null,
    {} as never,
    2048,
    {} as never,
    "gateway" as never,
    null,
    false,
  );
}

describe.skipIf(!LIVE)("live fragmented tool-call stream evidence", () => {
  test("binds real provider events to SSE reconstruction and executed input", async () => {
    if (!CEREBRAS_API_KEY) {
      throw new Error("CEREBRAS_API_KEY is required for live evidence");
    }
    const headSha = requireExactHead();
    const target: ProbeInput = {
      nonce: `issue-16997-${headSha.slice(0, 12)}`,
      count: 7,
      labels: ["fragmented", "validated", "exact-head"],
      payload: Array.from(
        { length: 16 },
        (_, index) =>
          `fragment-${String(index).padStart(2, "0")}-${headSha.slice(0, 16)}-` +
          "stream-boundary-proof".repeat(2),
      ).join("|"),
    };

    providerEvents.length = 0;
    const { dataLines, jsonFrames } = await collectSse(
      await invokeLiveRoute(target),
    );

    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
    expect(jsonFrames.some((frame) => "error" in frame)).toBe(false);
    expect(finalFinishReason(jsonFrames)).toBe("tool_calls");

    const calls = reconstructToolCalls(jsonFrames);
    expect(calls.size).toBe(1);
    const reconstructed = calls.get(0);
    if (!reconstructed) {
      throw new Error("OpenAI SSE did not contain a reconstructed tool call");
    }
    expect(reconstructed.name).toBe(TOOL_NAME);

    const providerArgumentDeltas = providerEvents.filter(
      (
        event,
      ): event is ProjectedProviderEvent & {
        type: "tool-input-delta";
        delta: string;
      } => event.type === "tool-input-delta" && typeof event.delta === "string",
    );
    expect(providerArgumentDeltas.length).toBeGreaterThan(1);
    const providerArgumentsText = providerArgumentDeltas
      .map((event) => event.delta)
      .join("");
    expect(reconstructed.argumentsText).toBe(providerArgumentsText);

    const providerToolCall = providerEvents.find(
      (event) => event.type === "tool-call",
    );
    if (!providerToolCall) {
      throw new Error("Provider stream did not contain a tool-call event");
    }
    const reconstructedInput = JSON.parse(
      reconstructed.argumentsText,
    ) as unknown;
    const consolidatedInputEqualsReconstructedInput = jsonValuesEqual(
      providerToolCall.input,
      reconstructedInput,
    );
    const targetInputEqualsReconstructedInput = jsonValuesEqual(
      target,
      reconstructedInput,
    );
    expect(consolidatedInputEqualsReconstructedInput).toBe(true);
    expect(targetInputEqualsReconstructedInput).toBe(true);

    const execution = executeProbe(reconstructedInput);
    const reconstructedInputEqualsExecutedInput = jsonValuesEqual(
      reconstructedInput,
      execution.input,
    );
    expect(reconstructedInputEqualsExecutedInput).toBe(true);
    const providerEventsEqualSseArguments =
      providerArgumentsText === reconstructed.argumentsText;
    const endToEndInputEquality =
      providerEventsEqualSseArguments &&
      consolidatedInputEqualsReconstructedInput &&
      targetInputEqualsReconstructedInput &&
      reconstructedInputEqualsExecutedInput;
    expect(endToEndInputEquality).toBe(true);

    const evidence = {
      schema: "eliza_cloud_toolcall_stream_live_v1",
      issue: 16997,
      pullRequest: 17005,
      headSha,
      provider: PROVIDER,
      model: MODEL,
      providerBaseUrl: PROVIDER_BASE_URL,
      syntheticPrompt: true,
      targetInput: target,
      providerArgumentFragmentCount: providerArgumentDeltas.length,
      providerEvents,
      openAiSseData: dataLines,
      reconstructedToolCall: {
        index: 0,
        id: reconstructed.id,
        name: reconstructed.name,
        argumentsText: reconstructed.argumentsText,
        input: reconstructedInput,
      },
      executedTool: {
        name: TOOL_NAME,
        ...execution,
      },
      verdict: {
        providerWasLive: true,
        providerArgumentsWereFragmented: providerArgumentDeltas.length > 1,
        providerEventsEqualSseArguments,
        consolidatedInputEqualsReconstructedInput,
        targetInputEqualsReconstructedInput,
        reconstructedInputEqualsExecutedInput,
        endToEndInputEquality,
        terminalFinishReason: "tool_calls",
      },
    };
    const artifact = `${JSON.stringify(evidence, null, 2)}\n`;
    const artifactSha256 = createHash("sha256").update(artifact).digest("hex");
    await mkdir(dirname(EVIDENCE_PATH), { recursive: true });
    await writeFile(EVIDENCE_PATH, artifact, { mode: 0o600 });
    await writeFile(
      `${EVIDENCE_PATH}.sha256`,
      `${artifactSha256}  ${basename(EVIDENCE_PATH)}\n`,
      { mode: 0o600 },
    );
  }, 180_000);
});
