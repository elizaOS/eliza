import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyReviewerFailure,
  preflightReviewer,
} from "./reviewer-preflight.mjs";

describe("reviewer provider preflight", () => {
  it("classifies rejected, quota, and billing responses", () => {
    assert.equal(
      classifyReviewerFailure(401, "unauthorized"),
      "rejected-credentials",
    );
    assert.equal(classifyReviewerFailure(429, "rate limit"), "quota-exhausted");
    assert.equal(
      classifyReviewerFailure(
        400,
        "Your credit balance is too low to access the Anthropic API",
      ),
      "insufficient-credit",
    );
  });

  it("fails without making a request when credentials are missing", async () => {
    let requests = 0;
    const result = await preflightReviewer({
      apiKey: "",
      fetchImpl: async () => {
        requests += 1;
        return new Response();
      },
    });

    assert.equal(requests, 0);
    assert.deepEqual(result, {
      ok: false,
      classification: "missing-credentials",
      detail: "ANTHROPIC_API_KEY is not configured",
    });
  });

  it("makes exactly one bounded request and reports insufficient credit", async () => {
    let requests = 0;
    const result = await preflightReviewer({
      apiKey: "test-key",
      endpoint: "https://reviewer.invalid/v1/messages",
      fetchImpl: async (_url, init) => {
        requests += 1;
        assert.ok(init.signal);
        return new Response(
          JSON.stringify({ error: { message: "insufficient credit" } }),
          { status: 400 },
        );
      },
    });

    assert.equal(requests, 1);
    assert.equal(result.ok, false);
    assert.equal(result.classification, "insufficient-credit");
  });

  it("classifies a fetch TimeoutError as provider-timeout", async () => {
    let requests = 0;
    const result = await preflightReviewer({
      apiKey: "test-key",
      endpoint: "https://reviewer.invalid/v1/messages",
      fetchImpl: async () => {
        requests += 1;
        throw new DOMException("The operation timed out.", "TimeoutError");
      },
    });

    assert.equal(requests, 1);
    assert.equal(result.ok, false);
    assert.equal(result.classification, "provider-timeout");
  });

  it("classifies a fetch AbortError as provider-timeout", async () => {
    const result = await preflightReviewer({
      apiKey: "test-key",
      endpoint: "https://reviewer.invalid/v1/messages",
      fetchImpl: async () => {
        throw new DOMException("This operation was aborted", "AbortError");
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.classification, "provider-timeout");
  });

  it("classifies connection refusal as provider-unreachable", async () => {
    // Node's fetch surfaces network failures as a TypeError whose cause
    // carries the socket error (e.g. ECONNREFUSED). Reproduce that shape.
    let requests = 0;
    const result = await preflightReviewer({
      apiKey: "test-key",
      endpoint: "https://reviewer.invalid/v1/messages",
      fetchImpl: async () => {
        requests += 1;
        const cause = Object.assign(new Error("connect ECONNREFUSED"), {
          code: "ECONNREFUSED",
        });
        throw new TypeError("fetch failed", { cause });
      },
    });

    assert.equal(requests, 1);
    assert.equal(result.ok, false);
    assert.equal(result.classification, "provider-unreachable");
    assert.equal(result.detail, "fetch failed");
  });

  it("classifies an HTTP 401 as rejected-credentials with one request", async () => {
    let requests = 0;
    const result = await preflightReviewer({
      apiKey: "sk-ant-invalid",
      endpoint: "https://reviewer.invalid/v1/messages",
      fetchImpl: async () => {
        requests += 1;
        return new Response(
          JSON.stringify({
            error: {
              type: "authentication_error",
              message: "invalid x-api-key",
            },
          }),
          { status: 401 },
        );
      },
    });

    assert.equal(requests, 1);
    assert.equal(result.ok, false);
    assert.equal(result.classification, "rejected-credentials");
    assert.match(result.detail, /^HTTP 401: /);
  });

  it("accepts a successful provider response", async () => {
    const result = await preflightReviewer({
      apiKey: "test-key",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });

    assert.deepEqual(result, { ok: true, classification: "ready", detail: "" });
  });
});
