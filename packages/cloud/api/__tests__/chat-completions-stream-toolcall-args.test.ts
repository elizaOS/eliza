/**
 * OpenAI streaming tool_calls argument contract for POST /api/v1/chat/completions:
 * clients concatenate every `function.arguments` fragment for a tool-call index,
 * so a call whose input already streamed via `tool-input-delta` must NOT have its
 * arguments re-emitted by the SDK's consolidated `tool-call` part (the duplicate
 * produced doubled, unparseable argument JSON in real agents — hermes/openclaw
 * hard-failed every tool call through the cloud proxy). Providers that never
 * stream input fragments still get the full consolidated emission. Drives the
 * REAL streaming handler and asserts on the raw SSE bytes; only `streamText`
 * (the provider boundary) is substituted, mirroring
 * chat-completions-stream-usage-frame.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// Spread the real module so other test files importing from "ai" are not
// stranded by the process-wide registry replacement; restore in afterAll.
const aiActual = require("ai") as Record<string, unknown>;

import * as languageModelActual from "@/lib/providers/language-model";

let streamTextImpl: ((config: Record<string, unknown>) => unknown) | null =
  null;
const streamText = mock((config: Record<string, unknown>) => {
  if (!streamTextImpl) throw new Error("streamTextImpl not set");
  return streamTextImpl(config);
});
mock.module("ai", () => ({
  ...aiActual,
  streamText,
}));

mock.module("@/lib/providers/language-model", () => ({
  ...languageModelActual,
  getLanguageModel: () => ({}) as never,
}));

const { __streamingCreditTestHooks } = await import(
  "../v1/chat/completions/route"
);
const { handleStreamingRequest } = __streamingCreditTestHooks;

afterAll(() => {
  mock.module("ai", () => aiActual);
  mock.module("@/lib/providers/language-model", () => languageModelActual);
});

const ORG = "00000000-0000-4000-8000-0000000000aa";
const USER = "00000000-0000-4000-8000-0000000000bb";
const MODEL = "openai/gpt-oss-120b";

function callStreaming(request: Record<string, unknown>) {
  return handleStreamingRequest(
    MODEL,
    undefined,
    [{ role: "user", content: "hello" }] as never,
    request as never,
    { id: USER, organization_id: ORG },
    null,
    null,
    "idem-1",
    "req-1",
    null,
    Date.now(),
    undefined,
    30_000,
    1,
    (async () => null) as never,
    (async () => null) as never,
    undefined,
    {} as never,
    undefined,
    {} as never,
    "gateway" as never,
    null,
    false,
  );
}

async function collectJsonFrames(res: Response) {
  const body = await res.text();
  const dataLines = body
    .split("\n")
    .filter((l) => l.startsWith("data: "))
    .map((l) => l.slice("data: ".length).trim());
  const jsonFrames = dataLines
    .filter((d) => d && d !== "[DONE]")
    .map((d) => JSON.parse(d) as Record<string, unknown>);
  return { body, dataLines, jsonFrames };
}

type ToolCallFragment = {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

/** Aggregate fragments per index exactly the way an OpenAI streaming client does. */
function aggregateToolCalls(jsonFrames: Array<Record<string, unknown>>) {
  const byIndex = new Map<
    number,
    { id?: string; name?: string; args: string }
  >();
  for (const frame of jsonFrames) {
    const choices = frame.choices as
      | Array<{ delta?: { tool_calls?: ToolCallFragment[] } }>
      | undefined;
    for (const choice of choices ?? []) {
      for (const fragment of choice.delta?.tool_calls ?? []) {
        const entry = byIndex.get(fragment.index) ?? { args: "" };
        if (fragment.id) entry.id = fragment.id;
        if (fragment.function?.name) entry.name = fragment.function.name;
        if (fragment.function?.arguments)
          entry.args += fragment.function.arguments;
        byIndex.set(fragment.index, entry);
      }
    }
  }
  return byIndex;
}

const ARGS = '{"command": "pip --version && pip install requests"}';

beforeEach(() => {
  streamText.mockClear();
  streamTextImpl = null;
});

describe("streaming chat — tool_call argument fragments", () => {
  test("input streamed via tool-input-delta is not duplicated by the consolidated tool-call part", async () => {
    streamTextImpl = () => ({
      fullStream: (async function* () {
        yield { type: "tool-input-start", id: "call_1", toolName: "terminal" };
        yield { type: "tool-input-delta", id: "call_1", delta: ARGS };
        yield {
          type: "tool-call",
          toolCallId: "call_1",
          toolName: "terminal",
          input: JSON.parse(ARGS),
        };
        yield { type: "finish", finishReason: "tool-calls" };
      })(),
    });

    const res = await callStreaming({
      model: MODEL,
      messages: [{ role: "user", content: "fix pip" }],
      stream: true,
    });
    const { dataLines, jsonFrames } = await collectJsonFrames(res);

    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
    const finalChunk = jsonFrames[jsonFrames.length - 1] as {
      choices: Array<{ finish_reason: string | null }>;
    };
    expect(finalChunk.choices[0].finish_reason).toBe("tool_calls");

    const calls = aggregateToolCalls(jsonFrames);
    expect(calls.size).toBe(1);
    const call = calls.get(0);
    expect(call?.id).toBe("call_1");
    expect(call?.name).toBe("terminal");
    // The client-side concatenation is exactly the streamed input, once.
    expect(call?.args).toBe(ARGS);
    expect(JSON.parse(call?.args ?? "")).toEqual(JSON.parse(ARGS));
  });

  test("a consolidated-only tool call (no input fragments) still emits full arguments", async () => {
    streamTextImpl = () => ({
      fullStream: (async function* () {
        yield {
          type: "tool-call",
          toolCallId: "call_solo",
          toolName: "terminal",
          input: JSON.parse(ARGS),
        };
        yield { type: "finish", finishReason: "tool-calls" };
      })(),
    });

    const res = await callStreaming({
      model: MODEL,
      messages: [{ role: "user", content: "fix pip" }],
      stream: true,
    });
    const { jsonFrames } = await collectJsonFrames(res);

    const calls = aggregateToolCalls(jsonFrames);
    const call = calls.get(0);
    expect(call?.id).toBe("call_solo");
    expect(call?.name).toBe("terminal");
    expect(JSON.parse(call?.args ?? "")).toEqual(JSON.parse(ARGS));
  });

  test("a started call with an empty delta stream falls back to the consolidated emission", async () => {
    streamTextImpl = () => ({
      fullStream: (async function* () {
        yield { type: "tool-input-start", id: "call_2", toolName: "terminal" };
        yield {
          type: "tool-call",
          toolCallId: "call_2",
          toolName: "terminal",
          input: JSON.parse(ARGS),
        };
        yield { type: "finish", finishReason: "tool-calls" };
      })(),
    });

    const res = await callStreaming({
      model: MODEL,
      messages: [{ role: "user", content: "fix pip" }],
      stream: true,
    });
    const { jsonFrames } = await collectJsonFrames(res);

    const calls = aggregateToolCalls(jsonFrames);
    const call = calls.get(0);
    expect(call?.id).toBe("call_2");
    expect(call?.name).toBe("terminal");
    // start emitted "" then the consolidated part supplied the full input.
    expect(JSON.parse(call?.args ?? "")).toEqual(JSON.parse(ARGS));
  });

  test("multiple streamed tool calls keep distinct indexes and single-copy arguments", async () => {
    const argsB = '{"command":"ls -la"}';
    streamTextImpl = () => ({
      fullStream: (async function* () {
        yield { type: "tool-input-start", id: "call_a", toolName: "terminal" };
        yield { type: "tool-input-delta", id: "call_a", delta: ARGS };
        yield {
          type: "tool-call",
          toolCallId: "call_a",
          toolName: "terminal",
          input: JSON.parse(ARGS),
        };
        yield { type: "tool-input-start", id: "call_b", toolName: "terminal" };
        yield { type: "tool-input-delta", id: "call_b", delta: argsB };
        yield {
          type: "tool-call",
          toolCallId: "call_b",
          toolName: "terminal",
          input: JSON.parse(argsB),
        };
        yield { type: "finish", finishReason: "tool-calls" };
      })(),
    });

    const res = await callStreaming({
      model: MODEL,
      messages: [{ role: "user", content: "fix pip" }],
      stream: true,
    });
    const { jsonFrames } = await collectJsonFrames(res);

    const calls = aggregateToolCalls(jsonFrames);
    expect(calls.size).toBe(2);
    expect(calls.get(0)?.args).toBe(ARGS);
    expect(calls.get(1)?.args).toBe(argsB);
    expect(calls.get(0)?.id).toBe("call_a");
    expect(calls.get(1)?.id).toBe("call_b");
  });
});
