/**
 * MCP upstream proxy contract: hop-by-hop and Host headers are stripped,
 * redirects are never followed implicitly, GET/HEAD carry no body, the
 * upstream call is bounded by a sane timeout, and upstream failures surface
 * as a stable 503 JSON error instead of an exception.
 */

import { describe, expect, mock, test } from "bun:test";

interface SeenInit {
  method?: string;
  headers?: Headers;
  body?: unknown;
  redirect?: RequestRedirect;
  signal?: AbortSignal;
}

const seen: { url: string; init: SeenInit }[] = [];

mock.module("../security/safe-fetch", () => ({
  safeFetch: (url: string, init: SeenInit) => {
    seen.push({ url, init });
    if (url === "https://upstream.invalid/unavailable") {
      return Promise.reject(new Error("upstream refused connection"));
    }
    return Promise.resolve(new Response("ok", { status: 200 }));
  },
}));

const { forwardMcpUpstreamRequest } = await import("./mcp-upstream-forward");

describe("forwardMcpUpstreamRequest", () => {
  test("strips Host and hop-by-hop headers while keeping ordinary headers", async () => {
    seen.length = 0;
    const request = new Request("https://orig.example.com/mcp", {
      method: "POST",
      headers: {
        host: "orig.example.com",
        connection: "keep-alive",
        "transfer-encoding": "chunked",
        "content-type": "application/json",
        "x-custom": "keep-me",
      },
      body: JSON.stringify({ jsonrpc: "2.0" }),
    });

    const response = await forwardMcpUpstreamRequest(request, "https://upstream.example.com/mcp");

    expect(response.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://upstream.example.com/mcp");
    expect(seen[0].init.method).toBe("POST");
    expect(seen[0].init.redirect).toBe("manual");
    const headerNames = [...(seen[0].init.headers ?? new Headers())].map(([name]) =>
      name.toLowerCase(),
    );
    expect(headerNames).not.toContain("host");
    expect(headerNames).not.toContain("connection");
    expect(headerNames).not.toContain("transfer-encoding");
    expect(headerNames).toContain("content-type");
    expect(headerNames).toContain("x-custom");
  });

  test("passes the request body through for non-GET/HEAD methods", async () => {
    seen.length = 0;
    const request = new Request("https://orig.example.com/mcp", {
      method: "POST",
      body: "stream-payload",
    });

    await forwardMcpUpstreamRequest(request, "https://upstream.example.com/mcp");

    expect(seen[0].init.body).toBeDefined();
    const forwarded = await new Response(seen[0].init.body as BodyInit).text();
    expect(forwarded).toBe("stream-payload");
  });

  test("sends no body for GET requests", async () => {
    seen.length = 0;
    const request = new Request("https://orig.example.com/mcp", {
      method: "GET",
    });

    await forwardMcpUpstreamRequest(request, "https://upstream.example.com/mcp");

    expect(seen[0].init.body).toBeUndefined();
  });

  test("bounds the upstream call with an abort signal by default", async () => {
    seen.length = 0;
    const request = new Request("https://orig.example.com/mcp", {
      method: "GET",
    });

    await forwardMcpUpstreamRequest(request, "https://upstream.example.com/mcp");

    expect(seen[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  test("accepts an explicit positive integer timeout", async () => {
    seen.length = 0;
    const request = new Request("https://orig.example.com/mcp", {
      method: "GET",
    });

    await forwardMcpUpstreamRequest(request, "https://upstream.example.com/mcp", {
      timeoutMs: 1_234,
    });

    expect(seen[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  test("returns the upstream response unchanged on success", async () => {
    seen.length = 0;
    const request = new Request("https://orig.example.com/mcp", {
      method: "GET",
    });

    const response = await forwardMcpUpstreamRequest(request, "https://upstream.example.com/ok");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  test("converts upstream failures into a stable 503 JSON error", async () => {
    seen.length = 0;
    const request = new Request("https://orig.example.com/mcp", {
      method: "GET",
    });

    const response = await forwardMcpUpstreamRequest(
      request,
      "https://upstream.invalid/unavailable",
    );

    expect(response.status).toBe(503);
    const body = (await response.json()) as {
      success: boolean;
      error: string;
      message: string;
    };
    expect(body.success).toBe(false);
    expect(body.error).toBe("mcp_upstream_unavailable");
    expect(body.message).toBe("upstream refused connection");
  });
});
