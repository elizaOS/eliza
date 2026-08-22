/**
 * Real `RequestQueue` coverage: a swallowed wrapper catch used to
 * reject `add()` on the first failure and skip retry/backoff. The queue now
 * retries, then rejects only after the budget is exhausted. Per-call retry
 * policy keeps ambiguous non-idempotent writes from being repeated.
 */
import { describe, expect, it, vi } from "vitest";
import { RequestQueue } from "./base";
import { shouldRetryTwitterWrite } from "./utils/error-handler";

function makeQueue(): RequestQueue {
  return new RequestQueue({
    backoff: async () => undefined,
    jitter: async () => undefined,
  });
}

describe("RequestQueue retries provider failures", () => {
  it("retries a failed request and resolves when a later attempt succeeds", async () => {
    const queue = makeQueue();
    let calls = 0;
    await expect(
      queue.add(async () => {
        calls += 1;
        if (calls < 2) {
          throw new Error("HTTP 429 rate limited");
        }
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(calls).toBe(2);
  }, 20_000);

  it("rejects after the retry budget instead of hanging or skipping", async () => {
    const queue = makeQueue();
    let calls = 0;
    await expect(
      queue.add(async () => {
        calls += 1;
        throw new Error("HTTP 429 rate limited");
      }),
    ).rejects.toThrow("HTTP 429 rate limited");
    expect(calls).toBe(3);
  }, 20_000);

  it("still resolves a first-try success without extra attempts", async () => {
    const queue = makeQueue();
    let calls = 0;
    await expect(
      queue.add(async () => {
        calls += 1;
        return 42;
      }),
    ).resolves.toBe(42);
    expect(calls).toBe(1);
  });

  it("does not retry when a non-idempotent caller rejects the error", async () => {
    const queue = makeQueue();
    let calls = 0;
    const shouldRetry = vi.fn(() => false);

    await expect(
      queue.add(
        async () => {
          calls += 1;
          throw new Error("ambiguous network failure");
        },
        { shouldRetry },
      ),
    ).rejects.toThrow("ambiguous network failure");

    expect(calls).toBe(1);
    expect(shouldRetry).toHaveBeenCalledOnce();
  });

  it("honors a per-call policy that permits an explicit rejection retry", async () => {
    const queue = makeQueue();
    let calls = 0;

    await expect(
      queue.add(
        async () => {
          calls += 1;
          if (calls === 1) throw new Error("HTTP 429 rate limited");
          return "ok";
        },
        { shouldRetry: (error) => String(error).includes("429") },
      ),
    ).resolves.toBe("ok");

    expect(calls).toBe(2);
  });

  it("retries only explicit rate-limit write rejections", () => {
    expect(shouldRetryTwitterWrite({ status: 429 })).toBe(true);
    expect(shouldRetryTwitterWrite(new Error("rate limit exceeded"))).toBe(
      true,
    );
    expect(shouldRetryTwitterWrite(new Error("network timeout"))).toBe(false);
    expect(shouldRetryTwitterWrite({ status: 500 })).toBe(false);
    expect(
      shouldRetryTwitterWrite(new Error("unknown transport failure")),
    ).toBe(false);
  });
});
