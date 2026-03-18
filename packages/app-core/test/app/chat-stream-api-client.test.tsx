import { ApiError, ElizaClient } from "@elizaos/app-core/api";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

function buildSseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function buildControlledSseResponse(initialChunk: string): {
  response: Response;
  push: (chunk: string) => void;
  close: () => void;
} {
  const encoder = new TextEncoder();
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      controller.enqueue(encoder.encode(initialChunk));
    },
  });

  return {
    response: new Response(body, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
    push: (chunk: string) => {
      if (!streamController) throw new Error("SSE stream controller missing");
      streamController.enqueue(encoder.encode(chunk));
    },
    close: () => {
      streamController?.close();
    },
  };
}

function buildJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ElizaClient streaming chat endpoints", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("streams conversation tokens and returns done payload", async () => {
    fetchMock.mockResolvedValue(
      buildSseResponse([
        'data: {"type":"token","text":"Hello "}\n\n',
        'data: {"type":"token","text":"world"}\n\n',
        'data: {"type":"done","fullText":"Hello world","agentName":"Eliza"}\n\n',
      ]),
    );

    const client = new ElizaClient("http://localhost:2138", "token");
    const tokens: string[] = [];
    const fullTexts: string[] = [];
    const result = await client.sendConversationMessageStream(
      "conv-1",
      "hi",
      (token, accumulatedText) => {
        tokens.push(token);
        fullTexts.push(accumulatedText ?? "");
      },
      "DM",
      undefined,
      undefined,
      "power",
    );

    expect(tokens).toEqual(["Hello ", "world"]);
    expect(fullTexts).toEqual(["Hello ", "Hello world"]);
    expect(result).toEqual({
      text: "Hello world",
      agentName: "Eliza",
      completed: true,
    });

    const firstCall = fetchMock.mock.calls[0];
    const requestUrl = String(firstCall[0]);
    const requestInit = firstCall[1] as RequestInit;
    const requestHeaders = requestInit.headers as Record<string, string>;

    expect(requestUrl).toBe(
      "http://localhost:2138/api/conversations/conv-1/messages/stream",
    );
    expect(requestInit.method).toBe("POST");
    expect(requestHeaders.Accept).toBe("text/event-stream");
    expect(requestHeaders.Authorization).toBe("Bearer token");
    expect(requestInit.body).toBe(
      JSON.stringify({
        text: "hi",
        channelType: "DM",
        conversationMode: "power",
      }),
    );
  });

  test("supports legacy SSE payloads containing only text", async () => {
    fetchMock.mockResolvedValue(
      buildSseResponse(['data: {"text":"A"}\n\n', 'data: {"text":"B"}\n\n']),
    );

    const client = new ElizaClient("http://localhost:2138");
    const tokens: string[] = [];
    const fullTexts: string[] = [];
    const result = await client.sendChatStream(
      "legacy",
      (token, accumulatedText) => {
        tokens.push(token);
        fullTexts.push(accumulatedText ?? "");
      },
      "DM",
      undefined,
      "simple",
    );

    expect(tokens).toEqual(["A", "B"]);
    expect(fullTexts).toEqual(["A", "AB"]);
    expect(result).toEqual({
      text: "AB",
      agentName: "Eliza",
      completed: false,
    });
  });

  test("keeps the latest full snapshot when the stream ends without done", async () => {
    fetchMock.mockResolvedValue(
      buildSseResponse([
        'data: {"type":"token","text":"world"}\n\n',
        'data: {"type":"token","text":"Hello world"}\n\n',
      ]),
    );

    const client = new ElizaClient("http://localhost:2138");
    const tokens: string[] = [];
    const result = await client.sendChatStream("legacy", (token) => {
      tokens.push(token);
    });

    expect(tokens).toEqual(["world", "Hello world"]);
    expect(result).toEqual({
      text: "Hello world",
      agentName: "Eliza",
      completed: false,
    });
  });

  test("provides accumulated text to the callback for corrected snapshots", async () => {
    fetchMock.mockResolvedValue(
      buildSseResponse([
        'data: {"type":"token","text":"world"}\n\n',
        'data: {"type":"token","text":"Hello world"}\n\n',
      ]),
    );

    const client = new ElizaClient("http://localhost:2138");
    const fullTexts: string[] = [];
    const result = await client.sendChatStream(
      "legacy",
      (_token, accumulatedText) => {
        fullTexts.push(accumulatedText ?? "");
      },
    );

    expect(fullTexts).toEqual(["world", "Hello world"]);
    expect(result).toEqual({
      text: "Hello world",
      agentName: "Eliza",
      completed: false,
    });
  });

  test("handles corrected full snapshots followed by more streamed suffix text", async () => {
    fetchMock.mockResolvedValue(
      buildSseResponse([
        'data: {"type":"token","text":"Hello wrld"}\n\n',
        'data: {"type":"token","text":"Hello world"}\n\n',
        'data: {"type":"token","text":"!"}\n\n',
      ]),
    );

    const client = new ElizaClient("http://localhost:2138");
    const tokens: string[] = [];
    const result = await client.sendChatStream("legacy", (token) => {
      tokens.push(token);
    });

    expect(tokens).toEqual(["Hello wrld", "Hello world", "!"]);
    expect(result).toEqual({
      text: "Hello world!",
      agentName: "Eliza",
      completed: false,
    });
  });

  test("provides accumulated text to the callback for corrected snapshots followed by suffix text", async () => {
    fetchMock.mockResolvedValue(
      buildSseResponse([
        'data: {"type":"token","text":"Hello wrld"}\n\n',
        'data: {"type":"token","text":"Hello world"}\n\n',
        'data: {"type":"token","text":"!"}\n\n',
      ]),
    );

    const client = new ElizaClient("http://localhost:2138");
    const fullTexts: string[] = [];
    const result = await client.sendChatStream(
      "legacy",
      (_token, accumulatedText) => {
        fullTexts.push(accumulatedText ?? "");
      },
    );

    expect(fullTexts).toEqual(["Hello wrld", "Hello world", "Hello world!"]);
    expect(result).toEqual({
      text: "Hello world!",
      agentName: "Eliza",
      completed: false,
    });
  });

  test("prefers authoritative token fullText over garbled raw token text", async () => {
    fetchMock.mockResolvedValue(
      buildSseResponse([
        'data: {"type":"token","text":"Hey! Yes, I\\u0027m working perfectly!  p\\ud83d\\udc4der Everythingfectly! \\ud83d\\udc4d ","fullText":"Hey! Yes, I\\u0027m working perfectly! \\ud83d\\udc4d Everything\\u0027s up and running smoothly. "}\n\n',
        'data: {"type":"token","text":"What can I help you w Iit canh to assist with","fullText":"Hey! Yes, I\\u0027m working perfectly! \\ud83d\\udc4d Everything\\u0027s up and running smoothly. What can I help you with today? I can assist with"}\n\n',
        'data: {"type":"done","fullText":"Hey! Yes, I\\u0027m working perfectly! \\ud83d\\udc4d Everything\\u0027s up and running smoothly. What can I help you with today? I can assist with coding tasks, run commands, manage GitHub issues, help with streaming, or pretty much anything else you need!","agentName":"Eliza"}\n\n',
      ]),
    );

    const client = new ElizaClient("http://localhost:2138");
    const fullTexts: string[] = [];
    const result = await client.sendChatStream(
      "legacy",
      (_token, accumulatedText) => {
        fullTexts.push(accumulatedText ?? "");
      },
    );

    expect(fullTexts).toEqual([
      "Hey! Yes, I'm working perfectly! \u{1F44D} Everything's up and running smoothly. ",
      "Hey! Yes, I'm working perfectly! \u{1F44D} Everything's up and running smoothly. What can I help you with today? I can assist with",
    ]);
    expect(result).toEqual({
      text: "Hey! Yes, I'm working perfectly! \u{1F44D} Everything's up and running smoothly. What can I help you with today? I can assist with coding tasks, run commands, manage GitHub issues, help with streaming, or pretty much anything else you need!",
      agentName: "Eliza",
      completed: true,
    });
  });

  test("streams CRLF-delimited SSE events before stream completion", async () => {
    const controlled = buildControlledSseResponse(
      'data: {"type":"token","text":"Hello"}\r\n\r\n',
    );
    fetchMock.mockResolvedValue(controlled.response);

    const client = new ElizaClient("http://localhost:2138");
    const tokens: string[] = [];

    const pending = client.sendConversationMessageStream(
      "conv-crlf",
      "hi",
      (token) => {
        tokens.push(token);
      },
    );

    await vi.waitFor(() => {
      expect(tokens).toEqual(["Hello"]);
    });

    controlled.push(
      'data: {"type":"done","fullText":"Hello","agentName":"Eliza"}\r\n\r\n',
    );
    controlled.close();

    await expect(pending).resolves.toEqual({
      text: "Hello",
      agentName: "Eliza",
      completed: true,
    });
  });

  test("strips stage directions from the final streamed assistant text", async () => {
    fetchMock.mockResolvedValue(
      buildSseResponse([
        'data: {"type":"token","text":"*waves warmly* Hello there"}\n\n',
        'data: {"type":"done","fullText":"*waves warmly* Hello there","agentName":"Eliza"}\n\n',
      ]),
    );

    const client = new ElizaClient("http://localhost:2138");
    const tokens: string[] = [];
    const result = await client.sendConversationMessageStream(
      "conv-emote",
      "hi",
      (token) => {
        tokens.push(token);
      },
    );

    expect(tokens).toEqual(["*waves warmly* Hello there"]);
    expect(result).toEqual({
      text: "Hello there",
      agentName: "Eliza",
      completed: true,
    });
  });

  test("throws when SSE emits an error payload", async () => {
    fetchMock.mockResolvedValue(
      buildSseResponse([
        'data: {"type":"error","message":"stream failed"}\n\n',
      ]),
    );

    const client = new ElizaClient("http://localhost:2138");
    await expect(
      client.sendChatStream("boom", () => {}, "DM", undefined, "simple"),
    ).rejects.toThrow("stream failed");
  });

  test("throws typed ApiError when stream endpoint responds with HTTP error", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new ElizaClient("http://localhost:2138");
    const request = client.sendChatStream(
      "boom",
      () => {},
      "DM",
      undefined,
      "simple",
    );
    await expect(request).rejects.toBeInstanceOf(ApiError);
    await expect(request).rejects.toMatchObject({
      kind: "http",
      status: 401,
      path: "/api/chat/stream",
    });
  });

  test("preserves empty greeting text instead of converting it to the generic error", async () => {
    fetchMock.mockResolvedValue(
      buildJsonResponse({
        text: "",
        agentName: "Eliza",
        generated: false,
      }),
    );

    const client = new ElizaClient("http://localhost:2138");
    await expect(client.requestGreeting("conv-empty")).resolves.toEqual({
      text: "",
      agentName: "Eliza",
      generated: false,
    });
  });
});
