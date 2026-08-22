/** Verifies exact macOS App Group provisioning contracts without using signing identities. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { embedBrowserBridgeProvisioningProfile } from "../../scripts/postwrap-sign-runtime-macos";
import {
  resolveAppleTeamId,
  resolvePackagedBrowserBridgeAppGroup,
  validateBrowserBridgeMacProvisioningProfile,
  verifyRunningBrowserBridgeMacAuthority,
} from "./browser-bridge-mac-signing";

const profile = {
  UUID: "11111111-2222-3333-4444-555555555555",
  ExpirationDate: "2099-01-01T00:00:00.000Z",
  ProvisionsAllDevices: true,
  TeamIdentifier: ["ABCDEFGHIJ"],
  Entitlements: {
    "application-identifier": "ABCDEFGHIJ.ai.elizaos.app",
    "com.apple.security.application-groups": ["group.ai.elizaos.browserbridge"],
  },
};

describe("browser bridge macOS signing identity", () => {
  it("requires one matching Apple Team identity", () => {
    expect(
      resolveAppleTeamId({
        ELECTROBUN_TEAMID: "ABCDEFGHIJ",
        ELIZA_SAFARI_SIGNING_TEAM: "ABCDEFGHIJ",
      }),
    ).toBe("ABCDEFGHIJ");
    expect(() =>
      resolveAppleTeamId({
        ELECTROBUN_TEAMID: "ABCDEFGHIJ",
        ELIZA_SAFARI_SIGNING_TEAM: "KLMNOPQRST",
      }),
    ).toThrow("do not match");
  });

  it("validates the exact application identifier and App Group profile grants", () => {
    expect(
      validateBrowserBridgeMacProvisioningProfile(profile, {
        teamId: "ABCDEFGHIJ",
        appId: "ai.elizaos.app",
        channel: "direct",
      }),
    ).toEqual({
      teamId: "ABCDEFGHIJ",
      appId: "ai.elizaos.app",
      applicationIdentifier: "ABCDEFGHIJ.ai.elizaos.app",
      appGroup: "group.ai.elizaos.browserbridge",
      profileUuid: "11111111-2222-3333-4444-555555555555",
    });
    expect(() =>
      validateBrowserBridgeMacProvisioningProfile(profile, {
        teamId: "ABCDEFGHIJ",
        appId: "ai.elizaos.other",
        channel: "direct",
      }),
    ).toThrow("does not authorize");
    expect(() =>
      validateBrowserBridgeMacProvisioningProfile(profile, {
        teamId: "ABCDEFGHIJ",
        appId: "ai.elizaos.app",
        channel: "store",
      }),
    ).toThrow("does not authorize");
  });

  it("enables runtime sharing only from complete packaged profile metadata", () => {
    expect(
      resolvePackagedBrowserBridgeAppGroup("/tmp/native", () => false),
    ).toBeNull();
    expect(
      resolvePackagedBrowserBridgeAppGroup(
        "/app/bun/native",
        (candidate) => candidate === "/app/bun/browser-bridge-signing.json",
        () =>
          JSON.stringify({
            teamId: "ABCDEFGHIJ",
            appId: "ai.elizaos.app",
            applicationIdentifier: "ABCDEFGHIJ.ai.elizaos.app",
            appGroup: "group.ai.elizaos.browserbridge",
            profileUuid: "11111111-2222-3333-4444-555555555555",
          }),
      ),
    ).toBe("group.ai.elizaos.browserbridge");
  });

  it("binds runtime activation to the live signed bundle and embedded profile", () => {
    const metadata = JSON.stringify({
      teamId: "ABCDEFGHIJ",
      appId: "ai.elizaos.app",
      applicationIdentifier: "ABCDEFGHIJ.ai.elizaos.app",
      appGroup: "group.ai.elizaos.browserbridge",
      profileUuid: "11111111-2222-3333-4444-555555555555",
    });
    const exists = (candidate: string) =>
      candidate === "/app/bun/browser-bridge-signing.json" ||
      candidate ===
        "/Applications/Eliza.app/Contents/embedded.provisionprofile";
    const run = (_command: string, args: string[]) => {
      if (args[0] === "--verify") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "cms") {
        return {
          status: 0,
          stdout:
            "<string>11111111-2222-3333-4444-555555555555</string>" +
            "<string>ABCDEFGHIJ.ai.elizaos.app</string>" +
            "<string>group.ai.elizaos.browserbridge</string>",
          stderr: "",
        };
      }
      return {
        status: 0,
        stdout:
          "Identifier=ai.elizaos.app\nTeamIdentifier=ABCDEFGHIJ\n" +
          "ABCDEFGHIJ.ai.elizaos.app\ngroup.ai.elizaos.browserbridge",
        stderr: "",
      };
    };
    expect(
      verifyRunningBrowserBridgeMacAuthority(
        "/app/bun/native",
        "/Applications/Eliza.app",
        { exists, readFile: () => metadata, run },
      ),
    ).toBe("group.ai.elizaos.browserbridge");
    expect(() =>
      verifyRunningBrowserBridgeMacAuthority(
        "/app/bun/native",
        "/Applications/Eliza.app",
        {
          exists,
          readFile: () => metadata,
          run: (command, args) => {
            const result = run(command, args);
            return args[0] === "-dvv"
              ? {
                  ...result,
                  stdout: result.stdout.replace("ABCDEFGHIJ", "KLMNOPQRST"),
                }
              : result;
          },
        },
      ),
    ).toThrow("does not match");
  });

  it("embeds the validated profile at the macOS bundle authority path", () => {
    const bundle = fs.mkdtempSync(path.join(os.tmpdir(), "browser-profile-"));
    try {
      const resources = path.join(bundle, "Contents", "Resources", "app");
      fs.mkdirSync(resources, { recursive: true });
      fs.writeFileSync(
        path.join(resources, "browser-bridge.provisionprofile"),
        "profile",
      );
      fs.writeFileSync(
        path.join(resources, "browser-bridge-signing.json"),
        "{}",
      );
      expect(embedBrowserBridgeProvisioningProfile(bundle)).toBe(true);
      expect(
        fs.readFileSync(
          path.join(bundle, "Contents", "embedded.provisionprofile"),
          "utf8",
        ),
      ).toBe("profile");
    } finally {
      fs.rmSync(bundle, { recursive: true, force: true });
    }
  });
});
