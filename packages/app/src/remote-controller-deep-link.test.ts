/** Deterministically exercises the platform admission boundary for controller claims. */

import { describe, expect, it } from "vitest";
import { isRemoteControllerPairingRuntimeAllowed } from "./remote-controller-deep-link";

describe("remote controller claim runtime guard", () => {
  it("allows native iOS without Electrobun or Linux", () => {
    expect(
      isRemoteControllerPairingRuntimeAllowed({
        native: true,
        nativePlatform: "ios",
        nativePluginAvailable: true,
        isElectrobun: false,
        navigatorPlatform: "iPhone",
      }),
    ).toBe(true);
  });

  it.each([
    {
      native: false,
      nativePlatform: "web",
      nativePluginAvailable: false,
      isElectrobun: false,
      navigatorPlatform: "",
    },
    {
      native: true,
      nativePlatform: "android",
      nativePluginAvailable: true,
      isElectrobun: false,
      navigatorPlatform: "Linux armv8",
    },
    {
      native: true,
      nativePlatform: "ios",
      nativePluginAvailable: false,
      isElectrobun: false,
      navigatorPlatform: "iPhone",
    },
    {
      isElectrobun: true,
      navigatorPlatform: "MacIntel",
      native: false,
      nativePlatform: "web",
      nativePluginAvailable: false,
    },
    {
      isElectrobun: true,
      navigatorPlatform: "Linux x86_64",
      native: false,
      nativePlatform: "web",
      nativePluginAvailable: false,
    },
  ])("enforces platform guard: $nativePlatform/$navigatorPlatform", (input) => {
    expect(isRemoteControllerPairingRuntimeAllowed(input)).toBe(
      input.isElectrobun && input.navigatorPlatform.includes("Linux"),
    );
  });
});
