/** Exercises Safari app-group and shared-Keychain helper contracts without reading Keychain. */

import { describe, expect, it } from "vitest";
import {
  macSharedKeychainHelperInvocation,
  resolveMacBrowserBridgeAppGroupContainer,
  resolveMacBrowserBridgeKeychainHelper,
} from "./browser-bridge-mac-shared-secret";

describe("browser bridge macOS shared enrollment configuration", () => {
  it("uses the canonical Safari app-group container socket root", () => {
    expect(resolveMacBrowserBridgeAppGroupContainer("/Users/eliza")).toBe(
      "/Users/eliza/Library/Group Containers/group.ai.elizaos.browserbridge",
    );
  });

  it("resolves only the packaged shared-Keychain helper", () => {
    expect(
      resolveMacBrowserBridgeKeychainHelper(
        "/Applications/Eliza.app/Contents/Resources/bun/native",
        (candidate) =>
          candidate ===
          "/Applications/Eliza.app/Contents/Resources/bun/browser-bridge-keychain-helper",
      ),
    ).toBe(
      "/Applications/Eliza.app/Contents/Resources/bun/browser-bridge-keychain-helper",
    );
    expect(() =>
      resolveMacBrowserBridgeKeychainHelper("/tmp/native", () => false),
    ).toThrow("helper is missing");
  });

  it("generates the exact shared-Keychain helper invocation", () => {
    expect(
      macSharedKeychainHelperInvocation(
        "/Applications/Eliza.app/Contents/Helpers/browser-bridge-keychain-helper",
        "ABCDEFGHIJ.ai.elizaos.browserbridge.shared",
      ),
    ).toEqual({
      command:
        "/Applications/Eliza.app/Contents/Helpers/browser-bridge-keychain-helper",
      args: [
        "get-or-create",
        "--service",
        "ai.elizaos.browserbridge.native-enrollment",
        "--account",
        "native-enrollment-broker",
        "--access-group",
        "ABCDEFGHIJ.ai.elizaos.browserbridge.shared",
        "--bytes",
        "32",
      ],
    });
  });
});
