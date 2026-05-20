import { describe, expect, it } from "bun:test";

// The retry boundary: items with attempts < MAX_RETRY_ATTEMPTS (3) are re-queued.
// Items at attempts >= 3 are dropped.
const MAX_RETRY_ATTEMPTS = 3;
// Auth retry cap: prevents infinite loop when token refresh consistently fails.
const MAX_AUTH_RETRIES = 2;

interface AuthRetryItem {
  attempts: number;
  authRetries: number;
  payload: object;
}

function applyAuthRetryFilter(
  batch: Array<{ attempts: number; authRetries?: number; payload: object }>,
): { retryable: AuthRetryItem[]; dropped: typeof batch } {
  const retryable = batch
    .filter((item) => (item.authRetries ?? 0) < MAX_AUTH_RETRIES)
    .map((item) => ({
      ...item,
      attempts: 0,
      authRetries: (item.authRetries ?? 0) + 1,
    }));
  const dropped = batch.filter(
    (item) => (item.authRetries ?? 0) >= MAX_AUTH_RETRIES,
  );
  return { retryable, dropped };
}

function applyRetryFilter<T extends { attempts: number }>(
  batch: T[],
): { retryable: T[]; dropped: T[] } {
  const incremented = batch.map((item) => ({
    ...item,
    attempts: item.attempts + 1,
  }));
  const retryable = incremented.filter(
    (item) => item.attempts < MAX_RETRY_ATTEMPTS,
  );
  const dropped = incremented.filter(
    (item) => item.attempts >= MAX_RETRY_ATTEMPTS,
  );
  return { retryable, dropped };
}

describe("useFeedEventTracker auth retry semantics (401 cap)", () => {
  it("re-queues events on first 401 (authRetries undefined → 1)", () => {
    const batch = [{ attempts: 0, payload: {}, authRetries: undefined }];
    const { retryable, dropped } = applyAuthRetryFilter(batch);
    expect(retryable).toHaveLength(1);
    expect(retryable[0]).toBeDefined();
    expect(retryable[0]?.authRetries).toBe(1);
    expect(retryable[0]?.attempts).toBe(0); // reset for fresh token attempt
    expect(dropped).toHaveLength(0);
  });

  it("re-queues events on second 401 (authRetries 1 → 2)", () => {
    const batch = [{ attempts: 0, payload: {}, authRetries: 1 }];
    const { retryable, dropped } = applyAuthRetryFilter(batch);
    expect(retryable).toHaveLength(1);
    expect(retryable[0]).toBeDefined();
    expect(retryable[0]?.authRetries).toBe(2);
    expect(dropped).toHaveLength(0);
  });

  it("drops events after MAX_AUTH_RETRIES 401s (authRetries 2 → dropped)", () => {
    const batch = [{ attempts: 0, payload: {}, authRetries: 2 }];
    const { retryable, dropped } = applyAuthRetryFilter(batch);
    expect(retryable).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it("handles mixed batch: some retryable, some dropped", () => {
    const batch = [
      { attempts: 0, payload: {}, authRetries: 0 },
      { attempts: 0, payload: {}, authRetries: 2 },
    ];
    const { retryable, dropped } = applyAuthRetryFilter(batch);
    expect(retryable).toHaveLength(1);
    expect(dropped).toHaveLength(1);
  });
});

describe("useFeedEventTracker retry semantics", () => {
  it("re-queues events with attempts 0 (first failure)", () => {
    const batch = [{ attempts: 0, payload: {} }];
    const { retryable, dropped } = applyRetryFilter(batch);
    expect(retryable).toHaveLength(1); // attempts becomes 1, 1 < 3 → re-queue
    expect(dropped).toHaveLength(0);
  });

  it("re-queues events with attempts 1 (second failure)", () => {
    const batch = [{ attempts: 1, payload: {} }];
    const { retryable, dropped } = applyRetryFilter(batch);
    expect(retryable).toHaveLength(1); // attempts becomes 2, 2 < 3 → re-queue
    expect(dropped).toHaveLength(0);
  });

  it("drops events that have reached MAX_RETRY_ATTEMPTS (third failure)", () => {
    const batch = [{ attempts: 2, payload: {} }];
    const { retryable, dropped } = applyRetryFilter(batch);
    expect(retryable).toHaveLength(0); // attempts becomes 3, 3 is NOT < 3 → drop
    expect(dropped).toHaveLength(1);
  });

  it("never allows a 4th attempt (regression test for off-by-one fix)", () => {
    // Simulate 3 previous failures: attempts starts at 0,1,2 → becomes 1,2,3
    // Only attempts=0 and attempts=1 survivors remain in queue before 3rd failure
    const survivors = [{ attempts: 0 }, { attempts: 1 }].map((item) => ({
      ...item,
      attempts: item.attempts + 1,
    })); // → attempts 1, 2
    const { retryable: secondRound, dropped } = applyRetryFilter(survivors); // → attempts 2, 3
    expect(dropped).toHaveLength(1); // attempts=3 → dropped (>= MAX_RETRY_ATTEMPTS)
    expect(secondRound).toHaveLength(1); // attempts=2 → still retryable (< MAX_RETRY_ATTEMPTS)
  });
});
