import { describe, expect, it, vi } from "vitest";

import { detectMlx, parseModelsResponse } from "../utils/detect";

describe("parseModelsResponse", () => {
  it("parses OpenAI-shaped list responses", () => {
    expect(
      parseModelsResponse({
        object: "list",
        data: [
          { id: "mlx-community/Llama-3.2-3B-Instruct-4bit", object: "model" },
          { id: "mlx-community/Phi-3.5-mini-instruct-4bit" },
        ],
      })
    ).toEqual([
      { id: "mlx-community/Llama-3.2-3B-Instruct-4bit", object: "model" },
      { id: "mlx-community/Phi-3.5-mini-instruct-4bit" },
    ]);
  });

  it("falls back to bare array responses", () => {
    expect(parseModelsResponse([{ id: "loose-form" }])).toEqual([{ id: "loose-form" }]);
  });

  it("filters entries without a string id", () => {
    expect(
      parseModelsResponse({
        object: "list",
        data: [{ id: "ok" }, { object: "model" }, { id: 42 }],
      })
    ).toEqual([{ id: "ok" }]);
  });

  it("returns null for unrecognized shapes", () => {
    expect(parseModelsResponse({})).toBeNull();
    expect(parseModelsResponse(null)).toBeNull();
    expect(parseModelsResponse("not a payload")).toBeNull();
  });
});

describe("detectMlx", () => {
  it("normalizes baseURL by appending /v1 when missing", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ object: "list", data: [{ id: "m1" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    const result = await detectMlx({
      baseURL: "http://localhost:8080",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.available).toBe(true);
    expect(result.baseURL).toBe("http://localhost:8080/v1");
    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:8080/v1/models",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("returns available with parsed models on 200", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            object: "list",
            data: [{ id: "mlx-community/Qwen2.5-7B-Instruct-4bit" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );

    const result = await detectMlx({
      baseURL: "http://localhost:8080/v1",
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(result.available).toBe(true);
    expect(result.models).toEqual([{ id: "mlx-community/Qwen2.5-7B-Instruct-4bit" }]);
  });

  it("surfaces non-2xx responses with HTTP status", async () => {
    const fetcher = vi.fn(
      async () => new Response("internal err", { status: 500, statusText: "Internal Server Error" })
    );

    const result = await detectMlx({
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.available).toBe(false);
    expect(result.error).toBe("HTTP 500 Internal Server Error");
  });

  it("returns available=false when fetch rejects", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const result = await detectMlx({
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.available).toBe(false);
    expect(result.error).toBe("ECONNREFUSED");
  });

  it("rejects body shapes that don't look like a models list", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ surprise: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
    );

    const result = await detectMlx({
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.available).toBe(false);
    expect(result.error).toMatch(/unexpected/i);
  });

  it("attaches the Authorization header when an apiKey is provided", async () => {
    const fetcher = vi.fn(async (_url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sk-test");
      return new Response(JSON.stringify({ object: "list", data: [] }), { status: 200 });
    });

    await detectMlx({
      fetcher: fetcher as unknown as typeof fetch,
      apiKey: "sk-test",
    });
  });
});
