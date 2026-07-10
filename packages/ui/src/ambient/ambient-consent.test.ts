/**
 * Unit tests for the per-session ambient consent gate.
 */

import { describe, expect, it } from "vitest";
import {
  AMBIENT_CONSENT_AFFIRMATION,
  AMBIENT_TWO_PARTY_REMINDER,
  ambientCaptureAllowed,
  ambientConsentAffirmation,
  ambientConsentReducer,
} from "./ambient-consent";

describe("ambient consent gate", () => {
  it("starts ungranted and blocks capture", () => {
    expect(ambientCaptureAllowed("ungranted")).toBe(false);
  });

  it("grant permits capture", () => {
    const next = ambientConsentReducer("ungranted", "grant");
    expect(next).toBe("granted");
    expect(ambientCaptureAllowed(next)).toBe(true);
  });

  it("revoke re-blocks capture (per-session reset)", () => {
    const granted = ambientConsentReducer("ungranted", "grant");
    const revoked = ambientConsentReducer(granted, "revoke");
    expect(revoked).toBe("ungranted");
    expect(ambientCaptureAllowed(revoked)).toBe(false);
  });

  it("exposes non-empty consent + two-party copy", () => {
    expect(AMBIENT_CONSENT_AFFIRMATION.length).toBeGreaterThan(0);
    expect(AMBIENT_TWO_PARTY_REMINDER.toLowerCase()).toContain("consent");
  });

  it("words the affirmation per processing path without contradiction", () => {
    const cloud = ambientConsentAffirmation("cloud");
    const local = ambientConsentAffirmation("on-device");
    // Cloud copy claims cloud and never claims on-device, and vice versa.
    expect(cloud.toLowerCase()).toContain("cloud");
    expect(cloud.toLowerCase()).not.toContain("on this device");
    expect(local.toLowerCase()).toContain("on this device");
    expect(local.toLowerCase()).not.toContain("cloud");
  });
});
