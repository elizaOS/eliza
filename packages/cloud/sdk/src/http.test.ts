/** Unit tests for `ElizaCloudHttpClient` with an injected fake fetch: verb/URL/query/header construction and error mapping. */

import { describe, expect, it } from "vitest";

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
