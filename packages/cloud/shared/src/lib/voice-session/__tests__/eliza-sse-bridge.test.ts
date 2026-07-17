/**
 * Eliza SSE bridge: real OpenAI-shaped SSE decode + trace header + abort.
 * The fetch is scripted; the decoding path under test is real.
 */

import { describe, expect, test } from "bun:test";

import { streamElizaConversation, VOICE_TRACE_HEADER } from "../eliza-sse-bridge";

function sseResponse(lines: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const l of lines) controller.enqueue(encoder.encode(l));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "text/event-stream" } });
}

describe("eliza sse bridge", () => {
  test("decodes delta.content tokens and completes on [DONE]", async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: " world" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ])) as unknown as typeof fetch;

    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "gemma-4-31b",
        transcript: "hi",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-1",
        signal: new AbortController().signal,
        fetchImpl,
      },
      (d) => deltas.push(d),
    );
    expect(deltas).toEqual(["Hello", " world"]);
    expect(result.completed).toBe(true);
    expect(result.aborted).toBe(false);
  });

  test("propagates the voice trace header", async () => {
    let seenHeader: string | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seenHeader = new Headers(init.headers).get(VOICE_TRACE_HEADER);
      return sseResponse(["data: [DONE]\n\n"]);
    }) as unknown as typeof fetch;
    await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "hi",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "trace-XYZ",
        signal: new AbortController().signal,
        fetchImpl,
      },
      () => {},
    );
    expect(seenHeader).toBe("trace-XYZ");
  });

  test("scopes the request to the minted agent + conversation (body + headers)", async () => {
    let seenBody: {
      agentId?: string;
      conversationId?: string;
      stream_options?: { include_usage?: boolean };
    } | null = null;
    let seenHeaders: Headers | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seenBody = JSON.parse(String(init.body));
      seenHeaders = new Headers(init.headers);
      return sseResponse(["data: [DONE]\n\n"]);
    }) as unknown as typeof fetch;
    await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "hi",
        agentId: "agent-XYZ",
        conversationId: "conv-ABC",
        traceId: "t",
        signal: new AbortController().signal,
        fetchImpl,
      },
      () => {},
    );
    expect(seenBody?.agentId).toBe("agent-XYZ");
    expect(seenBody?.conversationId).toBe("conv-ABC");
    // Scope also travels in headers so schema-strict endpoints still route it.
    expect(seenHeaders?.get("X-Eliza-Agent-Id")).toBe("agent-XYZ");
    expect(seenHeaders?.get("X-Eliza-Conversation-Id")).toBe("conv-ABC");
    // The gateway's Cerebras byte pass-through only qualifies requests that
    // opt in to the terminal usage frame; without this the voice LLM leg
    // silently falls onto the slower AI-SDK decode/re-encode path.
    expect(seenBody?.stream_options).toEqual({ include_usage: true });
  });

  test("ignores the terminal usage frame (empty choices) before [DONE]", async () => {
    const deltas: string[] = [];
    const fetchImpl = (async () =>
      sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
        // include_usage terminal frame: empty choices + usage payload.
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`,
        "data: [DONE]\n\n",
      ])) as unknown as typeof fetch;
    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "hi",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "t",
        signal: new AbortController().signal,
        fetchImpl,
      },
      (d) => deltas.push(d),
    );
    expect(deltas).toEqual(["hi"]);
    expect(result.completed).toBe(true);
  });

  test("reports aborted when the signal fires mid-stream", async () => {
    const controller = new AbortController();
    const fetchImpl = (async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async start(c) {
          c.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`,
            ),
          );
          // Abort before the stream naturally ends.
          controller.abort();
          await new Promise((r) => setTimeout(r, 5));
          c.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "hi",
        agentId: "agent-1",
        conversationId: "conv-1",
        traceId: "t",
        signal: controller.signal,
        fetchImpl,
      },
      () => {},
    );
    expect(result.aborted).toBe(true);
  });

  test("throws an upstream error on a non-2xx response", async () => {
    const fetchImpl = (async () => sseResponse([], 500)) as unknown as typeof fetch;
    await expect(
      streamElizaConversation(
        {
          endpoint: "http://x",
          authorization: "Bearer s",
          model: "m",
          transcript: "hi",
          agentId: "agent-1",
          conversationId: "conv-1",
          traceId: "t",
          signal: new AbortController().signal,
          fetchImpl,
        },
        () => {},
      ),
    ).rejects.toMatchObject({ code: "upstream_error" });
  });
});
