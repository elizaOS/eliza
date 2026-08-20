import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(
    new URL(".", import.meta.url).pathname,
    "../ios/Sources/SecureStorePlugin/SecureStorePlugin.swift",
  ),
  "utf8",
).replace(/\s+/g, " ");

describe("Apple secure-store bridge contract", () => {
  it("uses a fixed app-only, non-synchronizing Keychain namespace", () => {
    expect(source).toContain('service = "ai.elizaos.secure-store"');
    expect(source).toContain(
      "kSecAttrSynchronizable as String: kCFBooleanFalse",
    );
    expect(source).not.toContain("kSecAttrAccessGroup");
  });

  it("makes values device-only and usable after first unlock", () => {
    expect(source).toContain(
      "kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly",
    );
  });

  it("allowlists accounts and never accepts an arbitrary service", () => {
    for (const key of [
      "session.device_auth",
      "session.steward_token",
      "runtime.active_server",
      "runtime.agent_profiles",
    ]) {
      expect(source).toContain(`"${key}"`);
    }
    expect(source).toContain("allowedKeys.contains(key)");
    expect(source).not.toContain('call.getString("service")');
  });

  it("does not grant Keychain Sharing to the app or its extensions", () => {
    const iosAppRoot = resolve(
      new URL(".", import.meta.url).pathname,
      "../../../packages/app-core/platforms/ios/App/App",
    );
    const entitlementPaths = [
      resolve(iosAppRoot, "App.entitlements"),
      ...readdirSync(iosAppRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
          resolve(iosAppRoot, entry.name, `${entry.name}.entitlements`),
        )
        .filter((filePath) => {
          try {
            readFileSync(filePath);
            return true;
          } catch {
            return false;
          }
        }),
    ];
    expect(entitlementPaths.length).toBeGreaterThan(1);
    for (const filePath of entitlementPaths) {
      expect(readFileSync(filePath, "utf8")).not.toContain(
        "keychain-access-groups",
      );
    }
  });
});
