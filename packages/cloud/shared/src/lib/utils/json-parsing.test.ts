/**
 * Response JSON parsing tests for cloud service clients.
 *
 * Provider success payloads must fail closed when malformed, while provider
 * error payloads can degrade to "no parsed detail" because HTTP status remains
 * the failure signal.
 */

import { describe, expect, test } from "bun:test";
import { decodeRequestJson, parseJsonErrorBody, parseJsonResponse } from "./json-parsing";

describe("decodeRequestJson", () => {
  test("returns an explicit invalid result for malformed JSON syntax", async () => {
    const syntaxError = new SyntaxError("Unexpected end of JSON input");
    await expect(
      decodeRequestJson({
        json: async () => {
          throw syntaxError;
        },
      }),
    ).resolves.toEqual({ ok: false, error: syntaxError });
  });

  test("rethrows non-syntax decoder failures for the route 5xx boundary", async () => {
    const streamError = new TypeError("request stream unavailable");
    await expect(
      decodeRequestJson({
        json: async () => {
          throw streamError;
        },
      }),
    ).rejects.toBe(streamError);
  });

  test("returns canonical decoded values unchanged", async () => {
    const value = { query: "elizaOS" };
    await expect(decodeRequestJson({ json: async () => value })).resolves.toEqual({
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
