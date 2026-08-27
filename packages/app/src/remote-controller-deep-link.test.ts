import { describe, expect, it } from "vitest";
import { isRemoteControllerPairingRuntimeAllowed } from "./remote-controller-deep-link";

describe("remote controller claim runtime guard", () => {
  it("allows native iOS without Electrobun or Linux", () => {
    expect(
      isRemoteControllerPairingRuntimeAllowed({
        native: true,
        nativePlatform: "ios",
      }),
    ).toBe(true);
  });

  it.each([
    { native: false, nativePlatform: "web" },
    { native: true, nativePlatform: "android" },
    { isElectrobun: true, navigatorPlatform: "MacIntel", native: false },
    { isElectrobun: true, navigatorPlatform: "Linux x86_64", native: false },
  ])("enforces platform guard: $nativePlatform/$navigatorPlatform", (input) => {
    expect(isRemoteControllerPairingRuntimeAllowed(input)).toBe(
      input.navigatorPlatform?.includes("Linux") ?? false,
    );
  });
});
