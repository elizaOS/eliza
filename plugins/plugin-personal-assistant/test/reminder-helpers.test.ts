// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import {
  _isReminderIntensity,
  coerceReminderIntensity,
  isReminderChannel,
  isReminderReviewClosed,
  mapPlatformToReminderChannel,
  normalizeActivitySignalSource,
  normalizeActivitySignalState,
  normalizeOptionalIdleState,
  normalizeReminderIntensityInput,
  readReminderReviewAt,
} from "../src/lifeops/service-helpers-reminder.js";

/**
 * Reminder field normalizers gate untrusted input into the scheduling engine
 * (#8795). Enum-like fields must canonicalize known aliases and reject
 * everything else (400) rather than passing a bogus value to delivery routing.
 */

describe("intensity", () => {
  it("recognizes and canonicalizes intensity, rejecting junk", () => {
    expect(_isReminderIntensity("normal")).toBe(true);
    expect(_isReminderIntensity("loud")).toBe(false);
    expect(_isReminderIntensity(5)).toBe(false);
    expect(normalizeReminderIntensityInput("NORMAL", "i")).toBe("normal");
    expect(normalizeReminderIntensityInput("persistent", "i")).toBe(
      "persistent",
    );
    expect(() => normalizeReminderIntensityInput("loud", "i")).toThrow();
    expect(coerceReminderIntensity("", "i")).toBeNull();
    expect(coerceReminderIntensity(null, "i")).toBeNull();
    expect(coerceReminderIntensity("minimal", "i")).toBe("minimal");
  });
});

describe("channel", () => {
  it("recognizes reminder channels and maps platforms", () => {
    expect(isReminderChannel("in_app")).toBe(true);
    expect(isReminderChannel("discord")).toBe(true);
    expect(isReminderChannel("carrier_pigeon")).toBe(false);
    expect(isReminderChannel(5)).toBe(false);
    expect(mapPlatformToReminderChannel("client_chat")).toBe("in_app");
    expect(mapPlatformToReminderChannel("")).toBeNull();
    expect(mapPlatformToReminderChannel(null)).toBeNull();
  });
});

describe("activity signal", () => {
  it("normalizes source aliases and rejects unknowns", () => {
    expect(normalizeActivitySignalSource("app_lifecycle", "s")).toBe(
      "app_lifecycle",
    );
    expect(normalizeActivitySignalSource("mobile-device", "s")).toBe(
      "mobile_device",
    );
    expect(normalizeActivitySignalSource("mobileHealth", "s")).toBe(
      "mobile_health",
    );
    expect(() => normalizeActivitySignalSource("ouija", "s")).toThrow();
  });

  it("normalizes state ('sleep' → 'sleeping') and idle state", () => {
    expect(normalizeActivitySignalState("active", "st")).toBe("active");
    expect(normalizeActivitySignalState("sleep", "st")).toBe("sleeping");
    expect(() => normalizeActivitySignalState("bogus", "st")).toThrow();
    expect(normalizeOptionalIdleState("", "id")).toBeNull();
    expect(normalizeOptionalIdleState("locked", "id")).toBe("locked");
    expect(() => normalizeOptionalIdleState("spinning", "id")).toThrow();
  });
});

describe("review attempt reads", () => {
  it("reads a valid reviewAt and null for invalid/closed status", () => {
    expect(readReminderReviewAt({ reviewAt: "2026-06-23T00:00:00.000Z" })).toBe(
      "2026-06-23T00:00:00.000Z",
    );
    expect(readReminderReviewAt({ reviewAt: "not-a-date" })).toBeNull();
    expect(readReminderReviewAt({ reviewAt: null })).toBeNull();
    expect(isReminderReviewClosed({ reviewStatus: "resolved" })).toBe(true);
    expect(isReminderReviewClosed({ reviewStatus: "escalated" })).toBe(true);
    expect(isReminderReviewClosed({ reviewStatus: "pending" })).toBe(false);
    expect(isReminderReviewClosed({ reviewStatus: null })).toBe(false);
  });
});
