/**
 * Client reducer coverage for legacy named SSE chat events (#17122): producers
 * such as the shared runtime, sandbox bridge, and control-plane fallback emit
 * `event: chunk|done|error` frames whose JSON payload has no `type`. The
 * client maps the SSE event name only when `type` is absent (explicit JSON
 * type wins), completes exactly once on a named done frame, preserves its
 * terminal metadata, and surfaces a named error frame as a structured
 * StreamGenerationError. Deterministic fake reader, no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client";
import { StreamGenerationError } from "./client-base";

type OnTokenCall = [token: string, accumulated?: string];

function streamFromSse(sse: string): { client: ElizaClient } {
  const encoder = new TextEncoder();
  const read = vi
    .fn()
    .mockResolvedValueOnce({ done: false, value: encoder.encode(sse) })
    .mockRejectedValueOnce(new Error("read after terminal event"));
  const cancel = vi.fn(async () => {});
  const request = vi.fn(
    async () =>
      ({
        ok: true,
        status: 200,
        body: { getReader: () => ({ read, cancel }) },
      }) as unknown as Response,
  );
  const client = new ElizaClient("http://agent.example:31337", "token");
  client.setRequestTransport({ request });
  return { client };
}

describe("legacy named SSE chat events", () => {
  it("completes on an untyped named done frame without duplicating its text (shared-runtime replay)", async () => {
    const { client } = streamFromSse(
      'event: chunk\ndata: {"text":"Hello","fullText":"Hello"}\n\n' +
        'event: done\ndata: {"messageId":"m1","text":"Hello"}\n\n',
    );
    const calls: OnTokenCall[] = [];
    const onToken = vi.fn((token: string, accumulated?: string) => {
      calls.push([token, accumulated]);
    });

    const result = await client.streamChatEndpoint(
      "/api/conversations/c/messages/stream",
      "hi",
      onToken,
    );

    expect(calls).toEqual([["Hello", "Hello"]]);
    expect(result.text).toBe("Hello");
    expect(result.completed).toBe(true);
    expect(result.messageId).toBe("m1");
  });

  it("preserves actionResults and authoritative text from an untyped named done frame", async () => {
    const { client } = streamFromSse(
      'event: chunk\ndata: {"text":"Opening","fullText":"Opening"}\n\n' +
        'event: done\ndata: {"messageId":"m2","text":"Opening the notes view","actionResults":[{"actionName":"VIEWS","success":true}]}\n\n',
    );

    const result = await client.streamChatEndpoint(
      "/api/conversations/c/messages/stream",
      "open notes",
      vi.fn(),
    );

    expect(result.completed).toBe(true);
    expect(result.text).toBe("Opening the notes view");
    expect(result.actionResults).toEqual([
      { actionName: "VIEWS", success: true },
    ]);
  });

  it("lets an explicit JSON type win over a conflicting SSE event name", async () => {
    const { client } = streamFromSse(
      'event: done\ndata: {"type":"token","text":"partial","fullText":"partial"}\n\n' +
        'data: {"type":"done","fullText":"partial done","agentName":"Eliza"}\n\n',
    );
    const calls: OnTokenCall[] = [];
    const onToken = vi.fn((token: string, accumulated?: string) => {
      calls.push([token, accumulated]);
    });

    const result = await client.streamChatEndpoint(
      "/api/conversations/c/messages/stream",
      "hi",
      onToken,
    );

    // The mislabeled frame streams as a token; only the typed done terminates.
    expect(calls).toEqual([["partial", "partial"]]);
    expect(result.text).toBe("partial done");
    expect(result.completed).toBe(true);
  });

  it("surfaces an untyped named error frame as StreamGenerationError instead of ignoring it", async () => {
    const { client } = streamFromSse(
      'event: error\ndata: {"message":"Sandbox is not running or unreachable"}\n\n',
    );

    let thrown: unknown;
    try {
      await client.streamChatEndpoint(
        "/api/conversations/c/messages/stream",
        "hi",
        vi.fn(),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StreamGenerationError);
    expect((thrown as StreamGenerationError).message).toBe(
      "Sandbox is not running or unreachable",
    );
  });

  it("still classifies an untyped, unnamed frame carrying text as a token", async () => {
    const { client } = streamFromSse(
      'data: {"text":"Fallback reply"}\n\n' +
        'event: done\ndata: {"text":"Fallback reply"}\n\n',
    );
    const calls: OnTokenCall[] = [];
    const onToken = vi.fn((token: string, accumulated?: string) => {
      calls.push([token, accumulated]);
    });

    const result = await client.streamChatEndpoint(
      "/api/conversations/c/messages/stream",
      "hi",
      onToken,
    );

    expect(calls).toEqual([["Fallback reply", "Fallback reply"]]);
    expect(result.text).toBe("Fallback reply");
    expect(result.completed).toBe(true);
  });
});
