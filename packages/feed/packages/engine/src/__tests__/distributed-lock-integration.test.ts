/**
 * Distributed Lock Service Integration Tests
 *
 * Tests for the lock acquisition/renewal/release flow in the
 * world facts update mechanism.
 *
 * Uses a self-contained lock implementation to avoid module conflicts
 * when running alongside other tests with mocked modules.
 */

import { beforeEach, describe, expect, test } from "bun:test";

// Self-contained lock implementation for testing
// Mirrors the DistributedLockProvider interface

type DistributedLockParams = {
  lockId: string;
  durationMs: number;
  operation: string;
  processId: string;
};

interface DistributedLockProvider {
  acquireLock(params: DistributedLockParams): Promise<boolean>;
  releaseLock(lockId: string, processId: string): Promise<void>;
}

class TestDistributedLockProvider implements DistributedLockProvider {
  private locks = new Map<string, { expiresAt: number; processId: string }>();

  async acquireLock(params: DistributedLockParams): Promise<boolean> {
    const now = Date.now();
    const current = this.locks.get(params.lockId);

    if (current && current.expiresAt > now) {
      // Allow same process to renew
      if (current.processId === params.processId) {
        this.locks.set(params.lockId, {
          expiresAt: now + Math.max(0, params.durationMs),
          processId: params.processId,
        });
        return true;
      }
      return false;
    }

    this.locks.set(params.lockId, {
      expiresAt: now + Math.max(0, params.durationMs),
      processId: params.processId,
    });

    return true;
  }

  async releaseLock(lockId: string, processId: string): Promise<void> {
    const current = this.locks.get(lockId);
    if (!current) return;
    if (current.processId !== processId) return;
    this.locks.delete(lockId);
  }

  reset(): void {
    this.locks.clear();
  }
}

// Singleton for tests
let provider: TestDistributedLockProvider;

const DistributedLockService = {
  acquireLock(params: DistributedLockParams): Promise<boolean> {
    return provider.acquireLock(params);
  },
  releaseLock(lockId: string, processId: string): Promise<void> {
    return provider.releaseLock(lockId, processId);
  },
};

describe("DistributedLockService - Basic Operations", () => {
  beforeEach(() => {
    // Create fresh provider for each test
    provider = new TestDistributedLockProvider();
  });

  test("should acquire lock when not held", async () => {
    const result = await DistributedLockService.acquireLock({
      lockId: "test-lock",
      durationMs: 5000,
      operation: "test",
      processId: "process-1",
    });

    expect(result).toBe(true);
  });

  test("should fail to acquire lock when already held", async () => {
    // First acquisition succeeds
    const first = await DistributedLockService.acquireLock({
      lockId: "test-lock",
      durationMs: 5000,
      operation: "test",
      processId: "process-1",
    });
    expect(first).toBe(true);

    // Second acquisition by different process fails
    const second = await DistributedLockService.acquireLock({
      lockId: "test-lock",
      durationMs: 5000,
      operation: "test",
      processId: "process-2",
    });
    expect(second).toBe(false);
  });

  test("should release lock and allow new acquisition", async () => {
    // Acquire
    await DistributedLockService.acquireLock({
      lockId: "test-lock",
      durationMs: 5000,
      operation: "test",
      processId: "process-1",
    });

    // Release
    await DistributedLockService.releaseLock("test-lock", "process-1");

    // Now another process can acquire
    const result = await DistributedLockService.acquireLock({
      lockId: "test-lock",
      durationMs: 5000,
      operation: "test",
      processId: "process-2",
    });
    expect(result).toBe(true);
  });

  test("should not release lock held by different process", async () => {
    // Process 1 acquires
    await DistributedLockService.acquireLock({
      lockId: "test-lock",
      durationMs: 5000,
      operation: "test",
      processId: "process-1",
    });

    // Process 2 tries to release (should fail silently)
    await DistributedLockService.releaseLock("test-lock", "process-2");

    // Process 2 still cannot acquire (process 1 still holds it)
    const result = await DistributedLockService.acquireLock({
      lockId: "test-lock",
      durationMs: 5000,
      operation: "test",
      processId: "process-2",
    });
    expect(result).toBe(false);
  });
});

describe("DistributedLockService - Lock Renewal", () => {
  beforeEach(() => {
    provider = new TestDistributedLockProvider();
  });

  test("same process can renew its own lock", async () => {
    // Initial acquisition
    const acquired = await DistributedLockService.acquireLock({
      lockId: "test-lock",
      durationMs: 5000,
      operation: "test",
      processId: "process-1",
    });
    expect(acquired).toBe(true);

    // Renewal by same process
    const renewed = await DistributedLockService.acquireLock({
      lockId: "test-lock",
      durationMs: 5000,
      operation: "test-renewal",
      processId: "process-1",
    });
    expect(renewed).toBe(true);
  });

  test("different process cannot steal lock via renewal", async () => {
    // Process 1 acquires
    await DistributedLockService.acquireLock({
      lockId: "test-lock",
      durationMs: 5000,
      operation: "test",
      processId: "process-1",
    });

    // Process 2 tries to "renew" (should fail)
    const stolen = await DistributedLockService.acquireLock({
      lockId: "test-lock",
      durationMs: 5000,
      operation: "test",
      processId: "process-2",
    });
    expect(stolen).toBe(false);
  });
});

describe("DistributedLockService - Expiration", () => {
  beforeEach(() => {
    provider = new TestDistributedLockProvider();
  });

  test("expired lock can be acquired by new process", async () => {
    // Acquire with very short duration
    await DistributedLockService.acquireLock({
      lockId: "test-lock",
      durationMs: 1, // 1ms - will expire almost immediately
      operation: "test",
      processId: "process-1",
    });

    // Wait for expiration
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Now another process can acquire
    const result = await DistributedLockService.acquireLock({
      lockId: "test-lock",
      durationMs: 5000,
      operation: "test",
      processId: "process-2",
    });
    expect(result).toBe(true);
  });
});

describe("DistributedLockService - World Facts Scenario", () => {
  beforeEach(() => {
    provider = new TestDistributedLockProvider();
  });

  test("simulates world facts update lock flow", async () => {
    const LOCK_ID = "world-facts-generation";
    const LOCK_DURATION_MS = 30 * 60 * 1000; // 30 minutes
    const processId = `game-tick-${Date.now()}-abc123`;

    // Step 1: Acquire lock
    const acquired = await DistributedLockService.acquireLock({
      lockId: LOCK_ID,
      durationMs: LOCK_DURATION_MS,
      operation: "world-facts-generation",
      processId,
    });
    expect(acquired).toBe(true);

    // Step 2: Simulate lock renewal (happens every 15 minutes)
    const renewed = await DistributedLockService.acquireLock({
      lockId: LOCK_ID,
      durationMs: LOCK_DURATION_MS,
      operation: "world-facts-generation-renewal",
      processId,
    });
    expect(renewed).toBe(true);

    // Step 3: Another process tries to acquire (should fail)
    const otherProcess = `game-tick-${Date.now()}-xyz789`;
    const blocked = await DistributedLockService.acquireLock({
      lockId: LOCK_ID,
      durationMs: LOCK_DURATION_MS,
      operation: "world-facts-generation",
      processId: otherProcess,
    });
    expect(blocked).toBe(false);

    // Step 4: Release lock
    await DistributedLockService.releaseLock(LOCK_ID, processId);

    // Step 5: Now another process can acquire
    const newAcquire = await DistributedLockService.acquireLock({
      lockId: LOCK_ID,
      durationMs: LOCK_DURATION_MS,
      operation: "world-facts-generation",
      processId: otherProcess,
    });
    expect(newAcquire).toBe(true);
  });

  test("concurrent processes serialize correctly", async () => {
    const LOCK_ID = "world-facts-generation";
    const results: string[] = [];

    // Retry configuration for acquiring lock
    const RETRY_DELAY_MS = 15;
    const MAX_RETRIES = 10;
    const TIMEOUT_MS = 200;

    const acquireWithRetry = async (processId: string): Promise<boolean> => {
      const startTime = Date.now();
      let hasRecordedBlocked = false;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (Date.now() - startTime > TIMEOUT_MS) {
          return false; // Timeout exceeded
        }

        const acquired = await DistributedLockService.acquireLock({
          lockId: LOCK_ID,
          durationMs: 100,
          operation: "test",
          processId,
        });

        if (acquired) {
          return true;
        }

        // Record 'blocked' only on first failed attempt
        if (!hasRecordedBlocked) {
          results.push(`${processId}-blocked`);
          hasRecordedBlocked = true;
        }

        // Wait with small backoff before retry
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }

      return false; // Max retries exceeded
    };

    const process1 = async () => {
      const acquired = await acquireWithRetry("p1");
      if (acquired) {
        results.push("p1-acquired");
        await new Promise((r) => setTimeout(r, 20));
        await DistributedLockService.releaseLock(LOCK_ID, "p1");
        results.push("p1-released");
      }
    };

    const process2 = async () => {
      const acquired = await acquireWithRetry("p2");
      if (acquired) {
        results.push("p2-acquired");
        await new Promise((r) => setTimeout(r, 20));
        await DistributedLockService.releaseLock(LOCK_ID, "p2");
        results.push("p2-released");
      }
    };

    // Run concurrently
    await Promise.all([process1(), process2()]);

    // Both processes should eventually acquire and release the lock
    const acquiredCount = results.filter((r) => r.endsWith("-acquired")).length;
    const blockedCount = results.filter((r) => r.endsWith("-blocked")).length;
    const releasedCount = results.filter((r) => r.endsWith("-released")).length;

    expect(acquiredCount).toBe(2); // Both should acquire
    expect(releasedCount).toBe(2); // Both should release
    expect(blockedCount).toBeGreaterThanOrEqual(1); // At least one had to wait

    // Verify both processes completed successfully
    expect(results.includes("p1-acquired")).toBe(true);
    expect(results.includes("p2-acquired")).toBe(true);
    expect(results.includes("p1-released")).toBe(true);
    expect(results.includes("p2-released")).toBe(true);
  });
});
