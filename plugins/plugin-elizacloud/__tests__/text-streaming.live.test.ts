/**
 * Exact-head live evidence for Eliza Cloud's streamed native tool-call
 * consumer. The real hosted response is teed into a schema-limited transcript,
 * then the plugin-reconstructed input is executed by a deterministic synthetic
 * tool and compared byte-for-byte after canonical JSON serialization.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IAgentRuntime, TextStreamResult } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { handleResponseHandler } from "../src/models/text";

const LIVE_ENABLED = process.env.ELIZA_TOOLCALL_STREAM_LIVE === "1";
const MODEL = "gpt-oss-120b";
const TOOL_NAME = "CAPTURE_STREAMED_INPUT";

type JsonRecord = Record<string, unknown>;

interface CapturedToolFragment {
  frame: number;
  index: number;
  id?: string;
  name?: string;
  argumentsFragment: string;
}

interface RedactedDataFrame {
  frame: number;
  done?: true;
  choices?: Array<{
    index?: number;
    finishReason?: string;
    toolCalls?: Array<{
      index?: number;
      id?: string;
      name?: string;
      argumentsFragment?: string;
    }>;
  }>;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Synthetic tool input contains a non-JSON value");
  }
  return serialized;
}

function parseObject(value: string, label: string): JsonRecord {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) {
    throw new Error(`${label} is not a JSON object`);
  }
  return parsed;
}

function reconstructProviderToolCalls(
  fragments: CapturedToolFragment[]
): Array<{ index: number; id: string; name: string; input: JsonRecord }> {
  const calls = new Map<number, { id?: string; name?: string; argumentsText: string }>();
  for (const fragment of fragments) {
    const call = calls.get(fragment.index) ?? { argumentsText: "" };
    if (fragment.id) {
      if (call.id && call.id !== fragment.id) {
        throw new Error(`Provider changed the id for tool-call index ${fragment.index}`);
      }
      call.id = fragment.id;
    }
    if (fragment.name) {
      if (call.name && call.name !== fragment.name) {
        throw new Error(`Provider changed the name for tool-call index ${fragment.index}`);
      }
      call.name = fragment.name;
    }

    let accumulated: JsonRecord | undefined;
    let incoming: JsonRecord | undefined;
    try {
      accumulated = parseObject(call.argumentsText, "Accumulated provider arguments");
    } catch {
      accumulated = undefined;
    }
    try {
      incoming = parseObject(fragment.argumentsFragment, "Provider argument fragment");
    } catch {
      incoming = undefined;
    }
    if (fragment.id && fragment.name && accumulated !== undefined && incoming !== undefined) {
      if (canonicalJson(accumulated) !== canonicalJson(incoming)) {
        throw new Error(
          `Provider consolidated arguments conflict at tool-call index ${fragment.index}`
        );
      }
    } else {
      call.argumentsText += fragment.argumentsFragment;
    }
    calls.set(fragment.index, call);
  }

  return [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, call]) => {
      if (!call.id || !call.name) {
        throw new Error(`Provider tool-call index ${index} has incomplete identity`);
      }
      return {
        index,
        id: call.id,
        name: call.name,
        input: parseObject(call.argumentsText, `Provider tool-call index ${index}`),
      };
    });
}

function syntheticPayload(): JsonRecord {
  const segments = Array.from(
    { length: 192 },
    (_, index) => `fragment-proof-${index.toString().padStart(3, "0")}`
  );
  return {
    marker: "issue-16997-plugin-consumer",
    payload: segments.join("|"),
    sequence: [1, 1, 2, 3, 5, 8, 13, 21],
  };
}

function runtime(apiKey: string): IAgentRuntime {
  const settings: Record<string, string> = {
    ELIZAOS_CLOUD_API_KEY: apiKey,
    ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL: MODEL,
  };
  return {
    character: { name: "Tool stream verifier", bio: [] },
    getSetting: (key: string) => settings[key],
    emitEvent: vi.fn(),
  } as unknown as IAgentRuntime;
}

function numberField(record: JsonRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    if (typeof record[key] === "number") return record[key];
  }
  return undefined;
}

function redactSseTranscript(raw: string): {
  dataFrames: RedactedDataFrame[];
  fragments: CapturedToolFragment[];
} {
  const dataFrames: RedactedDataFrame[] = [];
  const fragments: CapturedToolFragment[] = [];
  const dataLines = raw
    .split(/\r?\n/)
    .map((line) => line.trimStart())
    .filter((line) => line.startsWith("data:"));

  for (const [frame, line] of dataLines.entries()) {
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") {
      dataFrames.push({ frame, done: true });
      continue;
    }
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed)) {
      throw new Error(`Live SSE frame ${frame} is not an object`);
    }
    const redacted: RedactedDataFrame = { frame };
    if (Array.isArray(parsed.choices)) {
      redacted.choices = parsed.choices.map((rawChoice) => {
        if (!isRecord(rawChoice)) {
          throw new Error(`Live SSE choice in frame ${frame} is not an object`);
        }
        const delta = isRecord(rawChoice.delta) ? rawChoice.delta : {};
        const choice: NonNullable<RedactedDataFrame["choices"]>[number] = {};
        if (typeof rawChoice.index === "number") choice.index = rawChoice.index;
        if (typeof rawChoice.finish_reason === "string") {
          choice.finishReason = rawChoice.finish_reason;
        }
        if (Array.isArray(delta.tool_calls)) {
          choice.toolCalls = delta.tool_calls.map((rawCall) => {
            if (!isRecord(rawCall)) {
              throw new Error(`Live tool delta in frame ${frame} is not an object`);
            }
            const fn = isRecord(rawCall.function) ? rawCall.function : {};
            const call: NonNullable<
              NonNullable<RedactedDataFrame["choices"]>[number]["toolCalls"]
            >[number] = {};
            if (typeof rawCall.index === "number") call.index = rawCall.index;
            if (typeof rawCall.id === "string") call.id = rawCall.id;
            if (typeof fn.name === "string") call.name = fn.name;
            if (typeof fn.arguments === "string") {
              call.argumentsFragment = fn.arguments;
              if (typeof rawCall.index === "number") {
                fragments.push({
                  frame,
                  index: rawCall.index,
                  ...(typeof rawCall.id === "string" ? { id: rawCall.id } : {}),
                  ...(typeof fn.name === "string" ? { name: fn.name } : {}),
                  argumentsFragment: fn.arguments,
                });
              }
            }
            return call;
          });
        }
        return choice;
      });
    }
    if (isRecord(parsed.usage)) {
      redacted.usage = {
        promptTokens: numberField(parsed.usage, "prompt_tokens", "input_tokens"),
        completionTokens: numberField(parsed.usage, "completion_tokens", "output_tokens"),
        totalTokens: numberField(parsed.usage, "total_tokens"),
      };
    }
    dataFrames.push(redacted);
  }

  return { dataFrames, fragments };
}

function writeEvidence(path: string, evidence: JsonRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
  writeFileSync(path, bytes, { encoding: "utf8", mode: 0o600 });
  const digest = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(`${path}.sha256`, `${digest}  ${path}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

const liveDescribe = LIVE_ENABLED ? describe : describe.skip;

liveDescribe("Eliza Cloud streamed tool-call reconstruction (live)", () => {
  it("matches the redacted provider fragments, plugin result, and executed tool input", async () => {
    const apiKey = process.env.ELIZAOS_CLOUD_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("ELIZAOS_CLOUD_API_KEY is required for the exact-head live lane");
    }
    const expectedSha = process.env.ELIZA_TOOLCALL_EXPECTED_SHA?.trim();
    const headSha = process.env.GITHUB_SHA?.trim();
    if (!expectedSha || !headSha || expectedSha !== headSha) {
      throw new Error("Live evidence must run against the requested exact head");
    }
    const evidencePath = process.env.ELIZA_TOOLCALL_EVIDENCE_PATH?.trim();
    if (!evidencePath) {
      throw new Error("ELIZA_TOOLCALL_EVIDENCE_PATH is required");
    }

    const expectedInput = syntheticPayload();
    const realFetch = globalThis.fetch.bind(globalThis);
    let responseCapture: Promise<string> | undefined;
    let requestModel: string | undefined;
    let transportChunkCount = 0;

    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const response = await realFetch(input, init);
        if (!url.includes("/chat/completions")) return response;

        if (typeof init?.body === "string") {
          const requestBody: unknown = JSON.parse(init.body);
          if (isRecord(requestBody) && typeof requestBody.model === "string") {
            requestModel = requestBody.model;
          }
        }
        if (!response.body) {
          throw new Error("Live chat/completions response has no body");
        }
        const [pluginBody, evidenceBody] = response.body.tee();
        responseCapture = (async () => {
          const reader = evidenceBody.getReader();
          const decoder = new TextDecoder();
          let raw = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            transportChunkCount += 1;
            raw += decoder.decode(value, { stream: true });
          }
          return raw + decoder.decode();
        })();
        return new Response(pluginBody, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      });

    let result: TextStreamResult | undefined;
    let streamedEnvelope = "";
    try {
      const generated = await handleResponseHandler(runtime(apiKey), {
        prompt:
          "Call CAPTURE_STREAMED_INPUT exactly once. Copy every enum-constrained value from its schema exactly.",
        system:
          "You produce only the required function call. Never narrate and never alter enum values.",
        messages: [
          {
            role: "user",
            content: "Invoke CAPTURE_STREAMED_INPUT with the only schema-valid object.",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: TOOL_NAME,
              description: "Capture a deterministic streamed input.",
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  marker: { type: "string", enum: [expectedInput.marker] },
                  payload: { type: "string", enum: [expectedInput.payload] },
                  sequence: {
                    type: "array",
                    items: { type: "integer" },
                    enum: [expectedInput.sequence],
                  },
                },
                required: ["marker", "payload", "sequence"],
              },
            },
          },
        ],
        toolChoice: { type: "tool", toolName: TOOL_NAME },
        providerOptions: { eliza: {} },
        stream: true,
        streamStructured: true,
      } as never);
      if (typeof generated === "string" || !("textStream" in generated)) {
        throw new Error("Plugin did not return its streaming result");
      }
      result = generated;
      for await (const chunk of result.textStream) {
        streamedEnvelope += chunk;
      }
    } finally {
      fetchSpy.mockRestore();
    }

    const rawSse = await responseCapture;
    if (rawSse === undefined) {
      throw new Error("Live plugin request did not capture a chat/completions SSE response");
    }
    if (!result) {
      throw new Error("Live plugin stream did not produce a result");
    }
    const transcript = redactSseTranscript(rawSse);
    const providerCalls = reconstructProviderToolCalls(transcript.fragments);
    const toolCalls = await (
      result as TextStreamResult & {
        toolCalls: Promise<
          Array<{
            toolCallId: string;
            toolName: string;
            input: JsonRecord;
          }>
        >;
      }
    ).toolCalls;
    const finishReason = await (
      result as TextStreamResult & { finishReason: Promise<string | undefined> }
    ).finishReason;
    expect(toolCalls).toHaveLength(1);
    expect(providerCalls).toHaveLength(1);
    const reconstructed = toolCalls[0];
    const providerCall = providerCalls[0];
    expect(reconstructed?.toolName).toBe(TOOL_NAME);
    expect(providerCall?.name).toBe(TOOL_NAME);
    expect(canonicalJson(providerCall?.input)).toBe(canonicalJson(reconstructed?.input));
    expect(reconstructed?.input.marker).toBe(expectedInput.marker);
    expect(reconstructed?.input.payload).toBe(expectedInput.payload);
    expect(Array.isArray(reconstructed?.input.sequence)).toBe(true);
    expect(transcript.fragments.length).toBeGreaterThan(1);
    expect(finishReason).toBe("tool_calls");
    expect(requestModel).toBe(MODEL);

    let executedInput: JsonRecord | undefined;
    const executeSyntheticTool = (input: JsonRecord): JsonRecord => {
      executedInput = structuredClone(input);
      return {
        accepted:
          input.marker === expectedInput.marker &&
          input.payload === expectedInput.payload &&
          Array.isArray(input.sequence),
        marker: input.marker,
      };
    };
    const executionResult = executeSyntheticTool(reconstructed?.input ?? {});
    expect(canonicalJson(executedInput)).toBe(canonicalJson(reconstructed?.input));
    expect(executionResult).toEqual({
      accepted: true,
      marker: expectedInput.marker,
    });

    writeEvidence(evidencePath, {
      schemaVersion: 1,
      issue: 16997,
      headSha,
      provider: "eliza-cloud",
      model: requestModel,
      transportChunkCount,
      providerArgumentFragmentCount: transcript.fragments.length,
      redactedProviderDataFrames: transcript.dataFrames,
      providerArgumentFragments: transcript.fragments,
      providerReconstructedToolCalls: providerCalls,
      pluginStreamedEnvelope: streamedEnvelope,
      pluginReconstructedToolCall: reconstructed,
      expectedToolInput: expectedInput,
      executedSyntheticTool: {
        input: executedInput,
        result: executionResult,
      },
      verdict: {
        terminalFinishReason: finishReason,
        providerMatchesPlugin:
          canonicalJson(providerCall?.input) === canonicalJson(reconstructed?.input),
        pluginMatchesExecuted: canonicalJson(reconstructed?.input) === canonicalJson(executedInput),
        endToEndInputEquality:
          canonicalJson(providerCall?.input) === canonicalJson(reconstructed?.input) &&
          canonicalJson(reconstructed?.input) === canonicalJson(executedInput),
      },
    });
  }, 120_000);
});
