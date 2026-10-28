/**
 * Provider rate-limit retry contract against the real installed AI SDK error
 * envelope. `RetryError` comes from the installed `ai` package — the class
 * `generateText` throws once its own retries exhaust; its `errors[]` members
 * carry the provider's structural status and retry headers exactly as the SDK
 * produces them. No provider transport is involved, so these are
 * deterministic classifier tests over the real wrapped shape.
 */

import { providerRateLimitRetryAt } from "@elizaos/core";
import { RetryError } from "ai";
import { describe, expect, it } from "vitest";

/** Structural shape of the SDK's wrapped 429 APICallError member. */
function rateLimitedCall(headers: Record<string, string>): Error {
  return Object.assign(new Error("Too many requests"), {
    name: "AI_APICallError",
    url: "https://api.example.test/v1/chat/completions",
    statusCode: 429,
    responseHeaders: headers,
    responseBody: '{"error":{"message":"Rate limit exceeded"}}',
    isRetryable: true,
  });
}

/** The envelope the installed SDK throws after retries exhaust. */
function exhaustedRetriesEnvelope(headers: Record<string, string>): RetryError {
  const call = rateLimitedCall(headers);
  return new RetryError({
    message: "Failed after 3 attempts. Last error: Too many requests",
    reason: "maxRetriesExceeded",
    errors: [call, call],
  });
}

describe("providerRateLimitRetryAt through SDK error envelopes", () => {
  it("reads Retry-After seconds from a wrapped 429 inside the RetryError envelope", () => {
    const now = 1_000_000;
    const retryAt = providerRateLimitRetryAt(
      exhaustedRetriesEnvelope({ "retry-after": "7" }),
      now,
    );
    expect(retryAt).toBe(now + 7_000);
  });

  it("prefers retry-after-ms over Retry-After on the wrapped 429", () => {
    const now = 1_000_000;
    const retryAt = providerRateLimitRetryAt(
      exhaustedRetriesEnvelope({
        "retry-after-ms": "250",
        "retry-after": "60",
      }),
      now,
    );
    expect(retryAt).toBe(now + 250);
  });

  it("still reads a top-level 429 shaped error directly", () => {
    const now = 1_000_000;
    const retryAt = providerRateLimitRetryAt(
      rateLimitedCall({ "retry-after": "3" }),
      now,
    );
    expect(retryAt).toBe(now + 3_000);
  });

  it("gives no deadline when every wrapped status differs from 429", () => {
    const now = 1_000_000;
    const overloaded = Object.assign(new Error("Service overloaded"), {
      name: "AI_APICallError",
      statusCode: 529,
      responseHeaders: { "retry-after": "7" },
      isRetryable: true,
    });
    const envelope = new RetryError({
      message: "Failed after 3 attempts. Last error: Service overloaded",
      reason: "maxRetriesExceeded",
      errors: [overloaded],
    });
    expect(providerRateLimitRetryAt(envelope, now)).toBeUndefined();
  });

  it("gives no deadline for a wrapped permanent quota exhaustion", () => {
    const now = 1_000_000;
    const quota = Object.assign(
      new Error("insufficient_quota: You exceeded your current quota"),
      {
        name: "AI_APICallError",
        statusCode: 429,
        responseHeaders: { "retry-after": "7" },
        responseBody: '{"error":{"code":"insufficient_quota"}}',
        isRetryable: false,
      },
    );
    const envelope = new RetryError({
      message: "Failed after 3 attempts. Last error: insufficient_quota",
      reason: "maxRetriesExceeded",
      errors: [quota],
    });
    expect(providerRateLimitRetryAt(envelope, now)).toBeUndefined();
  });

  it("keeps a message-only quota mention retryable: prose never sets permanence", () => {
    const now = 1_000_000;
    // The quota words appear only in the error message and in the body's
    // message field — no structured code/type field anywhere in the graph.
    // The file contract is "never a message substring", so the 429 stays a
    // temporary rate limit and its Retry-After deadline must be honored.
    const prose = Object.assign(
      new Error("insufficient_quota: You exceeded your current quota"),
      {
        name: "AI_APICallError",
        statusCode: 429,
        responseHeaders: { "retry-after": "7" },
        responseBody: '{"error":{"message":"You exceeded your current quota"}}',
        isRetryable: true,
      },
    );
    const envelope = new RetryError({
      message: "Failed after 3 attempts. Last error: insufficient_quota",
      reason: "maxRetriesExceeded",
      errors: [prose],
    });
    expect(providerRateLimitRetryAt(envelope, now)).toBe(now + 7_000);
  });

  it("gives no deadline when the wrapped 429 carries no retry hint", () => {
    const now = 1_000_000;
    const envelope = exhaustedRetriesEnvelope({});
    expect(providerRateLimitRetryAt(envelope, now)).toBeUndefined();
  });

  it("bounds oversized histories and prefers the explicit final error", () => {
    const now = 1_000_000;
    const envelope = {
      lastError: { statusCode: 429, retryAfterMs: 7000 },
      errors: Array.from({ length: 200_000 }, () => ({
        statusCode: 429,
        retryAfterMs: 1000,
      })),
    };
    expect(providerRateLimitRetryAt(envelope, now)).toBe(now + 7000);
  });

  it("terminates on cyclic retry envelopes", () => {
    const envelope: { cause?: unknown; errors: unknown[] } = { errors: [] };
    envelope.cause = envelope;
    envelope.errors.push(envelope);
    expect(providerRateLimitRetryAt(envelope)).toBeUndefined();
  });
});
