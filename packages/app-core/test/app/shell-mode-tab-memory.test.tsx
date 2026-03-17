import type { Tab } from "@elizaos/app-core/navigation";
import { describe, expect, it } from "vitest";
import {
  deriveUiShellModeForTab,
  getTabForShellView,
  shouldStartAtCharacterSelectOnLaunch,
} from "../../src/state/shell-routing";

describe("shell routing helpers", () => {
  it("derives companion mode only for the companion tab", () => {
    expect(deriveUiShellModeForTab("chat")).toBe("native");
    expect(deriveUiShellModeForTab("character-select")).toBe("native");
    expect(deriveUiShellModeForTab("settings")).toBe("native");
    expect(deriveUiShellModeForTab("companion")).toBe("companion");
  });

  it("maps shell view toggles onto a single canonical tab target", () => {
    expect(getTabForShellView("companion", "chat")).toBe("companion");
    expect(getTabForShellView("character", "chat")).toBe("character-select");
    expect(getTabForShellView("desktop", "settings")).toBe("settings");
  });

  it("starts completed launches on character select for chat-like entry routes", () => {
    const entryRoutes: Array<{ navPath: string; urlTab: Tab | null }> = [
      { navPath: "/", urlTab: "chat" },
      { navPath: "/chat", urlTab: "chat" },
      { navPath: "/companion", urlTab: "companion" },
    ];

    for (const entryRoute of entryRoutes) {
      expect(
        shouldStartAtCharacterSelectOnLaunch({
          onboardingNeedsOptions: false,
          navPath: entryRoute.navPath,
          urlTab: entryRoute.urlTab,
        }),
      ).toBe(true);
    }
  });

  it("keeps explicit desktop routes and incomplete onboarding out of character-select auto-launch", () => {
    expect(
      shouldStartAtCharacterSelectOnLaunch({
        onboardingNeedsOptions: false,
        navPath: "/settings",
        urlTab: "settings",
      }),
    ).toBe(false);

    expect(
      shouldStartAtCharacterSelectOnLaunch({
        onboardingNeedsOptions: true,
        navPath: "/chat",
        urlTab: "chat",
      }),
    ).toBe(false);
  });
});
