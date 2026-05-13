import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { OpenAIChatRequest } from "@/lib/providers/types";
import { VastProvider } from "@/lib/providers/vast";
import {
  resolveVastEndpointConfig,
  resolveVastFallbackModel,
  vastModelEnvSuffix,
} from "@/lib/providers/vast-endpoints";

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

  test("can send the endpoint served model id instead of the catalog id", async () => {
    const fetchMock = mock(
      async () =>
        new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const provider = new VastProvider(
      "test-key",
      "https://openai.vast.ai/eliza-cloud-eliza-1-27b",
      {
        apiModelId: "eliza-1-27b",
      },
    );
    await provider.chatCompletions(baseChatRequest);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("eliza-1-27b");
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
    expect(body.data.map((m) => m.id)).toContain("vast/eliza-1-27b-256k");
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

describe("Vast endpoint config", () => {
  test("derives stable env suffixes for model-specific endpoints", () => {
    expect(vastModelEnvSuffix("vast/eliza-1-27b")).toBe("ELIZA_1_27B");
    expect(vastModelEnvSuffix("vast/eliza-1-27b-256k")).toBe("ELIZA_1_27B_256K");
  });

  test("resolves a dedicated model endpoint before the global endpoint", () => {
    const env: Record<string, string> = {
      VAST_API_KEY: "global-key",
      VAST_BASE_URL: "https://openai.vast.ai/global",
      VAST_BASE_URL_ELIZA_1_27B: "https://openai.vast.ai/eliza-cloud-eliza-1-27b/",
      VAST_API_MODEL_ELIZA_1_27B: "eliza-1-27b",
    };
    const config = resolveVastEndpointConfig("vast/eliza-1-27b", (name) => env[name] ?? null);
    expect(config).toEqual({
      model: "vast/eliza-1-27b",
      apiKey: "global-key",
      baseUrl: "https://openai.vast.ai/eliza-cloud-eliza-1-27b",
      apiModelId: "eliza-1-27b",
      source: "model-env",
    });
  });

  test("enables default Vast fallback only when the smaller endpoint is dedicated", () => {
    const env: Record<string, string> = {
      VAST_API_KEY: "global-key",
      VAST_BASE_URL_ELIZA_1_27B: "https://openai.vast.ai/eliza-cloud-eliza-1-27b",
      VAST_BASE_URL_ELIZA_1_9B: "https://openai.vast.ai/eliza-cloud-eliza-1-9b",
    };
    expect(resolveVastFallbackModel("vast/eliza-1-27b", (name) => env[name] ?? null)).toBe(
      "vast/eliza-1-9b",
    );
  });

  test("falls back from the 256K 27B lane to the standard 27B lane", () => {
    const env: Record<string, string> = {
      VAST_API_KEY: "global-key",
      VAST_BASE_URL_ELIZA_1_27B_256K: "https://openai.vast.ai/eliza-cloud-eliza-1-27b-256k",
      VAST_BASE_URL_ELIZA_1_27B: "https://openai.vast.ai/eliza-cloud-eliza-1-27b",
    };
    expect(resolveVastFallbackModel("vast/eliza-1-27b-256k", (name) => env[name] ?? null)).toBe(
      "vast/eliza-1-27b",
    );
  });
});
