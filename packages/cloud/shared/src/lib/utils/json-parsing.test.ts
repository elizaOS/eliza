/**
 * JSON boundary tests using real Fetch bodies plus deterministic fault sources.
 *
 * Request syntax failures are sanitized, body transport failures propagate,
 * and provider response parsing retains its strict-success/best-effort-error
 * split.
 */

import { describe, expect, test } from "bun:test";
import { decodeRequestJson, parseJsonErrorBody, parseJsonResponse } from "./json-parsing";

describe("decodeRequestJson", () => {
  test("returns a sanitized invalid result for malformed JSON syntax", async () => {
    const secret = "never-echo-this-request-secret";
    const result = await decodeRequestJson(
      new Request("https://example.test", {
        method: "POST",
        body: `{"token":"${secret}`,
      }),
    );

    expect(result).toEqual({ ok: false });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  test("rethrows stream failures for the route 5xx boundary", async () => {
    const streamError = new TypeError("request stream unavailable");
    await expect(
      decodeRequestJson({
        text: async () => {
          throw streamError;
        },
      }),
    ).rejects.toBe(streamError);
  });

  test("does not mistake an internal SyntaxError for invalid caller JSON", async () => {
    const decoderError = new SyntaxError("internal decoder invariant failed");
    await expect(
      decodeRequestJson({
        text: async () => {
          throw decoderError;
        },
      }),
    ).rejects.toBe(decoderError);
  });

  test("preserves abort failures without translating them to invalid JSON", async () => {
    const abortError = new DOMException("request aborted", "AbortError");
    await expect(
      decodeRequestJson({
        text: async () => {
          throw abortError;
        },
      }),
    ).rejects.toBe(abortError);
  });

  test("preserves typed failure identity, code, context, and cause", async () => {
    const cause = new Error("socket closed");
    const decoderError = Object.assign(new Error("body decoder failed", { cause }), {
      code: "REQUEST_BODY_DECODE_FAILED",
      context: { requestId: "req-1" },
    });
    const promise = decodeRequestJson({
      text: async () => {
        throw decoderError;
      },
    });

    await expect(promise).rejects.toBe(decoderError);
    expect(decoderError.cause).toBe(cause);
    expect(decoderError.code).toBe("REQUEST_BODY_DECODE_FAILED");
    expect(decoderError.context).toEqual({ requestId: "req-1" });
  });

  test("rejects a decoder contract violation without exposing its value", async () => {
    const decoded = { token: "never-log-this" };
    await expect(
      decodeRequestJson({
        text: async () => decoded,
      } as unknown as { text(): Promise<string> }),
    ).rejects.toThrow("Request body decoder returned a non-string value");
  });

  test.each(["", "  \n\t"])("treats an empty body as invalid JSON", async (body) => {
    await expect(
      decodeRequestJson(new Request("https://example.test", { method: "POST", body })),
    ).resolves.toEqual({ ok: false });
  });

  test("decodes streamed JSON independently of content type", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"query":'));
        controller.enqueue(encoder.encode('"elizaOS"}'));
        controller.close();
      },
    });
    const request = new Request("https://example.test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await expect(decodeRequestJson(request)).resolves.toEqual({
      ok: true,
      value: { query: "elizaOS" },
    });
  });

  test("propagates a consumed-body failure", async () => {
    const request = new Request("https://example.test", {
      method: "POST",
      body: '{"ok":true}',
    });
    await request.text();

    await expect(decodeRequestJson(request)).rejects.toBeInstanceOf(TypeError);
  });

  test("decodes a large body without truncation or fabricated defaults", async () => {
    const value = "x".repeat(1024 * 1024);
    const request = new Request("https://example.test", {
      method: "POST",
      body: JSON.stringify({ value }),
    });

    const result = await decodeRequestJson(request);
    expect(result).toEqual({ ok: true, value: { value } });
  });

  test("returns canonical decoded values unchanged", async () => {
    const value = { query: "elizaOS" };
    await expect(decodeRequestJson({ text: async () => JSON.stringify(value) })).resolves.toEqual({
      ok: true,
      value,
    });
  });

  test.each([
    ["null", null],
    ['"text"', "text"],
    ["42", 42],
    ["true", true],
  ])("keeps valid primitive JSON distinct from invalid syntax", async (body, value) => {
    await expect(decodeRequestJson({ text: async () => body })).resolves.toEqual({
      ok: true,
      value,
    });
  });
});

describe("parseJsonResponse", () => {
  test("parses non-empty JSON response bodies", async () => {
    const response = new Response('{"access_token":"token"}');

    await expect(parseJsonResponse(response)).resolves.toEqual({
      access_token: "token",
    });
  });

  test("rejects empty success bodies instead of fabricating an object", async () => {
    const response = new Response("  ");

    await expect(parseJsonResponse(response, "oauth token")).rejects.toThrow(
      "Failed to parse JSON (oauth token): empty response body",
    );
  });

  test("rejects malformed JSON with context", async () => {
    const response = new Response("{not json}");

    await expect(parseJsonResponse(response, "provider response")).rejects.toThrow(
      "Failed to parse JSON (provider response):",
    );
  });
});

describe("parseJsonErrorBody", () => {
  test("parses valid provider error payloads", async () => {
    const response = new Response('{"error_description":"expired"}', {
      status: 400,
    });

    await expect(parseJsonErrorBody<{ error_description?: string }>(response)).resolves.toEqual({
      error_description: "expired",
    });
  });

  test("returns an explicit empty detail object for empty provider error bodies", async () => {
    const response = new Response("", { status: 500 });

    await expect(parseJsonErrorBody(response)).resolves.toEqual({});
  });

  test("returns an explicit empty detail object for malformed provider error bodies", async () => {
    const response = new Response("<html>nope</html>", { status: 502 });

    await expect(parseJsonErrorBody(response)).resolves.toEqual({});
  });
});
