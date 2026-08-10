/** Locks the macOS permission plist metadata and dev-signing lifecycle hook used by real Electrobun bundles. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import electrobunConfig from "../electrobun.config";
import {
  createAdhocDesignatedRequirement,
  localCodeSignIdentifier,
} from "../scripts/local-adhoc-sign-macos";
import { ensureMacPermissionUsageDescriptions } from "../scripts/postwrap-diagnostics";
import { shouldSignDevMacApp } from "../scripts/sign-dev-macos-app";

const temporaryRoots: string[] = [];

function createAppBundle(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-mac-plist-"));
  temporaryRoots.push(root);
  const appBundle = path.join(root, "Eliza-dev.app");
  const contents = path.join(appBundle, "Contents");
  fs.mkdirSync(contents, { recursive: true });
  fs.writeFileSync(
    path.join(contents, "Info.plist"),
    '<?xml version="1.0"?><plist version="1.0"><dict>\n</dict></plist>\n',
  );
  return appBundle;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("macOS permission bundle preparation", () => {
  it("adds permission usage descriptions idempotently", () => {
    const appBundle = createAppBundle();

    expect(ensureMacPermissionUsageDescriptions(appBundle, "macos")).toContain(
      "NSAppleEventsUsageDescription",
    );
    expect(ensureMacPermissionUsageDescriptions(appBundle, "macos")).toEqual(
      [],
    );

    const plist = fs.readFileSync(
      path.join(appBundle, "Contents", "Info.plist"),
      "utf8",
    );
    expect(plist).toContain("<key>NSAppleEventsUsageDescription</key>");
  });

  it("runs local signing only for unsigned macOS dev packages", () => {
    expect(
      shouldSignDevMacApp(
        {
          ELECTROBUN_BUILD_ENV: "dev",
          ELECTROBUN_OS: "macos",
          ELECTROBUN_SKIP_CODESIGN: "1",
        },
        "darwin",
      ),
    ).toBe(true);
    expect(
      shouldSignDevMacApp(
        {
          ELECTROBUN_BUILD_ENV: "stable",
          ELECTROBUN_OS: "macos",
          ELECTROBUN_SKIP_CODESIGN: "1",
        },
        "darwin",
      ),
    ).toBe(false);
    expect(electrobunConfig.scripts?.postPackage).toBe(
      "scripts/sign-dev-macos-app.ts",
    );
    expect(electrobunConfig.build?.mac?.entitlements).toMatchObject({
      "com.apple.security.device.audio-input": true,
    });
    expect(electrobunConfig.build?.mac?.entitlements).not.toHaveProperty(
      "com.apple.security.device.microphone",
    );
    expect(createAdhocDesignatedRequirement("ai.elizaos.app")).toBe(
      '=designated => identifier "ai.elizaos.app"',
    );
    const appBundle = "/tmp/Eliza-dev.app";
    expect(
      localCodeSignIdentifier(
        appBundle,
        `${appBundle}/Contents/MacOS/bun`,
        "ai.elizaos.app",
      ),
    ).toBe("ai.elizaos.app");
    expect(
      localCodeSignIdentifier(
        appBundle,
        `${appBundle}/Contents/MacOS/zig-zstd`,
        "ai.elizaos.app",
      ),
    ).toBe("ai.elizaos.app.helper.contents-macos-zig-zstd");
  });
});
