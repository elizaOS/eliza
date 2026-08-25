import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CALENDAR_TIME_ZONE_ALIASES,
  DEFAULT_CALENDAR_REMINDER_STEPS,
  DEFAULT_NEXT_EVENT_LOOKAHEAD_DAYS,
  GOOGLE_GMAIL_READ_SCOPE,
  GOOGLE_PRIMARY_CALENDAR_ID,
  isValidTimeZone,
  resolveDefaultTimeZone,
} from "./constants";

describe("isValidTimeZone", () => {
  it("accepts known IANA zones", () => {
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Europe/Berlin")).toBe(true);
    expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
  });

  it("rejects unknown or malformed zone strings", () => {
    expect(isValidTimeZone("Not/A_Zone")).toBe(false);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });

  it("rejects empty strings", () => {
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone("   ")).toBe(false);
  });

  it("treats undefined as the default zone (Intl coercion)", () => {
    // Intl treats timeZone: undefined as "use the environment default", so the
    // guard accepts it — pinned here so callers relying on strict rejection
    // of undefined know the current contract.
    expect(isValidTimeZone(undefined as unknown as string)).toBe(true);
  });
});

describe("CALENDAR_TIME_ZONE_ALIASES", () => {
  it("maps US abbreviations to canonical IANA zones", () => {
    expect(CALENDAR_TIME_ZONE_ALIASES["pst"]).toBe("America/Los_Angeles");
    expect(CALENDAR_TIME_ZONE_ALIASES["pdt"]).toBe("America/Los_Angeles");
    expect(CALENDAR_TIME_ZONE_ALIASES["pt"]).toBe("America/Los_Angeles");
    expect(CALENDAR_TIME_ZONE_ALIASES["pacific"]).toBe("America/Los_Angeles");
    expect(CALENDAR_TIME_ZONE_ALIASES["est"]).toBe("America/New_York");
    expect(CALENDAR_TIME_ZONE_ALIASES["et"]).toBe("America/New_York");
    expect(CALENDAR_TIME_ZONE_ALIASES["cst"]).toBe("America/Chicago");
    expect(CALENDAR_TIME_ZONE_ALIASES["mst"]).toBe("America/Denver");
  });

  it("maps gmt to utc", () => {
    expect(CALENDAR_TIME_ZONE_ALIASES["gmt"]).toBe("UTC");
    expect(CALENDAR_TIME_ZONE_ALIASES["utc"]).toBe("UTC");
  });

  it("every alias value resolves to a valid IANA zone", () => {
    for (const zone of Object.values(CALENDAR_TIME_ZONE_ALIASES)) {
      expect(isValidTimeZone(zone), `alias target ${zone}`).toBe(true);
    }
  });

  it("alias keys are stored lowercase", () => {
    for (const key of Object.keys(CALENDAR_TIME_ZONE_ALIASES)) {
      expect(key).toBe(key.toLowerCase());
    }
  });
});

describe("resolveDefaultTimeZone", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the environment-resolved zone when present", () => {
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: () => ({
        resolvedOptions: () => ({ timeZone: "Europe/Paris" }),
      }),
    });
    expect(resolveDefaultTimeZone()).toBe("Europe/Paris");
  });

  it("falls back to UTC when the resolved zone is empty or whitespace", () => {
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: "  " }) }),
    });
    expect(resolveDefaultTimeZone()).toBe("UTC");
  });

  it("propagates Intl resolution failures (no silent fallback)", () => {
    // Current contract: if Intl.DateTimeFormat throws, the error is NOT caught
    // — it propagates to the caller instead of returning "UTC". Pinned so a
    // future change either keeps or intentionally alters this behavior.
    vi.stubGlobal("Intl", {
      ...Intl,
      DateTimeFormat: () => ({
        resolvedOptions() {
          throw new RangeError("zone unavailable");
        },
      }),
    });
    expect(() => resolveDefaultTimeZone()).toThrow(RangeError);
  });
});

describe("calendar constants", () => {
  it("exposes the primary calendar id and lookahead", () => {
    expect(GOOGLE_PRIMARY_CALENDAR_ID).toBe("primary");
    expect(DEFAULT_NEXT_EVENT_LOOKAHEAD_DAYS).toBe(30);
    expect(GOOGLE_GMAIL_READ_SCOPE).toBe(
      "https://www.googleapis.com/auth/gmail.readonly",
    );
  });

  it("default reminder steps carry an in-app channel and positive offset", () => {
    expect(DEFAULT_CALENDAR_REMINDER_STEPS).toHaveLength(1);
    const step = DEFAULT_CALENDAR_REMINDER_STEPS[0];
    expect(step.channel).toBe("in_app");
    expect(step.offsetMinutes).toBeGreaterThan(0);
    expect(step.label.length).toBeGreaterThan(0);
  });
});
