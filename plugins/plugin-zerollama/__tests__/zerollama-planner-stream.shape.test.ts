/**
 * Regression tests for `zerollamaChatStream` planner streaming semantics.
 *
 * Guards the native planner fallback: when `plannerToolArgsOnly` is set and the
 * model answers with plain text instead of invoking a tool, the concatenated
 * `textStream` must equal the drained plan text (mirroring the AI-SDK sibling's
 * `fallbackText` yield in models/text.ts). Core's streaming path concatenates
 * only `textStream` chunks and never awaits the `.text` promise, so an empty
 * stream would silently drop the plan and produce no reply. Deterministic:
 * every case drives a ReadableStream NDJSON mock fetch, no network.
 */
import { describe, expect, it, vi } from "vitest";
import { zerollamaChatStream } from "../utils/zerollama-native";

function ndjsonFetch(lines: string[]): typeof fetch {
  const encoder = new TextEncoder();
  return vi.fn(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const line of lines) {
              controller.enqueue(encoder.encode(`${line}\n`));
            }
            controller.close();
          },
        })
      )
  ) as unknown as typeof fetch;
}

async function drain(stream: AsyncIterable<string>): Promise<string> {
  let streamed = "";
  for await (const chunk of stream) {
    streamed += chunk;
  }
  return streamed;
}

describe("zerollamaChatStream planner streaming", () => {
  it("yields the plan text when the model returns no tool call (regression: empty reply)", async () => {
    const planA = '{"thought":"hi",';
    const planB = '"actions":["REPLY"]}';
    const fetchImpl = ndjsonFetch([
      JSON.stringify({ message: { role: "assistant", content: planA } }),
      JSON.stringify({ message: { role: "assistant", content: planB } }),
      JSON.stringify({ done: true, done_reason: "stop" }),
    ]);
    const result = zerollamaChatStream({
      apiBase: "http://host:11434",
      body: { model: "eliza-1-2b", messages: [{ role: "user", content: "hi" }] },
      fetchImpl,
      promptForEstimate: "hi",
      modelName: "eliza-1-2b",
      plannerToolArgsOnly: true,
    });
    const streamed = await drain(result.textStream);
    // Before the fix: streamed === "" while `.text` held the plan, so core saw
    // an empty accumulated string and the planner parse failed → silent no-reply.
    expect(streamed).toBe(planA + planB);
    await expect(result.text).resolves.toBe(planA + planB);
    await expect(result.toolCalls).resolves.toEqual([]);
  });

  it("yields the first tool call's arguments JSON when a tool call is present", async () => {
    const fetchImpl = ndjsonFetch([
      JSON.stringify({
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_0",
              function: { name: "REPLY", arguments: { text: "hello" } },
            },
          ],
        },
      }),
      JSON.stringify({ done: true, done_reason: "tool-calls" }),
    ]);
    const result = zerollamaChatStream({
      apiBase: "http://host:11434",
      body: { model: "eliza-1-2b", messages: [{ role: "user", content: "hi" }] },
      fetchImpl,
      promptForEstimate: "hi",
      modelName: "eliza-1-2b",
      plannerToolArgsOnly: true,
    });
    const streamed = await drain(result.textStream);
    expect(streamed).toBe(JSON.stringify({ text: "hello" }));
    await expect(result.text).resolves.toBe(JSON.stringify({ text: "hello" }));
    const toolCalls = await result.toolCalls;
    expect(toolCalls?.[0]?.name).toBe("REPLY");
  });

  it("forwards every text delta when planner mode is off", async () => {
    const fetchImpl = ndjsonFetch([
      JSON.stringify({ message: { role: "assistant", content: "Hello " } }),
      JSON.stringify({ message: { role: "assistant", content: "world" } }),
      JSON.stringify({ done: true, done_reason: "stop" }),
    ]);
    const result = zerollamaChatStream({
      apiBase: "http://host:11434",
      body: { model: "eliza-1-2b", messages: [{ role: "user", content: "hi" }] },
      fetchImpl,
      promptForEstimate: "hi",
      modelName: "eliza-1-2b",
    });
    const streamed = await drain(result.textStream);
    expect(streamed).toBe("Hello world");
    await expect(result.text).resolves.toBe("Hello world");
  });
});
