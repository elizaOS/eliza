import { ElizaClient } from "@elizaos/app-core/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function buildSseDoneResponse(): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          'data: {"type":"done","fullText":"ok","agentName":"Eliza"}\n\n',
        ),
      );
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("ElizaClient language header propagation", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("adds X-Eliza-UI-Language to normal chat requests", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ text: "ok", agentName: "Eliza" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = new ElizaClient("http://localhost:2138", "token");
    client.setUiLanguage("zh-CN");
    await client.sendChatRest("hello");

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("X-Eliza-UI-Language")).toBe("zh-CN");
  });

  it("adds X-Eliza-UI-Language to streaming chat requests", async () => {
    fetchMock.mockResolvedValueOnce(buildSseDoneResponse());

    const client = new ElizaClient("http://localhost:2138");
    client.setUiLanguage("zh-CN");
    await client.sendConversationMessageStream("conv-1", "hello", () => {});

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("X-Eliza-UI-Language")).toBe("zh-CN");
    expect(headers.get("Accept")).toBe("text/event-stream");
  });
});
