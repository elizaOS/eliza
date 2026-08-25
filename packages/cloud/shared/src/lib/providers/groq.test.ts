import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GROQ_NATIVE_MODELS } from "../models";
import { GroqProvider } from "./groq";

function abortError(): DOMException {
  return new DOMException("The operation was aborted", "AbortError");
}

describe("GroqProvider", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("constructor", () => {
    it("throws when no API key is supplied", () => {
      // @ts-expect-error - deliberately omitting the required key
      expect(() => new GroqProvider()).toThrow("Groq API key is required");
    });

    it("accepts a non-empty API key", () => {
      expect(() => new GroqProvider("sk-test")).not.toThrow();
    });
  });

  describe("chatCompletions", () => {
    it("forwards the request with resolved model, bearer auth and stripped providerOptions", async () => {
      fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
      const provider = new GroqProvider("sk-test");

      const res = await provider.chatCompletions({
        model: "groq/compound",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
        // @ts-expect-error - provider-specific option must be stripped before the wire
        providerOptions: { groq: { temperature: 0 } },
      });

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("compound-beta");
      expect(body.providerOptions).toBeUndefined();
      expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    });

    it("passes through an unknown model id unchanged", async () => {
      fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
      const provider = new GroqProvider("sk-test");
      await provider.chatCompletions({
        model: "custom/model",
        messages: [{ role: "user", content: "hi" }],
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(init.body as string).model).toBe("custom/model");
    });
  });

  describe("fetchWithTimeout error classification", () => {
    it("throws a structured error with the parsed body message on non-OK JSON responses", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
        }),
      );
      const provider = new GroqProvider("sk-test");
      const err = await provider
        .chatCompletions({ model: "groq/compound", messages: [] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        status: 429,
        error: { message: "rate limited" },
      });
    });

    it("falls back to a generic error when the non-OK body is not JSON", async () => {
      fetchMock.mockResolvedValue(new Response("<html>Bad Gateway</html>", { status: 502 }));
      const provider = new GroqProvider("sk-test");
      const err = await provider
        .chatCompletions({ model: "groq/compound", messages: [] })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        status: 502,
        error: {
          message: "Groq request failed with status 502",
          type: "groq_error",
          code: "groq_request_failed",
        },
      });
    });

    it("classifies an AbortError from the internal timeout as 504 timeout_error", async () => {
      fetchMock.mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(abortError()));
          }),
      );
      const provider = new GroqProvider("sk-test");
      const err = await provider
        .chatCompletions({ model: "groq/compound", messages: [] }, { timeoutMs: 2000 })
        .catch((e: unknown) => e);
      expect(err).toMatchObject({
        status: 504,
        error: { type: "timeout_error", code: "groq_timeout" },
      });
      expect((err as { error: { message: string } }).error.message).toContain("2 seconds");
    });

    it("classifies a caller-initiated abort as 499 request_aborted, not a timeout", async () => {
      fetchMock.mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(abortError()));
          }),
      );
      const provider = new GroqProvider("sk-test");
      const controller = new AbortController();
      const pending = provider.chatCompletions(
        { model: "groq/compound", messages: [] },
        { signal: controller.signal },
      );
      const errPromise = pending.catch((e: unknown) => e);
      controller.abort();
      const err = await errPromise;
      expect(err).toMatchObject({
        status: 499,
        error: { type: "abort_error", code: "request_aborted" },
      });
    });

    it("re-throws non-abort errors unchanged", async () => {
      const boom = new Error("connection reset");
      fetchMock.mockRejectedValue(boom);
      const provider = new GroqProvider("sk-test");
      await expect(provider.chatCompletions({ model: "groq/compound", messages: [] })).rejects.toBe(
        boom,
      );
    });
  });

  describe("capability stubs", () => {
    it("rejects embeddings with a 400 unsupported_operation response", async () => {
      const provider = new GroqProvider("sk-test");
      const res = await provider.embeddings({
        model: "groq/compound",
        input: "text",
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe("unsupported_operation");
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("lists the native Groq models", async () => {
      const provider = new GroqProvider("sk-test");
      const res = await provider.listModels();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual(GROQ_NATIVE_MODELS);
    });

    it("returns 404 for an unknown model id", async () => {
      const provider = new GroqProvider("sk-test");
      const res = await provider.getModel("groq/does-not-exist");
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe("model_not_found");
    });

    it("returns the model entry for a known id", async () => {
      const provider = new GroqProvider("sk-test");
      const res = await provider.getModel("groq/compound-mini");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.id).toBe("groq/compound-mini");
    });
  });
});
