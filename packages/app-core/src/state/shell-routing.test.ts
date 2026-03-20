import { describe, expect, it } from "vitest";
import {
  getTabForShellView,
  shouldStartAtCharacterSelectOnLaunch,
} from "./shell-routing";

describe("shouldStartAtCharacterSelectOnLaunch", () => {
  const baseParams = {
    onboardingNeedsOptions: false,
    onboardingMode: "basic" as const,
    navPath: "/",
    urlTab: null,
  };

  it("always returns false (character-select auto-redirect is disabled)", () => {
    expect(shouldStartAtCharacterSelectOnLaunch(baseParams)).toBe(false);
  });

  it("returns false even when onboarding does not need options", () => {
    expect(
      shouldStartAtCharacterSelectOnLaunch({
        ...baseParams,
        onboardingNeedsOptions: false,
      }),
    ).toBe(false);
  });

  it("returns false when onboardingMode is elizacloudonly", () => {
    expect(
      shouldStartAtCharacterSelectOnLaunch({
        ...baseParams,
        onboardingMode: "elizacloudonly",
      }),
    ).toBe(false);
  });

  it("returns false when onboardingNeedsOptions is true", () => {
    expect(
      shouldStartAtCharacterSelectOnLaunch({
        ...baseParams,
        onboardingNeedsOptions: true,
      }),
    ).toBe(false);
  });

  it("returns false regardless of navPath", () => {
    expect(
      shouldStartAtCharacterSelectOnLaunch({
        ...baseParams,
        navPath: "/companion",
      }),
    ).toBe(false);
  });

  it("returns false regardless of urlTab", () => {
    expect(
      shouldStartAtCharacterSelectOnLaunch({
        ...baseParams,
        urlTab: "chat",
      }),
    ).toBe(false);
  });
});

describe("getTabForShellView", () => {
  it("returns companion for companion view", () => {
    expect(getTabForShellView("companion", "chat")).toBe("companion");
  });

  it("returns character for character view (not character-select)", () => {
    const result = getTabForShellView("character", "chat");
    expect(result).toBe("character");
    expect(result).not.toBe("character-select");
  });

  it("returns the lastNativeTab for desktop view", () => {
    expect(getTabForShellView("desktop", "chat")).toBe("chat");
    expect(getTabForShellView("desktop", "plugins")).toBe("plugins");
    expect(getTabForShellView("desktop", "wallets")).toBe("wallets");
  });

  it("uses whatever lastNativeTab is passed for desktop view", () => {
    expect(getTabForShellView("desktop", "knowledge")).toBe("knowledge");
  });
});
