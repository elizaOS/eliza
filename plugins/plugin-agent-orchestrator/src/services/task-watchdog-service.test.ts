/**
 * Unit tests for task-watchdog-service: validates idle session detection logic.
 */
import { describe, expect, it } from "vitest";
import {
  detectStalledSessions,
  STALL_GRILL_PROMPT,
  TASK_WATCHDOG_SERVICE_TYPE,
  type WatchdogSessionView,
} from "./task-watchdog-service.ts";

describe("task-watchdog-service", () => {
  it("exports watchdog service type and stall prompt", () => {
    expect(TASK_WATCHDOG_SERVICE_TYPE).toBe("ORCHESTRATOR_TASK_WATCHDOG");
    expect(typeof STALL_GRILL_PROMPT).toBe("string");
    expect(STALL_GRILL_PROMPT.length).toBeGreaterThan(10);
  });

  it("detects sessions that have exceeded the idle threshold", () => {
    const now = 1_000_000;
    const threshold = 180_000; // 3 minutes

    const sessions: WatchdogSessionView[] = [
      { id: "active-1", status: "running", lastActivityMs: now - 50_000 },
      { id: "stalled-1", status: "running", lastActivityMs: now - 200_000 },
      { id: "terminal-1", status: "completed", lastActivityMs: now - 300_000 },
    ];

    const stalled = detectStalledSessions(sessions, now, threshold);
    expect(stalled.length).toBe(1);
    expect(stalled[0].id).toBe("stalled-1");
    expect(stalled[0].idleMs).toBe(200_000);
  });
});
