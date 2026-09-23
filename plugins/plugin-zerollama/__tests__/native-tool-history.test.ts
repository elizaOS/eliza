/** Exercises the native text handler with real serializers and a captured HTTP transport. */
import type { GenerateTextParams, IAgentRuntime, TextStreamResult } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleZerollamaText } from "../models/zerollama-text";

const runtime = {
  character: { name: "wire test", system: "Preserve complete records." },
  getSetting: () => undefined,
  emitEvent: async () => undefined,
} as unknown as IAgentRuntime;

const calls = [
  { type: "tool-call", toolCallId: "read-a", toolName: "READ", input: { key: "A  B" } },
  { type: "tool-call", toolCallId: "read-b", toolName: "READ", input: { key: "O’Connor" } },
];
const results = [
  {
    type: "tool-result",
    toolCallId: "read-b",
    toolName: "READ",
    output: { type: "json", value: { literal: "O’Connor", nested: { amount: 3, unit: "MW" } } },
  },
  {
    type: "tool-result",
    toolCallId: "read-a",
    toolName: "READ",
    output: { type: "text", value: 'Power: 3 mW.\nThe label is "A  B".' },
  },
];

function capture(stream = false) {
  return vi.fn<typeof fetch>(async () => {
    const payload = {
      message: { content: "Complete." },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 8,
      eval_count: 2,
    };
    return stream ? new Response(`${JSON.stringify(payload)}\n`) : Response.json(payload);
  });
}

function invoke(fetchImpl: typeof fetch, messages: unknown[], stream = false) {
  return handleZerollamaText({
    runtime,
    modelType: "RESPONSE_HANDLER",
    model: "local-fixture",
    baseURL: "http://127.0.0.1:1",
    fetchImpl,
    params: { messages, stream } as GenerateTextParams,
  });
}

describe("native planner tool history", () => {
  it.each([false, true])(
    "preserves complete parallel tool history through the handler (stream=%s)",
    async (stream) => {
      const fetchImpl = capture(stream);
      const response = await invoke(
        fetchImpl,
        [
          { role: "system", content: "Preserve complete records." },
          {
            role: "assistant",
            content: [{ type: "text", text: "Reading both records." }, ...calls],
          },
          { role: "tool", content: results },
        ],
        stream
      );
      if (stream) {
        const result = response as unknown as TextStreamResult;
        let text = "";
        for await (const chunk of result.textStream) text += chunk;
        expect(text).toBe("Complete.");
        await expect(result.text).resolves.toBe("Complete.");
      }
      const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
      expect(body.messages).toEqual([
        { role: "system", content: "Preserve complete records." },
        {
          role: "assistant",
          content: "Reading both records.",
          tool_calls: calls.map((call) => ({
            id: call.toolCallId,
            function: { name: call.toolName, arguments: call.input },
          })),
        },
        ...results.map((result) => ({ role: "tool", content: JSON.stringify(result) })),
      ]);
      expect(
        body.messages.slice(2).map((message: { content: string }) => JSON.parse(message.content))
      ).toEqual(results);
    }
  );

  it.each([
    { system: "Explicit policy.", expected: ["Explicit policy.", "Message policy."] },
    { system: "Message policy.", expected: ["Message policy."] },
    { system: "", expected: ["Message policy."] },
  ])("preserves system instructions with override $system", async ({ system, expected }) => {
    const fetchImpl = capture();
    await handleZerollamaText({
      runtime,
      modelType: "RESPONSE_HANDLER",
      model: "local-fixture",
      baseURL: "http://127.0.0.1:1",
      fetchImpl,
      params: {
        system,
        messages: [
          { role: "system", content: "Message policy." },
          { role: "user", content: "Read the records." },
        ],
      } as GenerateTextParams,
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.messages).toEqual([
      ...expected.map((content) => ({ role: "system", content })),
      { role: "user", content: "Read the records." },
    ]);
  });

  it("retains legacy top-level tool calls and result identities", async () => {
    const fetchImpl = capture();
    await invoke(fetchImpl, [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "legacy-call", name: "READ", arguments: { key: "A  B" } }],
      },
      { role: "tool", toolCallId: "legacy-call", toolName: "READ", content: "  exact text\n" },
    ]);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.messages[1].tool_calls).toEqual([
      { id: "legacy-call", function: { name: "READ", arguments: { key: "A  B" } } },
    ]);
    expect(JSON.parse(body.messages[2].content)).toEqual({
      type: "tool-result",
      toolCallId: "legacy-call",
      toolName: "READ",
      output: { type: "text", value: "  exact text\n" },
    });
  });

  it("rejects malformed structured results before dispatch", async () => {
    const fetchImpl = capture();
    await expect(
      invoke(fetchImpl, [
        { role: "tool", content: [{ ...results[1], output: { type: "text", value: null } }] },
      ])
    ).rejects.toMatchObject({ code: "OLLAMA_INVALID_MESSAGE_CONTENT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unsupported native content rather than dropping it", async () => {
    const fetchImpl = capture();
    await expect(
      invoke(fetchImpl, [
        { role: "user", content: [{ type: "image", image: "https://example.invalid/image.png" }] },
      ])
    ).rejects.toMatchObject({ code: "OLLAMA_UNSUPPORTED_MESSAGE_CONTENT" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
