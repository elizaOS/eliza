import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TELEMETRY_RETENTION_DAYS,
  runTelemetryRetention,
} from "./telemetry-retention.ts";

describe("runTelemetryRetention", () => {
  it("uses the default retention when not provided", async () => {
    const pruneTelemetryEvents = vi.fn(async () => ({ deletedCount: 3 }));
    const result = await runTelemetryRetention({
      repository: { pruneTelemetryEvents } as never,
      agentId: "agent-1",
    });
    expect(pruneTelemetryEvents).toHaveBeenCalledWith({
      agentId: "agent-1",
      retentionDays: DEFAULT_TELEMETRY_RETENTION_DAYS,
    });
    expect(result.deletedCount).toBe(3);
  });

  it("honors an explicit retention window", async () => {
    const pruneTelemetryEvents = vi.fn(async () => ({ deletedCount: 0 }));
    await runTelemetryRetention({
      repository: { pruneTelemetryEvents } as never,
      agentId: "agent-1",
      retentionDays: 7,
    });
    expect(pruneTelemetryEvents).toHaveBeenCalledWith({
      agentId: "agent-1",
      retentionDays: 7,
    });
  });
});
