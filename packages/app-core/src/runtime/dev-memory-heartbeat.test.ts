/** Verifies healthy development memory samples stay available at debug level. */
import { describe, expect, it, vi } from "vitest";
import {
  isRoutineDevMemoryHeartbeatEnabled,
  logRoutineDevMemoryHeartbeat,
} from "./dev-memory-heartbeat.ts";

describe("logRoutineDevMemoryHeartbeat", () => {
  it("keeps forced-GC telemetry opt-in", () => {
    expect(isRoutineDevMemoryHeartbeatEnabled(undefined)).toBe(false);
    expect(isRoutineDevMemoryHeartbeatEnabled("0")).toBe(false);
    expect(isRoutineDevMemoryHeartbeatEnabled("true")).toBe(false);
    expect(isRoutineDevMemoryHeartbeatEnabled("1")).toBe(true);
  });

  it("emits the complete routine sample only through debug", () => {
    const debug = vi.fn();

    logRoutineDevMemoryHeartbeat({ debug }, "[eliza]", {
      rss: 100 * 1_048_576,
      heapTotal: 80 * 1_048_576,
      heapUsed: 60 * 1_048_576,
      external: 20 * 1_048_576,
      arrayBuffers: 10 * 1_048_576,
    });

    expect(debug).toHaveBeenCalledExactlyOnceWith(
      "[eliza] mem rss=100MB heapUsed=60MB heapTotal=80MB external=20MB arrayBuffers=10MB",
    );
  });
});
