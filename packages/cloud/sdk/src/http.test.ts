/**
 * Unit tests for the SDK HTTP boundary with injected transports, including
 * request construction, error mapping, abort provenance, and bounded reads.
 */

import { describe, expect, it, vi } from "vitest";

import { type CloudApiError, ElizaCloudHttpClient } from "./http.js";

function asFetch(
  implementation: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>,
): typeof fetch {
  return implementation as unknown as typeof fetch;
}

function okFetch(
  calls: Array<{ url: string; init: RequestInit }>,
): typeof fetch {
  return asFetch(async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return Response.json({ success: true });
  });
}

describe("ElizaCloudHttpClient auth headers", () => {
  it("normalizes 100k trailing base-url slashes", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new ElizaCloudHttpClient({
      baseUrl: `https://cloud.test/root${"/".repeat(100_000)}`,
      fetchImpl: okFetch(calls),
    });

    await client.requestRaw("GET", "/api/test");

    expect(calls[0]?.url).toBe("https://cloud.test/root/api/test");
  });

  it("serializes hostile query values without dropping falsey values or inventing path segments", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test/root/",
      fetchImpl: okFetch(calls),
    });

    await client.requestRaw("GET", "/api/search?existing=one", {
      query: {
        q: "space value",
        tag: ["a/b", "c&d"],
        zero: 0,
        disabled: false,
        empty: "",
        none: null,
        nope: undefined,
      },
    });

    expect(calls[0]?.url).toBe(
      "https://cloud.test/root/api/search?existing=one&q=space+value&tag=a%2Fb&tag=c%26d&zero=0&disabled=false&empty=",
    );
  });

  it("appends URLSearchParams repeatedly without mutating the caller-owned params", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const params = new URLSearchParams([
      ["tag", "alpha"],
      ["tag", "beta/gamma"],
    ]);
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: okFetch(calls),
    });

    await client.requestRaw("GET", "/api/search", { query: params });

    expect(calls[0]?.url).toBe(
      "https://cloud.test/api/search?tag=alpha&tag=beta%2Fgamma",
    );
    expect([...params.entries()]).toEqual([
      ["tag", "alpha"],
      ["tag", "beta/gamma"],
    ]);
  });

  it("sends API keys as bearer authorization and x-api-key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      apiKey: "eliza_key",
      fetchImpl: okFetch(calls),
    });

    await client.requestRaw("GET", "/api/test");

    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer eliza_key");
    expect(headers.get("x-api-key")).toBe("eliza_key");
  });

  it("uses bearer token for Authorization while retaining x-api-key", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      apiKey: "eliza_key",
      bearerToken: "session_token",
      fetchImpl: okFetch(calls),
    });

    await client.requestRaw("GET", "/api/test");

    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer session_token");
    expect(headers.get("x-api-key")).toBe("eliza_key");
  });

  it("removes auth headers on skipAuth, including caller/default auth headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      apiKey: "eliza_key",
      defaultHeaders: {
        Authorization: "Bearer default",
        "X-API-Key": "default",
      },
      fetchImpl: okFetch(calls),
    });

    await client.requestRaw("GET", "/api/public", {
      skipAuth: true,
      headers: { Authorization: "Bearer caller", "X-API-Key": "caller" },
    });

    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("x-api-key")).toBeNull();
  });

  it("merges default and per-request headers before applying auth", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      apiKey: "eliza_key",
      defaultHeaders: { "X-Default": "one", Authorization: "Bearer default" },
      fetchImpl: okFetch(calls),
    });

    await client.requestRaw("GET", "/api/test", {
      headers: { "X-Request": "two", Authorization: "Bearer caller" },
    });

    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get("x-default")).toBe("one");
    expect(headers.get("x-request")).toBe("two");
    expect(headers.get("authorization")).toBe("Bearer eliza_key");
  });
});

describe("ElizaCloudHttpClient errors", () => {
  it("preserves structured API error code, type, details, and original body", async () => {
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(async () =>
        Response.json(
          {
            success: false,
            error: {
              message: "bad request",
              code: "invalid_request_error",
              type: "validation",
            },
            details: { field: "model" },
          },
          { status: 400, statusText: "Bad Request" },
        ),
      ),
    });

    await expect(client.request("GET", "/api/test")).rejects.toMatchObject({
      name: "CloudApiError",
      statusCode: 400,
      errorBody: {
        success: false,
        error: "bad request",
        code: "invalid_request_error",
        type: "validation",
        details: { field: "model" },
      },
    } satisfies Partial<CloudApiError>);
  });

  it("throws InsufficientCreditsError with billing fields intact", async () => {
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(async () =>
        Response.json(
          {
            success: false,
            error: "Insufficient credits",
            code: "insufficient_credits",
            requiredCredits: 12,
            quota: { current: 1, max: 20 },
          },
          { status: 402 },
        ),
      ),
    });

    await expect(client.request("POST", "/api/paid")).rejects.toMatchObject({
      name: "InsufficientCreditsError",
      statusCode: 402,
      requiredCredits: 12,
      errorBody: {
        code: "insufficient_credits",
        requiredCredits: 12,
        quota: { current: 1, max: 20 },
      },
    });
  });

  it("falls back safely when JSON content is malformed", async () => {
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(
        async () =>
          new Response("{not-json", {
            status: 500,
            statusText: "Internal Server Error",
            headers: { "content-type": "application/json" },
          }),
      ),
    });

    await expect(client.request("GET", "/api/test")).rejects.toMatchObject({
      statusCode: 500,
      errorBody: {
        success: false,
        error: "HTTP 500: {not-json",
      },
    });
  });

  it("throws instead of fabricating success on a 2xx with malformed JSON", async () => {
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(
        async () =>
          new Response("{not-json", {
            status: 200,
            statusText: "OK",
            headers: { "content-type": "application/json" },
          }),
      ),
    });

    await expect(client.request("GET", "/api/test")).rejects.toMatchObject({
      name: "CloudApiError",
      statusCode: 200,
      errorBody: {
        success: false,
        error: "HTTP 200: malformed JSON response body: {not-json",
      },
    });
  });

  it("does not confuse valid JSON fields with the internal malformed-json marker", async () => {
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(async () =>
        Response.json({
          success: true,
          kind: "malformed-json",
          text: "this is valid application JSON",
        }),
      ),
    });

    await expect(client.request("GET", "/api/test")).resolves.toEqual({
      success: true,
      kind: "malformed-json",
      text: "this is valid application JSON",
    });
  });

  it("keeps not-found, auth, and server failures as distinct statuses", async () => {
    const respondWith = (status: number, statusText: string) =>
      new ElizaCloudHttpClient({
        baseUrl: "https://cloud.test",
        fetchImpl: asFetch(async () =>
          Response.json(
            { success: false, error: statusText },
            { status, statusText },
          ),
        ),
      });

    await expect(
      respondWith(404, "Not Found").request("GET", "/api/x"),
    ).rejects.toMatchObject({ name: "CloudApiError", statusCode: 404 });
    await expect(
      respondWith(401, "Unauthorized").request("GET", "/api/x"),
    ).rejects.toMatchObject({ name: "CloudApiError", statusCode: 401 });
    await expect(
      respondWith(500, "Internal Server Error").request("GET", "/api/x"),
    ).rejects.toMatchObject({ name: "CloudApiError", statusCode: 500 });
  });

  it("accepts a 2xx text/plain body as a success without JSON parsing", async () => {
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(
        async () =>
          new Response("pong", {
            status: 200,
            headers: { "content-type": "text/plain" },
          }),
      ),
    });

    await expect(client.request("GET", "/api/ping")).resolves.toEqual({
      success: true,
    });
  });
});

describe("ElizaCloudHttpClient abort and deadline composition", () => {
  function capturingFetch(calls: Array<{ init: RequestInit }>): typeof fetch {
    return asFetch(async (_input, init = {}) => {
      calls.push({ init });
      return Response.json({ success: true });
    });
  }

  function pendingFetch(calls: Array<{ init: RequestInit }>): typeof fetch {
    return asFetch(
      (_input, init = {}) =>
        new Promise<Response>((_resolve, reject) => {
          calls.push({ init });
          const signal = init.signal;
          if (!signal) return;
          const rejectFromAbort = (): void => reject(signal.reason);
          signal.addEventListener("abort", rejectFromAbort, { once: true });
          if (signal.aborted) rejectFromAbort();
        }),
    );
  }

  it("aborts an in-flight request at the deadline while leaving the caller signal untouched", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: pendingFetch(calls),
    });
    const controller = new AbortController();

    await expect(
      client.requestRaw("GET", "/api/slow", {
        timeoutMs: 5,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "TimeoutError" });

    const passedSignal = calls[0]?.init.signal;
    expect(passedSignal).toBeDefined();
    expect(passedSignal).not.toBe(controller.signal);
    expect((passedSignal as AbortSignal).aborted).toBe(true);
    expect(controller.signal.aborted).toBe(false);
  });

  it("rejects at the deadline even when the injected fetch ignores its signal", async () => {
    const fetchImpl = vi.fn(
      asFetch(() => new Promise<Response>(() => undefined)),
    );
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.requestRaw("GET", "/api/ignores-abort", { timeoutMs: 5 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves the caller's abort reason when it fires first", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: pendingFetch(calls),
    });
    const controller = new AbortController();
    const callerReason = new Error("caller stopped the request");

    const request = client.requestRaw("GET", "/api/slow", {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    controller.abort(callerReason);

    await expect(request).rejects.toBe(callerReason);
    expect((calls[0].init.signal as AbortSignal).reason).toBe(callerReason);
  });

  it("passes a bare caller signal through unchanged", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: capturingFetch(calls),
    });
    const controller = new AbortController();

    await client.requestRaw("GET", "/api/x", { signal: controller.signal });

    expect(calls[0]?.init.signal).toBe(controller.signal);
  });

  it("rejects a pre-aborted caller without invoking fetch", async () => {
    const fetchImpl = vi.fn(capturingFetch([]));
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const controller = new AbortController();
    const callerReason = new Error("already stopped");
    controller.abort(callerReason);

    await expect(
      client.requestRaw("GET", "/api/x", {
        timeoutMs: 60_000,
        signal: controller.signal,
      }),
    ).rejects.toBe(callerReason);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("clears the deadline after a successful raw response", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: capturingFetch(calls),
    });

    const response = await client.requestRaw("GET", "/api/x", {
      timeoutMs: 25,
    });
    const passedSignal = calls[0]?.init.signal as AbortSignal;
    await response.arrayBuffer();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(passedSignal).toBeInstanceOf(AbortSignal);
    expect(passedSignal.aborted).toBe(false);
  });

  it("keeps a caller signal connected to a raw response after headers arrive", async () => {
    const controller = new AbortController();
    const callerReason = new Error("stop streaming");
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(async (_input, init = {}) => {
        const signal = init.signal as AbortSignal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              signal.addEventListener(
                "abort",
                () => streamController.error(signal.reason),
                { once: true },
              );
            },
          }),
        );
      }),
    });

    const response = await client.requestRaw("GET", "/api/stream", {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    controller.abort(callerReason);

    await expect(response.text()).rejects.toBe(callerReason);
  });

  it("owns the deadline until a raw response body finishes", async () => {
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start() {},
              cancel: () => new Promise<void>(() => undefined),
            }),
          ),
      ),
    });

    const response = await client.requestRaw("GET", "/api/slow-stream", {
      timeoutMs: 5,
    });

    await expect(response.text()).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("discards a prefetched raw chunk when the deadline expires before reading", async () => {
    let cancelCalls = 0;
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([7]));
              },
              cancel() {
                cancelCalls += 1;
              },
            }),
          ),
      ),
    });

    const response = await client.requestRaw("GET", "/api/prefetched", {
      timeoutMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(response.body?.getReader().read()).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(cancelCalls).toBe(1);
  });

  it("preserves raw response metadata through recursive clones", async () => {
    const upstream = new Response("stream body");
    Object.defineProperties(upstream, {
      redirected: { configurable: true, value: true },
      type: { configurable: true, value: "cors" },
      url: { configurable: true, value: "https://cloud.test/api/raw" },
    });
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(async () => upstream),
    });

    const response = await client.requestRaw("GET", "/api/raw", {
      timeoutMs: 60_000,
    });
    const clone = response.clone();
    const nestedClone = clone.clone();

    for (const candidate of [response, clone, nestedClone]) {
      expect(candidate.url).toBe("https://cloud.test/api/raw");
      expect(candidate.redirected).toBe(true);
      expect(candidate.type).toBe("cors");
    }
    await expect(response.text()).resolves.toBe("stream body");
    await expect(clone.text()).resolves.toBe("stream body");
    await expect(nestedClone.text()).resolves.toBe("stream body");
  });

  it("preserves BYOB reads for an owned raw byte stream", async () => {
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              type: "bytes",
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
                controller.close();
              },
            }),
          ),
      ),
    });

    const response = await client.requestRaw("GET", "/api/bytes", {
      timeoutMs: 60_000,
    });
    const reader = response.body?.getReader({ mode: "byob" });
    const result = await reader?.read(new Uint8Array(4));

    expect(result?.done).toBe(false);
    expect(Array.from(result?.value ?? [])).toEqual([1, 2, 3]);
  });

  it("returns the original raw response when no abort owner is requested", async () => {
    const upstream = new Response("unchanged");
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(async () => upstream),
    });

    const response = await client.requestRaw("GET", "/api/raw");

    expect(response).toBe(upstream);
  });

  it("clears a raw deadline without awaiting hostile body cancellation", async () => {
    const calls: Array<{ init: RequestInit }> = [];
    let cancelCalls = 0;
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(async (_input, init = {}) => {
        calls.push({ init });
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelCalls += 1;
              return new Promise<void>(() => undefined);
            },
          }),
        );
      }),
    });

    const response = await client.requestRaw("GET", "/api/cancel-stream", {
      timeoutMs: 25,
    });
    await response.body?.cancel("caller finished");
    const passedSignal = calls[0]?.init.signal as AbortSignal;
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(cancelCalls).toBe(1);
    expect(passedSignal.aborted).toBe(false);
  });

  it("keeps the deadline active while request() reads the response body", async () => {
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start() {},
              cancel: () => new Promise<void>(() => undefined),
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    });

    await expect(
      client.request("GET", "/api/slow-body", { timeoutMs: 5 }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("rejects an oversized declared response without reading partial content", async () => {
    let cancelCalls = 0;
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelCalls += 1;
                return new Promise<void>(() => undefined);
              },
            }),
            {
              headers: {
                "content-length": String(8 * 1024 * 1024 + 1),
                "content-type": "application/json",
              },
            },
          ),
      ),
    });

    await expect(client.request("GET", "/api/oversized")).rejects.toMatchObject(
      {
        name: "CloudApiError",
        errorBody: { code: "response_body_too_large" },
      },
    );
    expect(cancelCalls).toBe(1);
  });

  it("rejects a chunked response that crosses the byte bound", async () => {
    const oversizedChunk = new Uint8Array(8 * 1024 * 1024 + 1);
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(oversizedChunk);
                controller.close();
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    });

    await expect(
      client.request("GET", "/api/chunked-oversized"),
    ).rejects.toMatchObject({
      name: "CloudApiError",
      errorBody: { code: "response_body_too_large" },
    });
  });

  it("bounds zero-byte chunk fragmentation without truncating a response", async () => {
    let emittedChunks = 0;
    const client = new ElizaCloudHttpClient({
      baseUrl: "https://cloud.test",
      fetchImpl: asFetch(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                emittedChunks += 1;
                controller.enqueue(new Uint8Array());
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      ),
    });

    await expect(
      client.request("GET", "/api/fragmented"),
    ).rejects.toMatchObject({
      name: "CloudApiError",
      errorBody: { code: "response_body_too_large" },
    });
    expect(emittedChunks).toBeGreaterThan(8_192);
    expect(emittedChunks).toBeLessThanOrEqual(8_194);
  });
});
