import { ElizaError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeWithRetry, formatModelError, sanitizeUrlForLogs } from "./retry.js";

describe("anthropic retry helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("executeWithRetry", () => {
    it("returns the result of a successful first attempt", async () => {
      const fn = vi.fn().mockResolvedValue("ok");
      await expect(
        executeWithRetry("op", fn, {
          maxRetries: 3,
          initialDelayMs: 500,
          maxDelayMs: 4000,
          backoffFactor: 2,
        })
      ).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries a 429 response and succeeds on the second attempt", async () => {
      const fn = vi.fn().mockRejectedValueOnce({ status: 429 }).mockResolvedValueOnce("ok");
      const promise = executeWithRetry("op", fn, {
        maxRetries: 3,
        initialDelayMs: 500,
        maxDelayMs: 4000,
        backoffFactor: 2,
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(promise).resolves.toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("retries overload messages from the provider", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("provider is overloaded"))
        .mockResolvedValueOnce("ok");
      const promise = executeWithRetry("op", fn, {
        maxRetries: 3,
        initialDelayMs: 500,
        maxDelayMs: 4000,
        backoffFactor: 2,
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(promise).resolves.toBe("ok");
    });

    it("does not retry non-retryable errors (400)", async () => {
      const error = { status: 400, message: "bad request" };
      const fn = vi.fn().mockRejectedValue(error);
      await expect(
        executeWithRetry("op", fn, {
          maxRetries: 3,
          initialDelayMs: 500,
          maxDelayMs: 4000,
          backoffFactor: 2,
        })
      ).rejects.toBe(error);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on timeout message classification", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error("request timed out after 10s"))
        .mockResolvedValueOnce("ok");
      const promise = executeWithRetry("op", fn, {
        maxRetries: 3,
        initialDelayMs: 500,
        maxDelayMs: 4000,
        backoffFactor: 2,
      });
      await vi.advanceTimersByTimeAsync(500);
      await expect(promise).resolves.toBe("ok");
    });

    it("backs off exponentially and caps at maxDelayMs", async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce({ status: 429 })
        .mockRejectedValueOnce({ status: 429 })
        .mockRejectedValueOnce({ status: 429 })
        .mockRejectedValueOnce({ status: 429 })
        .mockResolvedValue("ok");
      const promise = executeWithRetry("op", fn, {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 2500,
        backoffFactor: 2,
      });
      // attempt 0 fail -> sleep 1000; attempt 1 fail -> sleep 2000;
      // attempt 2 fail -> sleep 2500 (capped); attempt 3 fail -> rethrow
      const assertion = expect(promise).rejects.toMatchObject({ status: 429 });
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(10000);
      }
      await assertion;
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it("exhausts retries and rethrows the original error", async () => {
      const error = { status: 503, message: "unavailable" };
      const fn = vi.fn().mockRejectedValue(error);
      const promise = executeWithRetry("op", fn, {
        maxRetries: 2,
        initialDelayMs: 100,
        maxDelayMs: 4000,
        backoffFactor: 2,
      });
      const assertion = expect(promise).rejects.toBe(error);
      await vi.advanceTimersByTimeAsync(10000);
      await assertion;
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe("formatModelError", () => {
    it("returns ElizaError instances unchanged", () => {
      const err = new ElizaError("boom", { code: "X" });
      expect(formatModelError("op", err)).toBe(err);
    });

    it("classifies 401 as an authentication failure", () => {
      const err = formatModelError("op", { status: 401 });
      expect(err.message).toContain("Authentication failed");
      expect(err.message).toContain("[Anthropic] op failed");
    });

    it("uses the provider message for 400 responses", () => {
      const err = formatModelError("op", {
        status: 400,
        data: { error: { message: "invalid prompt" } },
      });
      expect(err.message).toContain("invalid prompt");
    });

    it("reads provider messages from a JSON response body", () => {
      const err = formatModelError("op", {
        status: 400,
        responseBody: JSON.stringify({ error: { message: "too many tokens" } }),
      });
      expect(err.message).toContain("too many tokens");
    });

    it("classifies 429 as rate limiting", () => {
      const err = formatModelError("op", { status: 429 });
      expect(err.message).toContain("rate limited");
    });

    it("classifies 504 as a timeout", () => {
      const err = formatModelError("op", { status: 504 });
      expect(err.message).toContain("timed out");
    });

    it("classifies 529 as provider overload", () => {
      const err = formatModelError("op", { status: 529 });
      expect(err.message).toContain("overloaded");
    });

    it("classifies other 5xx as temporary unavailability", () => {
      const err = formatModelError("op", { status: 502 });
      expect(err.message).toContain("temporarily unavailable");
    });

    it("attaches the original error as cause", () => {
      const cause = new Error("underlying");
      const err = formatModelError("op", cause);
      expect(err.cause).toBe(cause);
    });

    it("falls back to a generic reason for unknown errors", () => {
      const err = formatModelError("op", { message: "weird" });
      expect(err.message).toContain("unexpected error");
    });
  });

  describe("sanitizeUrlForLogs", () => {
    it("strips query strings and fragments", () => {
      expect(sanitizeUrlForLogs("https://api.anthropic.com/v1/messages?api-key=secret#frag")).toBe(
        "https://api.anthropic.com/v1/messages"
      );
    });

    it("strips userinfo credentials from the origin", () => {
      expect(sanitizeUrlForLogs("https://alice:secret@api.anthropic.com/v1")).toBe(
        "https://api.anthropic.com/v1"
      );
    });

    it("marks invalid URLs explicitly", () => {
      expect(sanitizeUrlForLogs("not a url")).toBe("[invalid-url]");
      expect(sanitizeUrlForLogs("/relative/path")).toBe("[invalid-url]");
    });

    it("keeps the explicit port when present", () => {
      expect(sanitizeUrlForLogs("https://localhost:8443/v1")).toBe("https://localhost:8443/v1");
    });
  });
});
