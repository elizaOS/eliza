import { describe, expect, it } from "vitest";
import {
  NIGHT_CHECKIN_LEAD_MINUTES,
  shouldRunMorningCheckinFromSleepCycle,
  shouldRunNightCheckinFromSleepCycle,
} from "../sleep-cycle-dispatch.js";

describe("sleep-cycle check-in dispatch", () => {
  it("runs the morning check-in after confirmed awake state within the wake window", () => {
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        now: new Date("2026-04-22T15:30:00.000Z"),
        state: {
          circadianState: "awake",
          wakeAt: "2026-04-22T14:00:00.000Z",
          relativeTime: { minutesUntilBedtimeTarget: 720 },
        },
      }),
    ).toBe(true);
  });

  it("does not run the morning check-in while still waking or long after wake", () => {
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        now: new Date("2026-04-22T15:30:00.000Z"),
        state: {
          circadianState: "waking",
          wakeAt: "2026-04-22T14:00:00.000Z",
          relativeTime: { minutesUntilBedtimeTarget: 720 },
        },
      }),
    ).toBe(false);
    expect(
      shouldRunMorningCheckinFromSleepCycle({
        now: new Date("2026-04-22T23:30:00.000Z"),
        state: {
          circadianState: "awake",
          wakeAt: "2026-04-22T14:00:00.000Z",
          relativeTime: { minutesUntilBedtimeTarget: 120 },
        },
      }),
    ).toBe(false);
  });

  it("runs the night check-in inside the three-hour predicted bedtime lead", () => {
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: {
          circadianState: "awake",
          wakeAt: "2026-04-22T14:00:00.000Z",
          relativeTime: {
            minutesUntilBedtimeTarget: NIGHT_CHECKIN_LEAD_MINUTES,
          },
        },
      }),
    ).toBe(true);
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: {
          circadianState: "awake",
          wakeAt: "2026-04-22T14:00:00.000Z",
          relativeTime: {
            minutesUntilBedtimeTarget: NIGHT_CHECKIN_LEAD_MINUTES + 1,
          },
        },
      }),
    ).toBe(false);
  });

  it("runs the night check-in immediately on circadianState=winding_down even when the bedtime window is hours out", () => {
    // bedtime is 8h away (480 min) — well outside NIGHT_CHECKIN_LEAD_MINUTES
    // (180 min) — but HID-idle/desktop-lock signals already classify the user
    // as winding_down, so the night summary should fire on the early signal.
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: {
          circadianState: "winding_down",
          wakeAt: "2026-04-22T14:00:00.000Z",
          relativeTime: {
            minutesUntilBedtimeTarget: 480,
          },
        },
      }),
    ).toBe(true);
  });

  it("runs the night check-in on winding_down even when no bedtime target is known (irregular owner)", () => {
    expect(
      shouldRunNightCheckinFromSleepCycle({
        state: {
          circadianState: "winding_down",
          wakeAt: null,
          relativeTime: {
            minutesUntilBedtimeTarget: null,
          },
        },
      }),
    ).toBe(true);
  });
});
