/** Verifies Safari and desktop signing inputs resolve to one concrete access group. */

import { describe, expect, it } from "vitest";
import { macSharedKeychainHelperInvocation } from "./browser-bridge-mac-shared-secret";
import {
  browserBridgeKeychainAccessGroup,
  resolveAppleTeamId,
  resolvePackagedBrowserBridgeAccessGroup,
} from "./browser-bridge-mac-signing";

describe("browser bridge macOS signing identity", () => {
  it("uses the same concrete Team-prefixed group as Safari packaging", () => {
    const teamId = resolveAppleTeamId({
      ELECTROBUN_TEAMID: "ABCDEFGHIJ",
      ELIZA_SAFARI_SIGNING_TEAM: "ABCDEFGHIJ",
    });
    expect(teamId).toBe("ABCDEFGHIJ");
    const accessGroup = browserBridgeKeychainAccessGroup(teamId as string);
    expect(
      macSharedKeychainHelperInvocation(
        "/Applications/Eliza.app/helper",
        accessGroup,
      ).args,
    ).toContain("ABCDEFGHIJ.ai.elizaos.browserbridge.shared");
  });

  it("rejects mismatched identities and disables unsigned sharing", () => {
    expect(() =>
      resolveAppleTeamId({
        ELECTROBUN_TEAMID: "ABCDEFGHIJ",
        ELIZA_SAFARI_SIGNING_TEAM: "KLMNOPQRST",
      }),
    ).toThrow("do not match");
    expect(
      resolvePackagedBrowserBridgeAccessGroup("/tmp/native", {}, () => false),
    ).toBeNull();
  });

  it("validates packaged signing metadata before deriving the group", () => {
    expect(
      resolvePackagedBrowserBridgeAccessGroup(
        "/app/bun/native",
        {},
        (candidate) => candidate === "/app/bun/browser-bridge-signing.json",
        () => JSON.stringify({ teamId: "ABCDEFGHIJ" }),
      ),
    ).toBe("ABCDEFGHIJ.ai.elizaos.browserbridge.shared");
  });
});
