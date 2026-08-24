import { describe, expect, it } from "vitest";
import {
  getCurrentEnforcementWindow,
  isWithinEnforcementWindow,
  minutesPastWindowStart,
} from "./enforcement-windows.ts";

// 用 UTC 时间（Intl 固定时区——可预测）
function utcDate(hour: number, minute = 0): Date {
  const d = new Date(Date.UTC(2026, 7, 24, hour, minute));
  return d;
}

const MORNING = {
  kind: "morning",
  startMinute: 6 * 60,
  endMinute: 10 * 60,
} as const;

describe("getCurrentEnforcementWindow", () => {
  it("returns the morning window inside it", () => {
    const w = getCurrentEnforcementWindow(utcDate(8), "UTC");
    expect(w.kind).toBe("morning");
  });

  it("returns the night window inside it", () => {
    const w = getCurrentEnforcementWindow(utcDate(22), "UTC");
    expect(w.kind).toBe("night");
  });

  it("returns none outside all windows", () => {
    const w = getCurrentEnforcementWindow(utcDate(12), "UTC");
    expect(w.kind).toBe("none");
  });
});

describe("isWithinEnforcementWindow", () => {
  it("detects inside/outside", () => {
    expect(isWithinEnforcementWindow(utcDate(7), "UTC", MORNING)).toBe(true);
    expect(isWithinEnforcementWindow(utcDate(11), "UTC", MORNING)).toBe(false);
    expect(isWithinEnforcementWindow(utcDate(10), "UTC", MORNING)).toBe(false); // end exclusive
  });
});

describe("minutesPastWindowStart", () => {
  it("counts minutes inside the window", () => {
    expect(minutesPastWindowStart(utcDate(7, 30), "UTC", MORNING)).toBe(90);
  });

  it("returns 0 outside the window", () => {
    expect(minutesPastWindowStart(utcDate(12), "UTC", MORNING)).toBe(0);
  });

  it("handles wrapping windows", () => {
    const night = {
      kind: "night",
      startMinute: 22 * 60,
      endMinute: 2 * 60,
    } as const;
    // 23:00 —— 窗口内（22:00 后 60 分钟）
    expect(minutesPastWindowStart(utcDate(23), "UTC", night)).toBe(60);
    // 01:00 —— 跨天（22:00 → 24:00 是 120 分钟 + 01:00 是 60 分钟 = 180）
    expect(minutesPastWindowStart(utcDate(1), "UTC", night)).toBe(180);
  });
});
