/**
 * Exercises OpenAI-compatible tool-call SSE translation through the real route
 * handler while substituting only the provider stream boundary.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

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

type StreamPart = Record<string, unknown>;

function useProviderStream(parts: readonly StreamPart[]) {
  streamTextImpl = () => ({
    fullStream: (async function* () {
      for (const part of parts) yield part;
    })(),
  });
}

function callStreaming() {
  return handleStreamingRequest(
    MODEL,
    undefined,
    [{ role: "user", content: "use the requested tools" }] as never,
    {
      model: MODEL,
      messages: [{ role: "user", content: "use the requested tools" }],
      stream: true,
    } as never,
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
    {} as never,
    undefined,
    {} as never,
    "gateway" as never,
    null,
    false,
  );
}

async function collectJsonFrames(response: Response) {
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

type ToolCallFragment = {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};

function aggregateToolCalls(jsonFrames: Array<Record<string, unknown>>) {
  const byIndex = new Map<
    number,
    { id?: string; name?: string; arguments: string }
  >();
  for (const frame of jsonFrames) {
    const choices = frame.choices as
      | Array<{ delta?: { content?: string; tool_calls?: ToolCallFragment[] } }>
      | undefined;
    for (const choice of choices ?? []) {
      for (const fragment of choice.delta?.tool_calls ?? []) {
        const entry = byIndex.get(fragment.index) ?? { arguments: "" };
        if (fragment.id) entry.id = fragment.id;
        if (fragment.function?.name) entry.name = fragment.function.name;
        if (fragment.function?.arguments) {
          entry.arguments += fragment.function.arguments;
        }
        byIndex.set(fragment.index, entry);
      }
    }
  }
  return byIndex;
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

function expectProtocolFailure(
  dataLines: string[],
  jsonFrames: Array<Record<string, unknown>>,
) {
  expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
  const errorFrames = jsonFrames.filter((frame) => "error" in frame) as Array<{
    error: { code: string; message: string; type: string };
  }>;
  expect(errorFrames).toHaveLength(1);
  expect(errorFrames[0]?.error.code).toBe("CHAT_TOOL_CALL_STREAM_INVALID");
  expect(errorFrames[0]?.error.type).toBe("service_unavailable");
  expect(errorFrames[0]?.error.message).toBe(
    "Provider returned an invalid streamed tool call",
  );
  expect(finalFinishReason(jsonFrames)).toBeNull();
}

beforeEach(() => {
  streamText.mockClear();
  streamTextImpl = null;
});

describe("streaming chat tool-call arguments", () => {
  test("leaves text-only streams unchanged", async () => {
    useProviderStream([
      { type: "text-delta", id: "text_1", text: "unchanged" },
    ]);

    const { dataLines, jsonFrames } = await collectJsonFrames(
      await callStreaming(),
    );

    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
    expect(finalFinishReason(jsonFrames)).toBe("stop");
    expect(aggregateToolCalls(jsonFrames).size).toBe(0);
    expect(
      jsonFrames.some((frame) => {
        const choices = frame.choices as
          | Array<{ delta?: { content?: string } }>
          | undefined;
        return choices?.[0]?.delta?.content === "unchanged";
      }),
    ).toBe(true);
  });

  test("reconstructs fragmented interleaved calls once with stable indexes", async () => {
    const fragmentsA = [
      '{"emoji":"',
      "\ud83d",
      "\ude80",
      '","escaped":"line',
      "\\",
      'nnext"}',
    ];
    const fragmentsB = ['{"count":', "2", ',"ok":true}'];
    const argumentsA = fragmentsA.join("");
    const argumentsB = fragmentsB.join("");

    useProviderStream([
      {
        type: "tool-input-start",
        id: "call_a",
        toolName: "write_note",
      },
      { type: "tool-input-delta", id: "call_a", delta: fragmentsA[0] },
      {
        type: "tool-input-start",
        id: "call_b",
        toolName: "set_count",
      },
      { type: "tool-input-delta", id: "call_b", delta: fragmentsB[0] },
      { type: "tool-input-delta", id: "call_a", delta: fragmentsA[1] },
      { type: "text-delta", id: "text_1", text: "working" },
      { type: "tool-input-delta", id: "call_b", delta: fragmentsB[1] },
      { type: "tool-input-delta", id: "call_a", delta: fragmentsA[2] },
      { type: "tool-input-delta", id: "call_b", delta: fragmentsB[2] },
      { type: "tool-input-end", id: "call_b" },
      {
        type: "tool-call",
        toolCallId: "call_b",
        toolName: "set_count",
        input: { ok: true, count: 2 },
      },
      { type: "tool-input-delta", id: "call_a", delta: fragmentsA[3] },
      { type: "tool-input-delta", id: "call_a", delta: fragmentsA[4] },
      { type: "tool-input-delta", id: "call_a", delta: fragmentsA[5] },
      { type: "tool-input-end", id: "call_a" },
      {
        type: "tool-call",
        toolCallId: "call_a",
        toolName: "write_note",
        input: JSON.parse(argumentsA),
      },
      { type: "finish", finishReason: "tool-calls" },
    ]);

    const { dataLines, jsonFrames } = await collectJsonFrames(
      await callStreaming(),
    );

    expect(dataLines[dataLines.length - 1]).toBe("[DONE]");
    expect(finalFinishReason(jsonFrames)).toBe("tool_calls");
    const calls = aggregateToolCalls(jsonFrames);
    expect(calls.size).toBe(2);
    expect(calls.get(0)).toEqual({
      id: "call_a",
      name: "write_note",
      arguments: argumentsA,
    });
    expect(calls.get(1)).toEqual({
      id: "call_b",
      name: "set_count",
      arguments: argumentsB,
    });
    expect(JSON.parse(calls.get(0)?.arguments ?? "")).toEqual(
      JSON.parse(argumentsA),
    );
    expect(JSON.parse(calls.get(1)?.arguments ?? "")).toEqual(
      JSON.parse(argumentsB),
    );
    expect(
      jsonFrames.some((frame) => {
        const choices = frame.choices as
          | Array<{ delta?: { content?: string } }>
          | undefined;
        return choices?.[0]?.delta?.content === "working";
      }),
    ).toBe(true);
  });

  test("emits complete arguments for consolidated-only and empty-delta providers", async () => {
    useProviderStream([
      {
        type: "tool-input-start",
        id: "call_empty",
        toolName: "empty_delta",
      },
      { type: "tool-input-delta", id: "call_empty", delta: "" },
      {
        type: "tool-call",
        toolCallId: "call_solo",
        toolName: "consolidated_only",
        input: { enabled: true },
      },
      {
        type: "tool-call",
        toolCallId: "call_empty",
        toolName: "empty_delta",
        input: {},
      },
      { type: "finish", finishReason: "stop" },
    ]);

    const { jsonFrames } = await collectJsonFrames(await callStreaming());
    const calls = aggregateToolCalls(jsonFrames);

    expect(calls.size).toBe(2);
    expect(calls.get(0)).toEqual({
      id: "call_empty",
      name: "empty_delta",
      arguments: "{}",
    });
    expect(calls.get(1)).toEqual({
      id: "call_solo",
      name: "consolidated_only",
      arguments: '{"enabled":true}',
    });
    expect(finalFinishReason(jsonFrames)).toBe("tool_calls");
  });

  test("accepts semantically identical fragmented and consolidated JSON", async () => {
    const streamed = '{"nested":{"b":2,"a":1},"items":[true,null]}';
    useProviderStream([
      {
        type: "tool-input-start",
        id: "call_order",
        toolName: "ordered",
      },
      { type: "tool-input-delta", id: "call_order", delta: streamed },
      {
        type: "tool-call",
        toolCallId: "call_order",
        toolName: "ordered",
        input: { items: [true, null], nested: { a: 1, b: 2 } },
      },
      { type: "finish", finishReason: "tool-calls" },
    ]);

    const { jsonFrames } = await collectJsonFrames(await callStreaming());

    expect(aggregateToolCalls(jsonFrames).get(0)?.arguments).toBe(streamed);
    expect(finalFinishReason(jsonFrames)).toBe("tool_calls");
  });

  test("rejects malformed, incomplete, or mismatched argument fragments", async () => {
    const cases: Array<{
      streamed: string;
      input: unknown;
    }> = [
      { streamed: '{"value":', input: { value: 1 } },
      { streamed: '{"value":]}', input: { value: 1 } },
      { streamed: '{"value":2}', input: { value: 1 } },
      { streamed: '{"value":1}{"extra":2}', input: { value: 1 } },
    ];

    for (const scenario of cases) {
      useProviderStream([
        {
          type: "tool-input-start",
          id: "call_invalid",
          toolName: "validate",
        },
        {
          type: "tool-input-delta",
          id: "call_invalid",
          delta: scenario.streamed,
        },
        {
          type: "tool-call",
          toolCallId: "call_invalid",
          toolName: "validate",
          input: scenario.input,
        },
        { type: "finish", finishReason: "tool-calls" },
      ]);

      const { dataLines, jsonFrames } = await collectJsonFrames(
        await callStreaming(),
      );
      expectProtocolFailure(dataLines, jsonFrames);
    }
  });

  test("rejects duplicate identities and out-of-order argument events", async () => {
    const cases: StreamPart[][] = [
      [
        { type: "tool-input-delta", id: "call_missing", delta: "{}" },
        { type: "finish", finishReason: "tool-calls" },
      ],
      [
        {
          type: "tool-input-start",
          id: "call_duplicate",
          toolName: "validate",
        },
        {
          type: "tool-input-start",
          id: "call_duplicate",
          toolName: "validate",
        },
        { type: "finish", finishReason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          toolCallId: "call_complete",
          toolName: "validate",
          input: {},
        },
        {
          type: "tool-call",
          toolCallId: "call_complete",
          toolName: "validate",
          input: {},
        },
        { type: "finish", finishReason: "tool-calls" },
      ],
    ];

    for (const parts of cases) {
      useProviderStream(parts);
      const { dataLines, jsonFrames } = await collectJsonFrames(
        await callStreaming(),
      );
      expectProtocolFailure(dataLines, jsonFrames);
    }
  });

  test("rejects invalid tool-input-end ordering", async () => {
    const cases: StreamPart[][] = [
      [
        { type: "tool-input-end", id: "call_missing" },
        { type: "finish", finishReason: "tool-calls" },
      ],
      [
        {
          type: "tool-input-start",
          id: "call_delta_after_end",
          toolName: "validate",
        },
        { type: "tool-input-end", id: "call_delta_after_end" },
        {
          type: "tool-input-delta",
          id: "call_delta_after_end",
          delta: "{}",
        },
        { type: "finish", finishReason: "tool-calls" },
      ],
      [
        {
          type: "tool-input-start",
          id: "call_duplicate_end",
          toolName: "validate",
        },
        { type: "tool-input-end", id: "call_duplicate_end" },
        { type: "tool-input-end", id: "call_duplicate_end" },
        { type: "finish", finishReason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          toolCallId: "call_completed_before_end",
          toolName: "validate",
          input: {},
        },
        { type: "tool-input-end", id: "call_completed_before_end" },
        { type: "finish", finishReason: "tool-calls" },
      ],
    ];

    for (const parts of cases) {
      useProviderStream(parts);
      const { dataLines, jsonFrames } = await collectJsonFrames(
        await callStreaming(),
      );
      expectProtocolFailure(dataLines, jsonFrames);
    }
  });

  test("rejects duplicate finish and every event after finish", async () => {
    const cases: StreamPart[][] = [
      [
        { type: "finish", finishReason: "stop" },
        { type: "finish", finishReason: "stop" },
      ],
      [
        { type: "finish", finishReason: "stop" },
        { type: "text-delta", id: "text_after_finish", text: "late" },
      ],
      [
        { type: "finish", finishReason: "stop" },
        {
          type: "tool-input-start",
          id: "call_after_finish",
          toolName: "validate",
        },
      ],
    ];

    for (const parts of cases) {
      useProviderStream(parts);
      const { dataLines, jsonFrames } = await collectJsonFrames(
        await callStreaming(),
      );
      expectProtocolFailure(dataLines, jsonFrames);
    }
  });

  test("rejects streams missing a completed call or terminal finish event", async () => {
    const cases: StreamPart[][] = [
      [
        {
          type: "tool-input-start",
          id: "call_truncated",
          toolName: "validate",
        },
        { type: "tool-input-delta", id: "call_truncated", delta: "{}" },
        { type: "finish", finishReason: "tool-calls" },
      ],
      [
        {
          type: "tool-call",
          toolCallId: "call_no_finish",
          toolName: "validate",
          input: {},
        },
      ],
    ];

    for (const parts of cases) {
      useProviderStream(parts);
      const { dataLines, jsonFrames } = await collectJsonFrames(
        await callStreaming(),
      );
      expectProtocolFailure(dataLines, jsonFrames);
    }
  });
});
