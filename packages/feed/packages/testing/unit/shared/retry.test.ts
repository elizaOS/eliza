/**
 * Retry Utility Test Suite
 *
 * Tests for retry logic with exponential backoff.
 */

import { describe, expect, test } from "bun:test";
import {
  isRetryableError,
  retryIfRetryable,
  retryWithCondition,
  sleep,
} from "@feed/shared";

describe("Retry Utility - isRetryableError", () => {
  test("returns true for fetch network errors", () => {
    const error = new TypeError("Failed to fetch");
    expect(isRetryableError(error)).toBe(true);
  });

  test("returns true for 500 errors", () => {
    const error = { status: 500 };
    expect(isRetryableError(error)).toBe(true);
  });

  test("returns true for 502 errors", () => {
    const error = { status: 502 };
    expect(isRetryableError(error)).toBe(true);
  });

  test("returns true for 503 errors", () => {
    const error = { status: 503 };
    expect(isRetryableError(error)).toBe(true);
  });

  test("returns true for 429 rate limit errors", () => {
    const error = { status: 429 };
    expect(isRetryableError(error)).toBe(true);
  });

  test("returns false for 400 errors", () => {
    const error = { status: 400 };
    expect(isRetryableError(error)).toBe(false);
  });

  test("returns false for 404 errors", () => {
    const error = { status: 404 };
    expect(isRetryableError(error)).toBe(false);
  });

  test("returns false for generic errors", () => {
    const error = new Error("Something went wrong");
    expect(isRetryableError(error)).toBe(false);
  });

  test("returns false for null", () => {
    expect(isRetryableError(null)).toBe(false);
  });

  test("returns false for undefined", () => {
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe("Retry Utility - sleep", () => {
  test("resolves after specified time", async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    // Allow broad tolerance for CI environments with variable timing
    // Minimum: 30ms (allows for timer inaccuracies)
    // Maximum: 200ms (allows for system load delays)
    expect(elapsed).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("Retry Utility - retryIfRetryable", () => {
  test("returns result on first success", async () => {
    let attempts = 0;
    const result = await retryIfRetryable(async () => {
      attempts++;
      return "success";
    });

    expect(result).toBe("success");
    expect(attempts).toBe(1);
  });

  test("retries on retryable error then succeeds", async () => {
    let attempts = 0;
    const result = await retryIfRetryable(
      async () => {
        attempts++;
        if (attempts < 2) {
          const error = { status: 500, message: "Server error" };
          throw error;
        }
        return "success";
      },
      { initialDelayMs: 10 },
    );

    expect(result).toBe("success");
    expect(attempts).toBe(2);
  });

  test("throws immediately on non-retryable error", async () => {
    let attempts = 0;

    await expect(
      retryIfRetryable(async () => {
        attempts++;
        throw new Error("Not retryable");
      }),
    ).rejects.toThrow("Not retryable");

    expect(attempts).toBe(1);
  });

  test("throws after max attempts", async () => {
    let attempts = 0;

    await expect(
      retryIfRetryable(
        async () => {
          attempts++;
          const error = { status: 500, message: "Server error" };
          throw error;
        },
        { maxAttempts: 3, initialDelayMs: 10 },
      ),
    ).rejects.toMatchObject({ status: 500 });

    expect(attempts).toBe(3);
  });

  test("calls onRetry callback", async () => {
    const retryCalls: Array<{
      attempt: number;
      error: unknown;
      delay: number;
    }> = [];

    await expect(
      retryIfRetryable(
        async () => {
          const error = { status: 500, message: "Server error" };
          throw error;
        },
        {
          maxAttempts: 3,
          initialDelayMs: 10,
          onRetry: (attempt, error, delay) => {
            retryCalls.push({ attempt, error, delay });
          },
        },
      ),
    ).rejects.toMatchObject({ status: 500 });

    expect(retryCalls.length).toBe(2); // 2 retries before final failure
    expect(retryCalls[0]?.attempt).toBe(1);
    expect(retryCalls[1]?.attempt).toBe(2);
  });
});

describe("Retry Utility - retryWithCondition", () => {
  test("retries based on custom condition", async () => {
    let attempts = 0;
    const customError = { code: "RETRY_ME" };

    const result = await retryWithCondition(
      async () => {
        attempts++;
        if (attempts < 2) {
          throw customError;
        }
        return "success";
      },
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code: string }).code === "RETRY_ME",
      { initialDelayMs: 10 },
    );

    expect(result).toBe("success");
    expect(attempts).toBe(2);
  });

  test("throws immediately when condition returns false", async () => {
    let attempts = 0;

    await expect(
      retryWithCondition(
        async () => {
          attempts++;
          throw new Error("No retry");
        },
        () => false,
        { initialDelayMs: 10 },
      ),
    ).rejects.toThrow("No retry");

    expect(attempts).toBe(1);
  });
});
