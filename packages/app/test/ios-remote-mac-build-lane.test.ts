/** Verifies the canonical iOS Simulator build that connects to a Mac runtime. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

interface AppPackageJson {
  scripts: Record<string, string>;
}

const packageJson = JSON.parse(
  readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as AppPackageJson;

describe("iOS remote-Mac Simulator build lane", () => {
  it("pins the direct APNs-off renderer to the owned host relay", () => {
    const command = packageJson.scripts["build:ios:remote-mac:sim"];

    expect(command).toBeDefined();
    expect(command).toContain("ELIZA_BUILD_VARIANT=direct");
    expect(command).toContain("ELIZA_RELEASE_AUTHORITY=developer-toolchain");
    expect(command).toContain("ELIZA_IOS_APP_STORE_LOCAL_RUNTIME=0");
    expect(command).toContain("VITE_ELIZA_IOS_RUNTIME_MODE=remote-mac");
    expect(command).toContain("VITE_ELIZA_IOS_API_BASE=http://127.0.0.1:31338");
    expect(command).toContain("VITE_ELIZA_APNS_ENABLED=0");
    expect(command).toContain("generic/platform=iOS Simulator");
    expect(command).toContain("ELIZA_IOS_BUILD_SDK=iphonesimulator");
    expect(command).not.toContain("API_TOKEN");
    expect(command).not.toContain("apple-app-store");
  });
});
