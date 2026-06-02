import { describe, expect, it } from "vitest";
import {
  isOnboardingTrayAction,
  ONBOARDING_TRAY_ITEMS,
  trayActionToOnboardingChoice,
} from "./onboarding-intent";

describe("onboarding-intent", () => {
  it("offers local and cloud as equal first-run choices (no default)", () => {
    const choices = ONBOARDING_TRAY_ITEMS.map((i) => i.choice);
    expect(choices).toContain("local");
    expect(choices).toContain("cloud");
    // Every item carries a stable id + an i18n key.
    for (const item of ONBOARDING_TRAY_ITEMS) {
      expect(item.id).toMatch(/^onboard-/);
      expect(item.labelKey).toMatch(/^desktop\.onboarding\./);
    }
  });

  it("maps a clicked tray action id to its runtime choice", () => {
    expect(trayActionToOnboardingChoice("onboard-use-local")).toBe("local");
    expect(trayActionToOnboardingChoice("onboard-sign-in-cloud")).toBe("cloud");
  });

  it("returns null for non-onboarding tray actions", () => {
    expect(trayActionToOnboardingChoice("tray-open-chat")).toBeNull();
    expect(trayActionToOnboardingChoice("quit")).toBeNull();
  });

  it("identifies onboarding tray actions", () => {
    expect(isOnboardingTrayAction("onboard-use-local")).toBe(true);
    expect(isOnboardingTrayAction("tray-show-window")).toBe(false);
  });
});
