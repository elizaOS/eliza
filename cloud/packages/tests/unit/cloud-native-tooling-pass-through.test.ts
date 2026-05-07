import { describe, expect, test } from "bun:test";
import { __nativeToolingTestHooks as chatHooks } from "@/apps/api/v1/chat/completions/route";
import { __nativeToolingTestHooks as gatewayHooks } from "@/lib/providers/vercel-ai-gateway";

describe("cloud native tool pass-through", () => {
  test("preserves OpenAI assistant tool calls and tool results for chat completions", () => {
    const messages = chatHooks.convertToModelMessagesFromOpenAI([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"milady"}' },
          },
        ],
      },
      {
        role: "tool",
        content: "found",
        tool_call_id: "call_1",
      },
    ] as never);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call_1",
            toolName: "lookup",
            input: { query: "milady" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "lookup",
            output: { type: "text", value: "found" },
          },
        ],
      },
    ]);
  });

  test("maps OpenAI tools and tool_choice into AI SDK native tool fields", () => {
    const tools = chatHooks.convertTools([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup records",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      },
    ]);

    expect(Object.keys(tools ?? {})).toEqual(["lookup"]);
    expect(chatHooks.mapToolChoice({ type: "function", function: { name: "lookup" } })).toEqual({
      type: "tool",
      toolName: "lookup",
    });
  });

  test("gateway adapter preserves tool messages and native tool schema", () => {
    const messages = gatewayHooks.toModelMessages([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"gateway"}' },
          },
        ],
      },
      {
        role: "tool",
        content: "ok",
        tool_call_id: "call_2",
      },
    ] as never);

    expect(messages[0]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call_2",
          toolName: "lookup",
          input: { query: "gateway" },
        },
      ],
    });
    expect(messages[1]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call_2",
          toolName: "lookup",
          output: { type: "text", value: "ok" },
        },
      ],
    });

    expect(
      Object.keys(
        gatewayHooks.toGatewayTools([
          {
            type: "function",
            function: { name: "lookup", parameters: { type: "object" } },
          },
        ] as never) ?? {},
      ),
    ).toEqual(["lookup"]);
  });
});
