import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { AnthropicDirectProvider } from "@/lib/providers/anthropic-direct";
import { OpenAIDirectProvider } from "@/lib/providers/openai-direct";
import type { OpenAIChatRequest } from "@/lib/providers/types";

const baseChatRequest: OpenAIChatRequest = {
  model: "openai/gpt-5.4-mini",
  messages: [{ role: "user", content: "hi" }],
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAIDirectProvider.chatCompletions", () => {
  test("strips openai/ prefix from model id and sets bearer auth", async () => {
    const fetchMock = mock(async (url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      const headers = new Headers(init.headers as HeadersInit);

      // Assertions on request shape happen via the captured args below.
      return new Response(
        JSON.stringify({
          id: "ok",
          url,
          model: body.model,
          headers: [...headers.entries()],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const provider = new OpenAIDirectProvider("test-key");
    const res = await provider.chatCompletions(baseChatRequest);
    expect(res.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("gpt-5.4-mini");
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("Authorization")).toBe("Bearer test-key");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  test("throws structured timeout envelope when upstream times out", async () => {
    const fetchMock = mock(async (_url: string, init: RequestInit) => {
      // Resolve after the abort fires so the surrounding fetch wrapper sees AbortError.
      await new Promise<void>((resolve, reject) => {
        const sig = init.signal;
        if (sig?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        sig?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
      return new Response(null, { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const provider = new OpenAIDirectProvider("test-key");
    let thrown: unknown;
    try {
      await provider.chatCompletions(baseChatRequest, { timeoutMs: 10 });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    const e = thrown as {
      status: number;
      error: { code: string; type: string };
    };
    expect(e.status).toBe(504);
    expect(e.error.type).toBe("timeout_error");
    expect(e.error.code).toBe("openai_timeout");
  });
});

describe("AnthropicDirectProvider.chatCompletions", () => {
  test("strips anthropic/ prefix from model id and sets bearer auth", async () => {
    const fetchMock = mock(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ id: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const provider = new AnthropicDirectProvider("anthropic-key");
    const res = await provider.chatCompletions({
      ...baseChatRequest,
      model: "anthropic/claude-opus-4.7",
    });
    expect(res.status).toBe(200);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/chat/completions");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-opus-4.7");
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("Authorization")).toBe("Bearer anthropic-key");
  });

  test("embeddings/listModels/getModel throw not-supported envelopes", async () => {
    const provider = new AnthropicDirectProvider("k");

    const cases: Array<[string, () => Promise<Response>]> = [
      ["embeddings", () => provider.embeddings({ model: "x", input: "y" })],
      ["listModels", () => provider.listModels()],
      ["getModel", () => provider.getModel("anthropic/claude-opus-4.7")],
    ];

    for (const [_label, op] of cases) {
      let thrown: unknown;
      try {
        await op();
      } catch (err) {
        thrown = err;
      }
      const e = thrown as { status: number; error: { code: string } };
      expect(e.status).toBe(400);
      expect(e.error.code).toBe("anthropic_direct_unsupported");
    }
  });
});
