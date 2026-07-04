/**
 * Unit coverage for the toast helpers in `action-notice`: priority→tone mapping
 * and the canonical `TOAST_TTL_MS` timing values the shell surfaces rely on.
 * Pure functions, no harness.
 */
import type { NotificationPriority } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { TOAST_TTL_MS, toastToneForPriority } from "./action-notice";

describe("toastToneForPriority", () => {
  it("maps urgent to the error tone", () => {
    expect(toastToneForPriority("urgent")).toBe("error");
  });

  it("maps every non-urgent priority to the info tone", () => {
    const nonUrgent: NotificationPriority[] = ["low", "normal", "high"];
    for (const priority of nonUrgent) {
      expect(toastToneForPriority(priority)).toBe("info");
    }
  });
});

describe("TOAST_TTL_MS", () => {
  it("orders dwell times from quickest confirmation to longest banner", () => {
    expect(TOAST_TTL_MS.default).toBeLessThan(TOAST_TTL_MS.notification);
    expect(TOAST_TTL_MS.notification).toBeLessThan(
      TOAST_TTL_MS.notificationInterruptive,
    );
    expect(TOAST_TTL_MS.notificationInterruptive).toBeLessThan(
      TOAST_TTL_MS.systemWarning,
    );
  });

  it("keeps the historical millisecond values the surfaces relied on", () => {
    expect(TOAST_TTL_MS.default).toBe(2800);
    expect(TOAST_TTL_MS.notification).toBe(4000);
    expect(TOAST_TTL_MS.notificationInterruptive).toBe(7000);
    expect(TOAST_TTL_MS.systemWarning).toBe(20_000);
  });
});
