/**
 * Client reducer coverage for the negotiated delta-v2 chat wire: bare `text`
 * deltas plain-append (bypassing mergeStreamingText's overlap dedupe, which
 * would drop a legitimately repeated multi-char delta), a `fullText`-only frame
 * is an authoritative replace, a legacy per-token `fullText` still wins, the
 * request advertises `streamProtocol`, and the terminal `done.fullText` is the
 * final text. Deterministic fake reader, no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client";

type OnTokenCall = [token: string, accumulated?: string];

function streamFromSse(sse: string): {
  client: ElizaClient;
  request: ReturnType<typeof vi.fn>;
} {
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
  return { client, request };
}

function parseRequestBody(request: ReturnType<typeof vi.fn>): {
  streamProtocol?: string;
  [key: string]: unknown;
} {
  const init = request.mock.calls[0]?.[1] as { body?: string } | undefined;
  return JSON.parse(init?.body ?? "{}");
}

describe("delta-v2 chat stream client reducer", () => {
  it("appends a repeated multi-char delta instead of dropping it (mergeStreamingText regression)", async () => {
    const { client } = streamFromSse(
      'data: {"type":"token","text":"the "}\n\n' +
        'data: {"type":"token","text":"the "}\n\n' +
        'data: {"type":"done","fullText":"the the ","agentName":"Eliza"}\n\n',
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

    // Both deltas surface; the second "the " is NOT deduped away — the
    // accumulated buffer advances to "the the " (with the repeated word). The
    // final reply text is trailing-trimmed by the client.
    expect(calls).toEqual([
      ["the ", "the "],
      ["the ", "the the "],
    ]);
    expect(result.text).toBe("the the");
    expect(result.completed).toBe(true);
  });

  it("treats a fullText-only frame as an authoritative replace, including a non-append rewrite", async () => {
    const { client } = streamFromSse(
      'data: {"type":"token","text":"Hello wrld"}\n\n' +
        'data: {"type":"token","fullText":"Hello world"}\n\n' +
        'data: {"type":"done","fullText":"Hello world","agentName":"Eliza"}\n\n',
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

    // The rewrite arrives with an empty delta chunk and replaces the buffer —
    // the corrected "world" overwrites the streamed "wrld".
    expect(calls).toEqual([
      ["Hello wrld", "Hello wrld"],
      ["", "Hello world"],
    ]);
    expect(result.text).toBe("Hello world");
  });

  it("keeps legacy per-token fullText authoritative even for a delta-negotiated client", async () => {
    const { client } = streamFromSse(
      'data: {"type":"token","text":"Hel","fullText":"Hel"}\n\n' +
        'data: {"type":"token","text":"lo","fullText":"Hello"}\n\n' +
        'data: {"type":"done","fullText":"Hello","agentName":"Eliza"}\n\n',
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

    // fullText, when present, is used verbatim (no double-append of text).
    expect(calls).toEqual([
      ["Hel", "Hel"],
      ["lo", "Hello"],
    ]);
    expect(result.text).toBe("Hello");
  });

  it("advertises streamProtocol delta-v2 in the request body", async () => {
    const { client, request } = streamFromSse(
      'data: {"type":"done","fullText":"ok","agentName":"Eliza"}\n\n',
    );

    await client.streamChatEndpoint(
      "/api/conversations/c/messages/stream",
      "hi",
      vi.fn(),
    );

    expect(parseRequestBody(request).streamProtocol).toBe("delta-v2");
  });

  it("lets the terminal done.fullText win as the final text over accumulated deltas", async () => {
    const { client } = streamFromSse(
      'data: {"type":"token","text":"par"}\n\n' +
        'data: {"type":"done","fullText":"partial complete","agentName":"Eliza"}\n\n',
    );
    const onToken = vi.fn();

    const result = await client.streamChatEndpoint(
      "/api/conversations/c/messages/stream",
      "hi",
      onToken,
    );

    // Mid-stream the buffer was "par"; the authoritative done text replaces it.
    expect(onToken).toHaveBeenCalledWith("par", "par");
    expect(result.text).toBe("partial complete");
    expect(result.completed).toBe(true);
  });
});
