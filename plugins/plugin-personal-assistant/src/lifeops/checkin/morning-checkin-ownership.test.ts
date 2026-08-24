import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
}));

vi.mock("@elizaos/core", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  MORNING_CHECKIN_OWNER_ENGINE,
  MORNING_CHECKIN_SUPPRESSED_ENGINE,
  reportSuppressedSleepCycleMorningCheckin,
} from "./morning-checkin-ownership";

beforeEach(() => {
  mocks.loggerInfo.mockClear();
});

describe("reportSuppressedSleepCycleMorningCheckin", () => {
  it("logs the suppression with engine attribution, delivery basis and context", () => {
    reportSuppressedSleepCycleMorningCheckin({
      agentId: "agent-7",
      nowIso: "2026-08-24T09:00:00.000Z",
      timezone: "Asia/Shanghai",
      circadianState: "asleep",
      wakeAt: "2026-08-24T07:30:00.000Z",
    });

    expect(mocks.loggerInfo).toHaveBeenCalledTimes(1);
    const [payload, message] = mocks.loggerInfo.mock.calls[0];

    expect(payload.src).toBe("lifeops:morning-checkin-ownership");
    expect(payload.agentId).toBe("agent-7");
    expect(payload.nowIso).toBe("2026-08-24T09:00:00.000Z");
    expect(payload.timezone).toBe("Asia/Shanghai");
    expect(payload.circadianState).toBe("asleep");
    expect(payload.wakeAt).toBe("2026-08-24T07:30:00.000Z");
    expect(payload.ownerEngine).toBe(MORNING_CHECKIN_OWNER_ENGINE);
    expect(payload.suppressedEngine).toBe(MORNING_CHECKIN_SUPPRESSED_ENGINE);
    expect(payload.deliveryBasis).toBe("sleep_cycle");
    expect(message).toContain("scheduled-task spine owns morning delivery");
  });

  it("declares the canonical engine constants", () => {
    expect(MORNING_CHECKIN_OWNER_ENGINE).toBe("scheduled-task-spine");
    expect(MORNING_CHECKIN_SUPPRESSED_ENGINE).toBe(
      "reminders-domain-sleep-cycle",
    );
  });

  it("passes through optional circadian fields as undefined when absent", () => {
    reportSuppressedSleepCycleMorningCheckin({
      agentId: "agent-7",
      nowIso: "2026-08-24T09:00:00.000Z",
      timezone: "Asia/Shanghai",
    });
    const [payload] = mocks.loggerInfo.mock.calls[0];
    // `...context` spread preserves keys; absent optional fields stay
    // undefined rather than being dropped or defaulted.
    expect(payload.circadianState).toBeUndefined();
    expect(payload.wakeAt).toBeUndefined();
    expect(payload.agentId).toBe("agent-7");
  });
});
