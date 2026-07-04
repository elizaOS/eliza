/**
 * Tests the signal-cli RPC helpers — base-URL normalization, request framing,
 * and check/version calls — with property-based inputs (fast-check), fake
 * timers, and a stubbed `fetch`. No live daemon.
 */
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeBaseUrl, signalCheck, signalRpcRequest } from "./rpc";

describe("Signal RPC helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("normalizes explicit and shorthand base URLs without trailing slash runs", () => {
    expect(normalizeBaseUrl(" https://signal.local:8080//// ")).toBe("https://signal.local:8080");
    expect(normalizeBaseUrl("127.0.0.1:8080///")).toBe("http://127.0.0.1:8080");
    expect(() => normalizeBaseUrl("    ")).toThrow("Signal base URL is required");

    const hostChar = fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-"
    );
    fc.assert(
      fc.property(
        fc.array(hostChar, { minLength: 1, maxLength: 80 }).map((chars) => chars.join("")),
        fc.integer({ min: 0, max: 256 }),
        (host, slashCount) => {
          expect(normalizeBaseUrl(`${host}${"/".repeat(slashCount)}`)).toBe(`http://${host}`);
        }
      ),
      { numRuns: 150 }
    );
  });

  it("posts a JSON-RPC envelope and returns result payloads", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        jsonrpc: "2.0",
        method: "send",
        params: { account: "+15551234567", message: "hi" },
        id: expect.any(String),
      });
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: { timestamp: 123 } }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      signalRpcRequest(
        "send",
        { account: "+15551234567", message: "hi" },
        { baseUrl: "localhost:8080///" }
      )
    ).resolves.toEqual({ timestamp: 123 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8080/api/v1/rpc",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );
  });

  it("handles empty-success, empty-error, and JSON-RPC error responses", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 201 }))
      .mockResolvedValueOnce(new Response("", { status: 200 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32602, message: "bad params" },
          }),
          { status: 200 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      signalRpcRequest("methodWithoutResult", undefined, { baseUrl: "http://localhost" })
    ).resolves.toBeUndefined();
    await expect(
      signalRpcRequest("empty", undefined, { baseUrl: "http://localhost" })
    ).rejects.toThrow("Signal RPC empty response (status 200)");
    await expect(signalRpcRequest("bad", {}, { baseUrl: "http://localhost" })).rejects.toThrow(
      "Signal RPC -32602: bad params"
    );
  });

  it("reports Signal health failures for non-OK and aborted checks", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(signalCheck("signal.test", 50)).resolves.toEqual({
      ok: false,
      status: 503,
      error: "HTTP 503",
    });

    vi.useFakeTimers();
    fetchMock.mockImplementationOnce((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    });
    const check = signalCheck("signal.test", 25);
    await vi.advanceTimersByTimeAsync(25);

    await expect(check).resolves.toEqual({
      ok: false,
      status: null,
      error: "aborted",
    });
  });
});
