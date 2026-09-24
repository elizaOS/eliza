/** Validates deterministic full-history serialization and explicit request rejection without model I/O. */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canonicalizeChatCompletion,
  computeLogicalKeySha256,
  GatewayRequestError,
} from "../src/index.js";

it("matches the cross-language logical-key and full request-id vector", () => {
  const key = computeLogicalKeySha256({
    harness: "hermes",
    namespaceSha256: "b".repeat(64),
    ordinal: 17,
    requestSha256: "a".repeat(64),
    model: "claude-opus-4-6",
    reasoningEffort: "medium",
  });
  expect(key).toBe(
    "3754bb89fae2c50ce3c9d5deceae329461dd3aba5860d77120af8092cc6b5a19",
  );
  expect(`logical_${key}`).toBe(
    "logical_3754bb89fae2c50ce3c9d5deceae329461dd3aba5860d77120af8092cc6b5a19",
  );
});

function requestWithSchema(schema: Record<string, unknown>) {
  return {
    model: "claude-opus-4-8",
    messages: [
      { role: "system", content: "Keep the answer short." },
      { role: "user", content: "Weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "previous-call",
            type: "function",
            function: { name: "weather", arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "previous-call", content: "Sunny" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "weather",
          description: "Look up weather.",
          parameters: schema,
        },
      },
    ],
    tool_choice: "auto",
    temperature: 0,
    max_completion_tokens: 100,
  };
}

describe("canonicalizeChatCompletion", () => {
  it("preserves every history role and records unsupported control fields", () => {
    const canonical = canonicalizeChatCompletion(
      requestWithSchema({
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      }),
    );

    expect(canonical.prompt).toContain('"role":"system"');
    expect(canonical.prompt).toContain('"role":"assistant"');
    expect(canonical.prompt).toContain('"role":"tool"');
    expect(canonical.prompt).toContain('"tool_call_id":"previous-call"');
    expect(canonical.serializerVersion).toBe("openai-full-history-v1");
    expect(canonical.unappliedParameters).toEqual([
      "temperature",
      "max_output_tokens",
    ]);
    expect(canonical.requestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("sorts JSON object keys so equivalent schemas hash identically", () => {
    const left = canonicalizeChatCompletion(
      requestWithSchema({
        required: ["city"],
        properties: { city: { description: "City", type: "string" } },
        type: "object",
      }),
    );
    const right = canonicalizeChatCompletion(
      requestWithSchema({
        type: "object",
        properties: { city: { type: "string", description: "City" } },
        required: ["city"],
      }),
    );

    expect(left.toolSchemaSha256).toBe(right.toolSchemaSha256);
    expect(left.toolSchemaSha256ByName).toEqual(right.toolSchemaSha256ByName);
    expect(left.toolSchemaSha256ByName.weather).toMatch(/^[a-f0-9]{64}$/);
    expect(left.requestSha256).toBe(right.requestSha256);
  });

  it("hashes each tool independently of neighboring native planner tools", () => {
    const tasksTool: unknown = JSON.parse(
      readFileSync(
        new URL(
          "../../orchestrator_lifecycle/tasks-tool.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const canonical = canonicalizeChatCompletion({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Start work." }],
      tools: [
        tasksTool,
        {
          type: "function",
          function: {
            name: "REPLY",
            description: "Return text.",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    });

    expect(canonical.toolSchemaSha256ByName.TASKS).toBe(
      "5e61574cc504c156aefc47cde293a031d1a2301daa10b1664bf3902c42c05535",
    );
    expect(canonical.toolSchemaSha256).not.toBe(
      canonical.toolSchemaSha256ByName.TASKS,
    );
  });

  it("accepts SSE as a response mode without changing the semantic request hash", () => {
    const request = {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: "hello" }],
    };
    const nonStreaming = canonicalizeChatCompletion(request);
    const streaming = canonicalizeChatCompletion({
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    });

    expect(streaming.request.stream).toBe(true);
    expect(streaming.request.streamOptionsIncludeUsage).toBe(true);
    expect(streaming.requestSha256).toBe(nonStreaming.requestSha256);
  });

  it("preserves long authority messages once in history without duplicating them into the SDK system prompt", () => {
    const authority = `native-system-${"instruction ".repeat(800)}`;
    const canonical = canonicalizeChatCompletion({
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: authority },
        { role: "user", content: "Continue." },
      ],
    });

    expect(canonical.prompt).toContain(authority);
    expect(canonical.systemPrompt).not.toContain(authority);
    expect(canonical.systemPrompt).toContain(
      "System and developer messages appear by role",
    );
    expect(Buffer.byteLength(canonical.systemPrompt)).toBeLessThan(1_000);
  });

  it("rejects malformed streaming controls", () => {
    expect(() =>
      canonicalizeChatCompletion({
        model: "claude-opus-4-8",
        messages: [{ role: "user", content: "hello" }],
        stream: "yes",
      }),
    ).toThrowError(GatewayRequestError);
  });
});
