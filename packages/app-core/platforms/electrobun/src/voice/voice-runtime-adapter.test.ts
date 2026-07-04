/** Exercises voice runtime adapter behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";
import { VoiceError } from "./errors";
import {
  parseVoiceSseStream,
  RuntimeHttpVoiceAdapter,
} from "./voice-runtime-adapter";

const enc = new TextEncoder();

/** A streamable Response from raw SSE byte chunks (chunk boundaries matter). */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe("parseVoiceSseStream", () => {
  it("yields each data frame and skips comments / [DONE] / malformed", async () => {
    const body = sseResponse([
      ": heartbeat\n\n",
      frame({ type: "token", text: "a", fullText: "a" }),
      "data: not-json\n\n",
      frame({ type: "done", fullText: "a" }),
      "data: [DONE]\n\n",
    ]).body as ReadableStream<Uint8Array>;
    const frames: Array<Record<string, unknown>> = [];
    for await (const f of parseVoiceSseStream(body)) frames.push(f);
    expect(frames.map((f) => f.type)).toEqual(["token", "done"]);
  });

  it("reassembles a frame split across read() boundaries", async () => {
    const full = frame({
      type: "token",
      text: "hello world",
      fullText: "hello world",
    });
    const mid = Math.floor(full.length / 2);
    const body = sseResponse([full.slice(0, mid), full.slice(mid)])
      .body as ReadableStream<Uint8Array>;
    const frames: Array<Record<string, unknown>> = [];
    for await (const f of parseVoiceSseStream(body)) frames.push(f);
    expect(frames).toHaveLength(1);
    expect(frames[0].text).toBe("hello world");
  });
});

describe("RuntimeHttpVoiceAdapter.sendRuntimeMessageStream", () => {
  function makeAdapter(streamResponse: Response) {
    const calls: Array<{ path: string; body: unknown }> = [];
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const path = String(url);
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, body });
      if (path.endsWith("/api/conversations")) {
        return new Response(JSON.stringify({ id: "conv-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (path.includes("/messages/stream")) {
        return streamResponse;
      }
      throw new Error(`unexpected fetch: ${path}`);
    }) as unknown as typeof fetch;
    const adapter = new RuntimeHttpVoiceAdapter({
      apiBase: "http://test",
      env: { ELIZA_VOICE_LIVE_RUNTIME: "1" },
      fetchImpl,
    });
    return { adapter, calls };
  }

  it("streams token deltas (raw whitespace) then resolves the full reply", async () => {
    const { adapter, calls } = makeAdapter(
      sseResponse([
        frame({ type: "token", text: "Hello", fullText: "Hello" }),
        frame({ type: "token", text: " world", fullText: "Hello world" }),
        frame({ type: "done", fullText: "Hello world", agentName: "Eliza" }),
      ]),
    );

    const deltas: Array<[string, string]> = [];
    let done: { fullText: string; agentName?: string } | undefined;
    const result = await adapter.sendRuntimeMessageStream(
      { text: "hi" },
      {
        onTextDelta: (delta, full) => deltas.push([delta, full]),
        onDone: (d) => {
          done = d;
        },
      },
    );

    expect(deltas).toEqual([
      ["Hello", "Hello"],
      [" world", "Hello world"], // leading space preserved (not trimmed)
    ]);
    expect(done).toEqual({ fullText: "Hello world", agentName: "Eliza" });
    expect(result.responseText).toBe("Hello world");
    expect(result.conversationId).toBe("conv-1");
    // It used the streaming endpoint, not the buffered /messages route.
    expect(calls.some((c) => c.path.includes("/messages/stream"))).toBe(true);
    expect(calls.some((c) => /\/messages$/.test(c.path.split("?")[0]))).toBe(
      false,
    );
  });

  it("throws a VoiceError on an error frame", async () => {
    const { adapter } = makeAdapter(
      sseResponse([frame({ type: "error", message: "model exploded" })]),
    );
    await expect(
      adapter.sendRuntimeMessageStream(
        { text: "hi" },
        { onTextDelta: () => {} },
      ),
    ).rejects.toThrow("model exploded");
  });

  it("throws when streaming is disabled (no live-runtime env)", async () => {
    const adapter = new RuntimeHttpVoiceAdapter({
      apiBase: "http://test",
      env: {},
      fetchImpl: (async () => new Response("")) as unknown as typeof fetch,
    });
    await expect(
      adapter.sendRuntimeMessageStream(
        { text: "hi" },
        { onTextDelta: () => {} },
      ),
    ).rejects.toBeInstanceOf(VoiceError);
  });

  it("throws on a non-2xx stream response", async () => {
    const { adapter } = makeAdapter(
      new Response("nope", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );
    await expect(
      adapter.sendRuntimeMessageStream(
        { text: "hi" },
        { onTextDelta: () => {} },
      ),
    ).rejects.toBeInstanceOf(VoiceError);
  });
});

describe("RuntimeHttpVoiceAdapter.sendRuntimeMessage — voice semantics (#8786)", () => {
  function makeBufferedAdapter() {
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const path = String(url);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      calls.push({ path, body });
      if (path.endsWith("/api/conversations")) {
        return new Response(JSON.stringify({ id: "conv-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Buffered /messages reply.
      return new Response(JSON.stringify({ id: "m1", text: "hi back" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const adapter = new RuntimeHttpVoiceAdapter({
      apiBase: "http://test",
      env: { ELIZA_VOICE_LIVE_RUNTIME: "1" },
      fetchImpl,
    });
    return { adapter, calls };
  }

  it("sends a VOICE_DM carrying turn-signal metadata (not a plain DM)", async () => {
    const { adapter, calls } = makeBufferedAdapter();
    await adapter.sendRuntimeMessage({
      text: "what's the weather",
      metadata: { voiceTurnSignal: { agentShouldSpeak: true } },
    });
    const messagePost = calls.find((c) =>
      /\/messages$/.test(c.path.split("?")[0]),
    );
    expect(messagePost).toBeDefined();
    expect(messagePost?.body.channelType).toBe("VOICE_DM");
    // The caller's turn signal + a voiceSource are carried in metadata.
    expect(messagePost?.body.metadata).toMatchObject({
      voiceSource: "electrobun",
      voiceTurnSignal: { agentShouldSpeak: true },
    });
  });
});
