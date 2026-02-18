import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";
import { TrustMonitorService } from "./trust-monitor.js";
import { setScoutClient, setScoutConfig } from "../runtime-store.js";
import type { ScoutClient } from "../client/scout-client.js";
import { DEFAULT_CONFIG } from "../config.js";

function makeRuntime(): IAgentRuntime {
  return {
    agentId: "agent-1",
    logger: { info: vi.fn(), warn: vi.fn() },
  } as unknown as IAgentRuntime;
}

describe("TrustMonitorService", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("runs initial check on start", async () => {
    const runtime = makeRuntime();
    const mockBatchScore = vi.fn().mockResolvedValue({
      results: [{ domain: "test.com", score: 80, level: "HIGH" }],
    });
    setScoutClient(runtime, { batchScore: mockBatchScore } as unknown as ScoutClient);
    setScoutConfig(runtime, {
      ...DEFAULT_CONFIG,
      watchedDomains: ["test.com"],
      watchInterval: 60,
    });

    const service = await TrustMonitorService.start(runtime);
    expect(mockBatchScore).toHaveBeenCalledWith(["test.com"]);
    await service.stop();
  });

  it("does not start if no watched domains", async () => {
    const runtime = makeRuntime();
    const mockBatchScore = vi.fn();
    setScoutClient(runtime, { batchScore: mockBatchScore } as unknown as ScoutClient);
    setScoutConfig(runtime, { ...DEFAULT_CONFIG, watchedDomains: [] });

    const service = await TrustMonitorService.start(runtime);
    expect(mockBatchScore).not.toHaveBeenCalled();
    await service.stop();
  });

  it("detects score changes above threshold", async () => {
    const runtime = makeRuntime();
    let callCount = 0;
    const mockBatchScore = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ results: [{ domain: "test.com", score: 80, level: "HIGH" }] });
      }
      // Score dropped by 15 points
      return Promise.resolve({ results: [{ domain: "test.com", score: 65, level: "MEDIUM" }] });
    });

    setScoutClient(runtime, { batchScore: mockBatchScore } as unknown as ScoutClient);
    setScoutConfig(runtime, {
      ...DEFAULT_CONFIG,
      watchedDomains: ["test.com"],
      watchInterval: 1,
    });

    const service = await TrustMonitorService.start(runtime);

    // Advance timer to trigger second check
    await vi.advanceTimersByTimeAsync(60001);

    expect(mockBatchScore).toHaveBeenCalledTimes(2);
    expect((runtime.logger as any).info).toHaveBeenCalledWith(
      expect.stringContaining("decreased")
    );

    await service.stop();
  });

  it("ignores small score changes below threshold", async () => {
    const runtime = makeRuntime();
    let callCount = 0;
    const mockBatchScore = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ results: [{ domain: "test.com", score: 80, level: "HIGH" }] });
      }
      // Only 5 points change, same level
      return Promise.resolve({ results: [{ domain: "test.com", score: 75, level: "HIGH" }] });
    });

    setScoutClient(runtime, { batchScore: mockBatchScore } as unknown as ScoutClient);
    setScoutConfig(runtime, {
      ...DEFAULT_CONFIG,
      watchedDomains: ["test.com"],
      watchInterval: 1,
    });

    const service = await TrustMonitorService.start(runtime);
    await vi.advanceTimersByTimeAsync(60001);

    expect((runtime.logger as any).info).not.toHaveBeenCalled();
    await service.stop();
  });

  it("detects level changes even with small score delta", async () => {
    const runtime = makeRuntime();
    let callCount = 0;
    const mockBatchScore = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ results: [{ domain: "test.com", score: 76, level: "HIGH" }] });
      }
      // 2 point drop but crosses HIGH -> MEDIUM boundary
      return Promise.resolve({ results: [{ domain: "test.com", score: 74, level: "MEDIUM" }] });
    });

    setScoutClient(runtime, { batchScore: mockBatchScore } as unknown as ScoutClient);
    setScoutConfig(runtime, {
      ...DEFAULT_CONFIG,
      watchedDomains: ["test.com"],
      watchInterval: 1,
    });

    const service = await TrustMonitorService.start(runtime);
    await vi.advanceTimersByTimeAsync(60001);

    expect((runtime.logger as any).info).toHaveBeenCalledWith(
      expect.stringContaining("decreased")
    );
    await service.stop();
  });

  it("skips domains with null scores", async () => {
    const runtime = makeRuntime();
    const mockBatchScore = vi.fn().mockResolvedValue({
      results: [{ domain: "missing.com", score: null, level: null }],
    });

    setScoutClient(runtime, { batchScore: mockBatchScore } as unknown as ScoutClient);
    setScoutConfig(runtime, {
      ...DEFAULT_CONFIG,
      watchedDomains: ["missing.com"],
      watchInterval: 1,
    });

    const service = await TrustMonitorService.start(runtime);
    // Should not throw
    expect((runtime.logger as any).info).not.toHaveBeenCalled();
    await service.stop();
  });

  it("handles API errors gracefully", async () => {
    const runtime = makeRuntime();
    const mockBatchScore = vi.fn().mockRejectedValue(new Error("API down"));

    setScoutClient(runtime, { batchScore: mockBatchScore } as unknown as ScoutClient);
    setScoutConfig(runtime, {
      ...DEFAULT_CONFIG,
      watchedDomains: ["test.com"],
      watchInterval: 1,
    });

    // Should not throw
    const service = await TrustMonitorService.start(runtime);
    await service.stop();
  });

  it("stop() clears the interval", async () => {
    const runtime = makeRuntime();
    const mockBatchScore = vi.fn().mockResolvedValue({ results: [] });
    setScoutClient(runtime, { batchScore: mockBatchScore } as unknown as ScoutClient);
    setScoutConfig(runtime, {
      ...DEFAULT_CONFIG,
      watchedDomains: ["test.com"],
      watchInterval: 1,
    });

    const service = await TrustMonitorService.start(runtime);
    await service.stop();

    // Advance time - should not trigger another batch call beyond initial
    const callsBefore = mockBatchScore.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(mockBatchScore.mock.calls.length).toBe(callsBefore);
  });
});