import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { OpenAIChatRequest } from "@/lib/providers/types";
import { VastProvider } from "@/lib/providers/vast";

const baseChatRequest: OpenAIChatRequest = {
  model: "vast/eliza-1-27b",
  messages: [{ role: "user", content: "hi" }],
};

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("VastProvider", () => {
  test("forwards catalog model id verbatim and posts to /v1/chat/completions", async () => {
    const fetchMock = mock(async (_url: string, _init: RequestInit) => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const provider = new VastProvider("test-key", "https://run.vast.ai/route/abc123");
    const res = await provider.chatCompletions(baseChatRequest);
    expect(res.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://run.vast.ai/route/abc123/v1/chat/completions");

    const body = JSON.parse(init.body as string);
    // llama-server's --alias makes the upstream model id match the catalog id,
    // so the provider doesn't translate.
    expect(body.model).toBe("vast/eliza-1-27b");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);

    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get("Authorization")).toBe("Bearer test-key");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  test("normalizes a base URL with a trailing slash", async () => {
    const fetchMock = mock(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const provider = new VastProvider("k", "https://run.vast.ai/route/abc123/");
    await provider.chatCompletions(baseChatRequest);

    const [url] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://run.vast.ai/route/abc123/v1/chat/completions");
  });

  test("constructor rejects an empty API key or base URL", () => {
    expect(() => new VastProvider("", "https://run.vast.ai/route/x")).toThrow(
      "Vast API key is required",
    );
    expect(() => new VastProvider("k", "")).toThrow("Vast base URL is required");
  });

  test("listModels returns the static native catalog", async () => {
    const provider = new VastProvider("k", "https://run.vast.ai/route/x");
    const res = await provider.listModels();
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      object: string;
      data: Array<{ id: string }>;
    };
    expect(body.object).toBe("list");
    expect(body.data.map((m) => m.id)).toContain("vast/eliza-1-27b");
    expect(body.data.map((m) => m.id)).toContain("vast/eliza-1-2b");
    expect(body.data.map((m) => m.id)).toContain("vast/eliza-1-27b");
  });

  test("getModel returns the entry when present, 404 otherwise", async () => {
    const provider = new VastProvider("k", "https://run.vast.ai/route/x");

    const ok = await provider.getModel("vast/eliza-1-27b");
    expect(ok.status).toBe(200);

    const missing = await provider.getModel("vast/does-not-exist");
    expect(missing.status).toBe(404);
  });

  test("embeddings is unsupported (400)", async () => {
    const provider = new VastProvider("k", "https://run.vast.ai/route/x");
    const res = await provider.embeddings({
      input: "hello",
      model: "vast/eliza-1-27b",
    });
    expect(res.status).toBe(400);
  });
});
