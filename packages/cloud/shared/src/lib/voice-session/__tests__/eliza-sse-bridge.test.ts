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
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/event-stream" },
  });
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

  test("uses the canonical persisted message route with minted agent + conversation identity", async () => {
    let seenUrl = "";
    let seenBody: { text?: string } | null = null;
    let seenHeaders: Headers | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = String(url);
      seenBody = JSON.parse(String(init.body));
      seenHeaders = new Headers(init.headers);
      return sseResponse([
        `event: chunk\ndata: ${JSON.stringify({ chunk: "persisted reply" })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ text: "persisted reply" })}\n\n`,
      ]);
    }) as unknown as typeof fetch;
    await streamElizaConversation(
      {
        endpoint: "http://x",
        authorization: "Bearer s",
        model: "m",
        transcript: "hi",
        agentId: "agent-XYZ",
        conversationId: "conv-ABC",
        organizationId: "org-123",
        userId: "user-456",
        traceId: "t",
        signal: new AbortController().signal,
        fetchImpl,
      },
      (delta) => expect(delta).toBe("persisted reply"),
    );
    expect(seenUrl).toBe(
      "http://x/api/v1/eliza/agents/agent-XYZ/api/conversations/conv-ABC/messages/stream",
    );
    expect(seenBody).toEqual({ text: "hi" });
    expect(seenHeaders?.get("Authorization")).toBe("Bearer s");
    expect(seenHeaders?.get("X-Service-Key")).toBe("Bearer s");
    expect(seenHeaders?.get("X-Eliza-Agent-Id")).toBe("agent-XYZ");
    expect(seenHeaders?.get("X-Eliza-Conversation-Id")).toBe("conv-ABC");
    expect(seenHeaders?.get("X-Eliza-Organization-Id")).toBe("org-123");
    expect(seenHeaders?.get("X-Eliza-User-Id")).toBe("user-456");
  });

  test("surfaces canonical agent stream errors instead of completing an empty turn", async () => {
    const fetchImpl = (async () =>
      sseResponse([
        `event: error\ndata: ${JSON.stringify({ message: "agent failed" })}\n\n`,
      ])) as unknown as typeof fetch;
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
    ).rejects.toMatchObject({
      code: "upstream_error",
      message: expect.stringContaining("agent failed"),
    });
  });

  test("aborting a never-ending internal response cancels its body reader", async () => {
    const controller = new AbortController();
    let responseCancelReason: unknown;
    const fetchImpl = (async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`,
            ),
          );
        },
        cancel(reason) {
          responseCancelReason = reason;
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
      () => controller.abort("barge-in"),
    );
    expect(result.aborted).toBe(true);
    expect(responseCancelReason).toBe("barge-in");
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
    ).rejects.toMatchObject({ code: "upstream_error", retryable: true });
  });

  test("preserves the canonical insufficient-credits code and retryability", async () => {
    const fetchImpl = (async () =>
      Response.json(
        {
          success: false,
          error: "Insufficient credits. Required: $0.0014, Available: $0.0000",
          code: "insufficient_credits",
          retryable: false,
        },
        { status: 402 },
      )) as unknown as typeof fetch;

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
    ).rejects.toMatchObject({
      code: "upstream_error",
      status: 402,
      upstreamCode: "insufficient_credits",
      retryable: false,
      message: expect.stringContaining("Insufficient credits"),
    });
  });
});
