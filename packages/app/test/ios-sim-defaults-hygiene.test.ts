/**
 * Covers iOS simulator smoke-key selection and the native defaults boundary.
 */
import { describe, expect, it } from "vitest";

import {
  preferenceNativeKeys,
  readIosDefaultsString,
  selectIosSmokePreferenceKeys,
  shouldClearIosSmokePreferenceKey,
  writeIosDefaultsString,
} from "../scripts/lib/ios-sim-defaults-hygiene.mjs";

describe("iOS simulator defaults hygiene", () => {
  it("selects stale smoke, auth, first-run, and runtime keys from raw domains", () => {
    expect(
      selectIosSmokePreferenceKeys([
        "CapacitorStorage.eliza:ios-onboarding-smoke:request",
        "eliza:ios-full-bun-prewarm:result",
        "CapacitorStorage.eliza:auth-callback-smoke:result",
        "CapacitorStorage.elizaos:active-server",
        "CapacitorStorage.eliza:mobile-runtime-mode",
        "CapacitorStorage.user-visible-setting",
        "unrelated",
      ]),
    ).toEqual([
      "eliza:auth-callback-smoke:result",
      "eliza:ios-full-bun-prewarm:result",
      "eliza:ios-onboarding-smoke:request",
      "eliza:mobile-runtime-mode",
      "elizaos:active-server",
    ]);
  });

  it("does not remove ordinary app state unless it is a known lane poison", () => {
    expect(shouldClearIosSmokePreferenceKey("eliza:chat:draft")).toBe(false);
    expect(
      shouldClearIosSmokePreferenceKey("CapacitorStorage.eliza:chat:draft"),
    ).toBe(false);
    expect(shouldClearIosSmokePreferenceKey("eliza:first-run-complete")).toBe(
      true,
    );
  });

  it("deletes both CapacitorStorage-prefixed and raw native keys", () => {
    expect(preferenceNativeKeys("eliza:ios-onboarding-smoke:request")).toEqual([
      "CapacitorStorage.eliza:ios-onboarding-smoke:request",
      "eliza:ios-onboarding-smoke:request",
    ]);
  });

  it("writes both compatibility keys through the simulator-native defaults domain", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    writeIosDefaultsString(
      {
        udid: "SIM-UDID",
        bundleId: "ai.elizaos.app",
        key: "eliza:ios-full-bun-smoke:request",
        value: "1",
      },
      (command, args) => {
        calls.push({ command, args });
        return "";
      },
    );

    expect(calls).toEqual([
      {
        command: "xcrun",
        args: [
          "simctl",
          "spawn",
          "SIM-UDID",
          "defaults",
          "write",
          "ai.elizaos.app",
          "CapacitorStorage.eliza:ios-full-bun-smoke:request",
          "-string",
          "1",
        ],
      },
      {
        command: "xcrun",
        args: [
          "simctl",
          "spawn",
          "SIM-UDID",
          "defaults",
          "write",
          "ai.elizaos.app",
          "eliza:ios-full-bun-smoke:request",
          "-string",
          "1",
        ],
      },
    ]);
    expect(calls.some(({ command }) => command === "defaults")).toBe(false);
  });

  it("reads the simulator domain in Capacitor-prefix order and returns explicit absence", () => {
    const calls: string[][] = [];
    const value = readIosDefaultsString(
      {
        udid: "SIM-UDID",
        bundleId: "ai.elizaos.app",
        key: "eliza:ios-full-bun-smoke:result",
      },
      (_command, args) => {
        calls.push(args);
        return args.includes("CapacitorStorage.eliza:ios-full-bun-smoke:result")
          ? null
          : "native-result";
      },
    );

    expect(value).toBe("native-result");
    expect(calls).toHaveLength(2);
    expect(
      readIosDefaultsString(
        {
          udid: "SIM-UDID",
          bundleId: "ai.elizaos.app",
          key: "missing",
        },
        () => null,
      ),
    ).toBeNull();
  });
});
