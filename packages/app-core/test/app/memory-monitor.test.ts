/**
 * Tests for the memory monitoring infrastructure.
 * Tests the standalone startMemoryLeakDetector function which doesn't require React.
 */

import { startMemoryLeakDetector } from "@elizaos/app-core/hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mockDateNow = 1000000;
vi.spyOn(Date, "now").mockImplementation(() => mockDateNow);

let intervalCallbacks: (() => void)[] = [];
vi.stubGlobal("setInterval", (cb: () => void) => {
  intervalCallbacks.push(cb);
  return intervalCallbacks.length;
});
vi.stubGlobal("clearInterval", (_id: number) => {
  // Simple mock: just clear all for these tests since we only test one thing per block
  // or we could remove by index if needed.
  intervalCallbacks = [];
});

// Mock the Performance API memory interface
const mockMemory = {
  usedJSHeapSize: 50 * 1024 * 1024, // 50 MB
  totalJSHeapSize: 100 * 1024 * 1024, // 100 MB
  jsHeapSizeLimit: 2048 * 1024 * 1024, // 2 GB
};

// Store original performance object
const originalPerformance = globalThis.performance;

function setupPerformanceMock() {
  const perfToken = { ...mockMemory };
  Object.defineProperty(globalThis, "performance", {
    value: { ...originalPerformance, memory: perfToken },
    writable: true,
    configurable: true,
  });
  return perfToken;
}

function restorePerformanceMock() {
  Object.defineProperty(globalThis, "performance", {
    value: originalPerformance,
    writable: true,
    configurable: true,
  });
}

describe("startMemoryLeakDetector", () => {
  let perfToken: typeof mockMemory;
  beforeEach(() => {
    perfToken = setupPerformanceMock();
    mockDateNow = 1000000;
    intervalCallbacks = [];
  });

  afterEach(() => {
    restorePerformanceMock();
  });

  it("returns a cleanup function", async () => {
    const stop = startMemoryLeakDetector();
    expect(typeof stop).toBe("function");
    stop();
  });

  it("calls onLeak callback when leak is detected", async () => {
    const onLeak = vi.fn();
    let currentHeap = 50 * 1024 * 1024;

    const stop = startMemoryLeakDetector({
      intervalMs: 1000,
      thresholdMbPerMin: 1.0,
      onLeak,
    });

    // Simulate rapid memory growth
    for (let i = 0; i < 10; i++) {
      currentHeap += 5 * 1024 * 1024; // 100 MB per second = massive leak
      perfToken.usedJSHeapSize = currentHeap;
      mockDateNow += 1000;
      intervalCallbacks.forEach((cb) => {
        cb();
      });
    }

    expect(onLeak).toHaveBeenCalled();
    stop();
  });

  it("stops monitoring when cleanup is called", async () => {
    const onLeak = vi.fn();
    let currentHeap = 50 * 1024 * 1024;

    const stop = startMemoryLeakDetector({
      intervalMs: 1000,
      thresholdMbPerMin: 1.0,
      onLeak,
    });

    // Stop immediately
    stop();

    // Simulate rapid memory growth after stop
    for (let i = 0; i < 10; i++) {
      currentHeap += 5 * 1024 * 1024;
      perfToken.usedJSHeapSize = currentHeap;
      mockDateNow += 1000;
      intervalCallbacks.forEach((cb) => {
        cb();
      });
    }

    // onLeak should not have been called since we stopped
    expect(onLeak).not.toHaveBeenCalled();
  });

  it("respects custom threshold - high threshold prevents detection", async () => {
    const onLeak = vi.fn();
    let currentHeap = 50 * 1024 * 1024;

    // Set very high threshold
    const stop = startMemoryLeakDetector({
      intervalMs: 1000,
      thresholdMbPerMin: 100000.0, // Impossibly high threshold
      onLeak,
    });

    // Simulate rapid memory growth
    for (let i = 0; i < 10; i++) {
      currentHeap += 5 * 1024 * 1024;
      perfToken.usedJSHeapSize = currentHeap;
      mockDateNow += 1000;
      intervalCallbacks.forEach((cb) => {
        cb();
      });
    }

    // Should not trigger because threshold is too high
    expect(onLeak).not.toHaveBeenCalled();
    stop();
  });

  it("handles missing memory API gracefully", async () => {
    // Remove memory property entirely
    vi.stubGlobal("performance", { ...originalPerformance });
    const onLeak = vi.fn();
    const stop = startMemoryLeakDetector({
      intervalMs: 1000,
      onLeak,
    });

    // Advance time - should not crash
    for (let i = 0; i < 10; i++) {
      mockDateNow += 1000;
      intervalCallbacks.forEach((cb) => {
        cb();
      });
    }

    // onLeak should not be called since memory API isn't available
    expect(onLeak).not.toHaveBeenCalled();

    stop();
  });

  it("reports correct memory values in onLeak callback", async () => {
    let capturedInfo: { mbPerMinute: number; currentMb: number } | null = null;
    let currentHeap = 50 * 1024 * 1024;

    const stop = startMemoryLeakDetector({
      intervalMs: 1000,
      thresholdMbPerMin: 1.0,
      onLeak: (info) => {
        capturedInfo = info;
      },
    });

    // Simulate rapid memory growth
    for (let i = 0; i < 10; i++) {
      currentHeap += 5 * 1024 * 1024;
      perfToken.usedJSHeapSize = currentHeap;
      mockDateNow += 1000;
      intervalCallbacks.forEach((cb) => {
        cb();
      });
    }

    expect(capturedInfo).not.toBeNull();
    expect(capturedInfo?.mbPerMinute).toBeGreaterThan(0);
    expect(capturedInfo?.currentMb).toBeGreaterThan(50); // Should be greater than initial
    stop();
  });

  it("requires minimum samples before detecting leak", async () => {
    const onLeak = vi.fn();
    let currentHeap = 50 * 1024 * 1024;

    const stop = startMemoryLeakDetector({
      intervalMs: 1000,
      thresholdMbPerMin: 1.0,
      onLeak,
    });

    // Only advance 3 times (less than the minimum 6 samples needed)
    for (let i = 0; i < 3; i++) {
      currentHeap += 5 * 1024 * 1024;
      perfToken.usedJSHeapSize = currentHeap;
      mockDateNow += 1000;
      intervalCallbacks.forEach((cb) => {
        cb();
      });
    }

    // Should not trigger yet - not enough samples
    expect(onLeak).not.toHaveBeenCalled();

    // Continue to get enough samples
    for (let i = 0; i < 5; i++) {
      currentHeap += 5 * 1024 * 1024;
      perfToken.usedJSHeapSize = currentHeap;
      mockDateNow += 1000;
      intervalCallbacks.forEach((cb) => {
        cb();
      });
    }

    // Now should have triggered
    expect(onLeak).toHaveBeenCalled();
    stop();
  });
});

describe("memory leak detection edge cases", () => {
  let perfToken: typeof mockMemory;
  beforeEach(() => {
    perfToken = setupPerformanceMock();
    mockDateNow = 1000000;
    intervalCallbacks = [];
  });

  afterEach(() => {
    restorePerformanceMock();
  });

  it("handles stable memory (no growth)", async () => {
    const onLeak = vi.fn();
    // Memory stays constant
    perfToken.usedJSHeapSize = 50 * 1024 * 1024;

    const stop = startMemoryLeakDetector({
      intervalMs: 1000,
      thresholdMbPerMin: 1.0,
      onLeak,
    });

    // Advance time without changing memory
    for (let i = 0; i < 20; i++) {
      mockDateNow += 1000;
      intervalCallbacks.forEach((cb) => {
        cb();
      });
    }

    // Should not detect leak with stable memory
    expect(onLeak).not.toHaveBeenCalled();
    stop();
  });

  it("handles decreasing memory (GC occurring)", async () => {
    const onLeak = vi.fn();
    let currentHeap = 500 * 1024 * 1024; // Start high

    const stop = startMemoryLeakDetector({
      intervalMs: 1000,
      thresholdMbPerMin: 1.0,
      onLeak,
    });

    // Simulate memory decreasing (GC running)
    for (let i = 0; i < 10; i++) {
      currentHeap -= 20 * 1024 * 1024; // Memory decreases
      perfToken.usedJSHeapSize = currentHeap;
      mockDateNow += 1000;
      intervalCallbacks.forEach((cb) => {
        cb();
      });
    }

    // Should not detect leak when memory is decreasing
    expect(onLeak).not.toHaveBeenCalled();
    stop();
  });

  it("multiple detectors can run independently", async () => {
    const onLeak1 = vi.fn();
    const onLeak2 = vi.fn();
    let currentHeap = 50 * 1024 * 1024;

    const stop1 = startMemoryLeakDetector({
      intervalMs: 1000,
      thresholdMbPerMin: 1.0,
      onLeak: onLeak1,
    });

    const stop2 = startMemoryLeakDetector({
      intervalMs: 1000,
      thresholdMbPerMin: 1.0,
      onLeak: onLeak2,
    });

    // Simulate memory growth
    for (let i = 0; i < 10; i++) {
      currentHeap += 5 * 1024 * 1024;
      perfToken.usedJSHeapSize = currentHeap;
      mockDateNow += 1000;
      intervalCallbacks.forEach((cb) => {
        cb();
      });
    }

    // Both should have detected the leak
    expect(onLeak1).toHaveBeenCalled();
    expect(onLeak2).toHaveBeenCalled();

    stop1();
    stop2();
  });
});
