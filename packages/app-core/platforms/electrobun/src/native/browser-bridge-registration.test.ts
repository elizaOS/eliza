/** Exercises native-host registration plans and file lifecycle without touching browser state. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBrowserBridgeRegistrationPlan,
  installBrowserBridgeRegistration,
  resolveBrowserBridgeNativeHostExecutable,
  uninstallBrowserBridgeRegistration,
} from "./browser-bridge-registration";

const roots: string[] = [];
const chromeId = "abcdefghijklmnopabcdefghijklmnop";

describe("browser bridge registration lifecycle", () => {
  afterEach(() => {
    for (const root of roots.splice(0))
      fs.rmSync(root, { force: true, recursive: true });
  });

  it("plans exact macOS and Linux per-user manifest locations", () => {
    const mac = createBrowserBridgeRegistrationPlan({
      platform: "darwin",
      homeDir: "/Users/eliza",
      executablePath:
        "/Applications/Eliza.app/Contents/Resources/browser-bridge-native-host",
      chromeExtensionIds: [chromeId],
      firefoxExtensionIds: ["bridge@elizaos.ai"],
    });
    expect(mac.manifests.map((entry) => entry.manifestPath)).toEqual([
      "/Users/eliza/Library/Application Support/Google/Chrome/NativeMessagingHosts/ai.elizaos.browserbridge.json",
      "/Users/eliza/Library/Application Support/Mozilla/NativeMessagingHosts/ai.elizaos.browserbridge.json",
    ]);
    const linux = createBrowserBridgeRegistrationPlan({
      platform: "linux",
      homeDir: "/home/eliza",
      executablePath: "/opt/eliza/eliza-browser-bridge-host",
      chromeExtensionIds: [chromeId],
      firefoxExtensionIds: ["bridge@elizaos.ai"],
    });
    expect(linux.manifests.map((entry) => entry.manifestPath)).toEqual([
      "/home/eliza/.config/google-chrome/NativeMessagingHosts/ai.elizaos.browserbridge.json",
      "/home/eliza/.mozilla/native-messaging-hosts/ai.elizaos.browserbridge.json",
    ]);
  });

  it("resolves the dedicated packaged host instead of the desktop executable", () => {
    expect(
      resolveBrowserBridgeNativeHostExecutable(
        "/Applications/Eliza.app/Contents/Resources/bun/native",
        "darwin",
        (candidate) =>
          candidate ===
          "/Applications/Eliza.app/Contents/Resources/bun/browser-bridge-native-host",
      ),
    ).toBe(
      "/Applications/Eliza.app/Contents/Resources/bun/browser-bridge-native-host",
    );
    expect(() =>
      resolveBrowserBridgeNativeHostExecutable(
        "/tmp/native",
        "linux",
        () => false,
      ),
    ).toThrow("executable is missing");
  });

  it("writes private manifests atomically and removes only exact planned files", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-registration-"),
    );
    roots.push(root);
    const plan = createBrowserBridgeRegistrationPlan({
      platform: "linux",
      homeDir: root,
      executablePath: "/opt/eliza/eliza-browser-bridge-host",
      chromeExtensionIds: [chromeId],
      firefoxExtensionIds: ["bridge@elizaos.ai"],
    });
    installBrowserBridgeRegistration(plan);
    for (const manifest of plan.manifests) {
      expect(fs.readFileSync(manifest.manifestPath, "utf8")).toBe(
        manifest.contents,
      );
      expect(fs.statSync(manifest.manifestPath).mode & 0o777).toBe(0o600);
    }
    uninstallBrowserBridgeRegistration(plan);
    expect(
      plan.manifests.every((entry) => !fs.existsSync(entry.manifestPath)),
    ).toBe(true);
  });

  it("plans and applies exact HKCU keys through the injected Windows executor", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-registration-win-"),
    );
    roots.push(root);
    const plan = createBrowserBridgeRegistrationPlan({
      platform: "win32",
      homeDir: "C:\\Users\\eliza",
      windowsConfigDir: root,
      executablePath: "C:\\Program Files\\Eliza\\Eliza.exe",
      chromeExtensionIds: [chromeId],
      firefoxExtensionIds: ["bridge@elizaos.ai"],
    });
    const registry = { setDefaultValue: vi.fn(), deleteKey: vi.fn() };
    installBrowserBridgeRegistration(plan, registry);
    expect(registry.setDefaultValue).toHaveBeenCalledTimes(2);
    expect(registry.setDefaultValue.mock.calls.map(([key]) => key)).toEqual([
      "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\ai.elizaos.browserbridge",
      "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\ai.elizaos.browserbridge",
    ]);
    uninstallBrowserBridgeRegistration(plan, registry);
    expect(registry.deleteKey).toHaveBeenCalledTimes(2);
  });
});
