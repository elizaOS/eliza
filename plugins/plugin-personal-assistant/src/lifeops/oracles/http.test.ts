/**
 * Unit tests for `requestBoundedJson` in the HTTP oracle boundary:
 * validates bounded streaming reads, Content-Length checks, chunk bomb
 * cancellation, content-type filtering, and UTF-8 / JSON validation.
 */

import { ElizaError } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { requestBoundedJson } from "./http.js";

describe("requestBoundedJson", () => {
  const validUrl = new URL("https://oracle.example.com/api/v1/data");
  const safeResource = "test-oracle";

  it("rejects invalid configuration parameters", async () => {
    await expect(
      requestBoundedJson({
        url: validUrl,
        safeResource,
        timeoutMs: -1,
      }),
    ).rejects.toThrow("HTTP timeout must be a positive integer.");

    await expect(
      requestBoundedJson({
        url: validUrl,
        safeResource,
        maxBodyBytes: 0,
      }),
    ).rejects.toThrow("HTTP body limit must be a positive integer.");
  });

  it("rejects HTTP redirects", async () => {
    const fakeFetch = vi.fn(async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: "https://evil.example.com" },
      });
    });

    await expect(
      requestBoundedJson({
        url: validUrl,
        safeResource,
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow("External source attempted an HTTP redirect.");
  });

  it("rejects non-OK HTTP status", async () => {
    const fakeFetch = vi.fn(async () => {
      return new Response("Not Found", { status: 404 });
    });

    await expect(
      requestBoundedJson({
        url: validUrl,
        safeResource,
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow("External source returned an unsuccessful HTTP status.");
  });

  it("rejects non-JSON content types", async () => {
    const fakeFetch = vi.fn(async () => {
      return new Response("<html>Not JSON</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });

    await expect(
      requestBoundedJson({
        url: validUrl,
        safeResource,
        fetchImpl: fakeFetch,
      }),
    ).rejects.toThrow("External source returned a non-JSON media type.");
  });

  it("rejects oversized responses via Content-Length header", async () => {
    const fakeFetch = vi.fn(async () => {
      return new Response(new Uint8Array(10), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "2000000",
        },
      });
    });

    const error = await requestBoundedJson({
      url: validUrl,
      safeResource,
      maxBodyBytes: 1000,
      fetchImpl: fakeFetch,
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe("ORACLE_HTTP_BODY_LIMIT");
    expect((error as ElizaError).message).toContain(
      "External source response exceeded the configured body limit.",
    );
  });

  it("counts UTF-8 bytes across chunk boundaries and accepts the exact limit", async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({ value: "café" }));
    const split = encoded.indexOf(0xc3) + 1;
    const responseFor = (onCancel?: () => void) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoded.slice(0, split));
            controller.enqueue(encoded.slice(split));
            if (!onCancel) controller.close();
          },
          cancel: onCancel,
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "1",
          },
        },
      );

    const result = await requestBoundedJson({
      url: validUrl,
      safeResource,
      maxBodyBytes: encoded.byteLength,
      fetchImpl: async () => responseFor(),
    });
    expect(result.body).toEqual({ value: "café" });

    let cancelled = false;
    await expect(
      requestBoundedJson({
        url: validUrl,
        safeResource,
        maxBodyBytes: encoded.byteLength - 1,
        fetchImpl: async () =>
          responseFor(() => {
            cancelled = true;
          }),
      }),
    ).rejects.toMatchObject({ code: "ORACLE_HTTP_BODY_LIMIT" });
    expect(cancelled).toBe(true);
  });

  it("aborts chunked stream if received bytes exceed maxBodyBytes without Content-Length", async () => {
    const chunkSize = 512;
    let chunkCount = 0;
    let cancelled = false;

    const stream = new ReadableStream({
      pull(controller) {
        chunkCount++;
        controller.enqueue(new Uint8Array(chunkSize));
        if (chunkCount > 10) {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });

    const fakeFetch = vi.fn(async () => {
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const error = await requestBoundedJson({
      url: validUrl,
      safeResource,
      maxBodyBytes: 1024, // 1KB limit, stream yields 512 * 10
      fetchImpl: fakeFetch,
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe("ORACLE_HTTP_BODY_LIMIT");
    expect(cancelled).toBe(true);
  });

  it("rejects invalid UTF-8 payload", async () => {
    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
    const fakeFetch = vi.fn(async () => {
      return new Response(invalidUtf8, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(invalidUtf8.byteLength),
        },
      });
    });

    const error = await requestBoundedJson({
      url: validUrl,
      safeResource,
      fetchImpl: fakeFetch,
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe("ORACLE_HTTP_INVALID_UTF8");
  });

  it("rejects invalid JSON payload", async () => {
    const fakeFetch = vi.fn(async () => {
      return new Response("{ not valid json }", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const error = await requestBoundedJson({
      url: validUrl,
      safeResource,
      fetchImpl: fakeFetch,
    }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe("ORACLE_HTTP_INVALID_JSON");
  });

  it("translates body-stream failures and redacts sensitive cause text", async () => {
    const secret = "top-secret-api-key";
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error(`socket failed for ${secret}`));
      },
    });

    const error = await requestBoundedJson({
      url: validUrl,
      safeResource,
      sensitiveValues: [secret],
      fetchImpl: async () =>
        new Response(stream, {
          headers: { "Content-Type": "application/json" },
        }),
    }).then(
      () => null,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ElizaError);
    expect((error as ElizaError).code).toBe("ORACLE_HTTP_NETWORK");
    expect((error as ElizaError).cause).toMatchObject({
      message: "socket failed for [REDACTED]",
    });
  });

  it("successfully parses valid JSON response within body limit", async () => {
    const payload = { result: "ok", count: 42 };
    const fakeFetch = vi.fn(async () => {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const result = await requestBoundedJson({
      url: validUrl,
      safeResource,
      fetchImpl: fakeFetch,
    });

    expect(result.status).toBe(200);
    expect(result.body).toEqual(payload);
  });
});
