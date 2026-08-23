/** Exercises native-host registration plans and file lifecycle without touching browser state. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserBridgeRegistrationPlan,
  createBrowserBridgeRegistrationPlan,
  installBrowserBridgeRegistration,
  resolveBrowserBridgeNativeHostExecutable,
  uninstallBrowserBridgeRegistration,
} from "./browser-bridge-registration";

const roots: string[] = [];
const chromeId = "abcdefghijklmnopabcdefghijklmnop";

function requireRegistryKey(
  manifest: BrowserBridgeRegistrationPlan["manifests"][number],
): string {
  if (!manifest.windowsRegistryKey) {
    throw new Error("expected Windows registry key");
  }
  return manifest.windowsRegistryKey;
}

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
    const values = new Map<string, string>();
    const registry = {
      readDefaultValue: vi.fn((key: string) => values.get(key) ?? null),
      setDefaultValue: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
      deleteKey: vi.fn((key: string) => {
        values.delete(key);
      }),
    };
    installBrowserBridgeRegistration(plan, registry);
    expect(registry.setDefaultValue).toHaveBeenCalledTimes(2);
    expect(registry.setDefaultValue.mock.calls.map(([key]) => key)).toEqual([
      "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\ai.elizaos.browserbridge",
      "HKCU\\Software\\Mozilla\\NativeMessagingHosts\\ai.elizaos.browserbridge",
    ]);
    uninstallBrowserBridgeRegistration(plan, registry);
    expect(registry.deleteKey).toHaveBeenCalledTimes(2);
  });

  it("restores prior manifests and registry values after a partial Windows failure", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-registration-rollback-"),
    );
    roots.push(root);
    const plan = createBrowserBridgeRegistrationPlan({
      platform: "win32",
      homeDir: "C:\\Users\\eliza",
      windowsConfigDir: root,
      executablePath: "C:\\Program Files\\Eliza\\browser-host.exe",
      chromeExtensionIds: [chromeId],
      firefoxExtensionIds: ["bridge@elizaos.ai"],
    });
    const previousFiles = new Map<string, Buffer>();
    const previousDirectoryModes = new Map<string, number>();
    const registryValues = new Map<string, string>();
    for (const [index, manifest] of plan.manifests.entries()) {
      const previous = Buffer.from(`previous-${index}`);
      previousFiles.set(manifest.manifestPath, previous);
      fs.mkdirSync(path.dirname(manifest.manifestPath), { recursive: true });
      fs.chmodSync(path.dirname(manifest.manifestPath), 0o750);
      previousDirectoryModes.set(path.dirname(manifest.manifestPath), 0o750);
      fs.writeFileSync(manifest.manifestPath, previous, { mode: 0o640 });
      registryValues.set(
        requireRegistryKey(manifest),
        `C:\\previous\\${manifest.browser}.json`,
      );
    }
    let injected = false;
    const registry = {
      readDefaultValue: vi.fn((key: string) => registryValues.get(key) ?? null),
      setDefaultValue: vi.fn((key: string, value: string) => {
        registryValues.set(key, value);
        if (key.includes("Mozilla") && !injected) {
          injected = true;
          throw new Error("injected registry failure");
        }
      }),
      deleteKey: vi.fn((key: string) => {
        registryValues.delete(key);
      }),
    };

    expect(() => installBrowserBridgeRegistration(plan, registry)).toThrow(
      "injected registry failure",
    );
    for (const manifest of plan.manifests) {
      expect(fs.readFileSync(manifest.manifestPath)).toEqual(
        previousFiles.get(manifest.manifestPath),
      );
      expect(fs.statSync(manifest.manifestPath).mode & 0o777).toBe(0o640);
      expect(
        fs.statSync(path.dirname(manifest.manifestPath)).mode & 0o777,
      ).toBe(previousDirectoryModes.get(path.dirname(manifest.manifestPath)));
      expect(registryValues.get(requireRegistryKey(manifest))).toBe(
        `C:\\previous\\${manifest.browser}.json`,
      );
    }
  });

  it("removes newly created manifests and keys after a partial Windows failure", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-registration-clean-rollback-"),
    );
    roots.push(root);
    const plan = createBrowserBridgeRegistrationPlan({
      platform: "win32",
      homeDir: "C:\\Users\\eliza",
      windowsConfigDir: root,
      executablePath: "C:\\Program Files\\Eliza\\browser-host.exe",
      chromeExtensionIds: [chromeId],
      firefoxExtensionIds: [],
    });
    const registryValues = new Map<string, string>();
    let injected = false;
    const registry = {
      readDefaultValue: vi.fn(() => null),
      setDefaultValue: vi.fn((key: string, value: string) => {
        registryValues.set(key, value);
        if (!injected) {
          injected = true;
          throw new Error("injected registry failure");
        }
      }),
      deleteKey: vi.fn((key: string) => {
        registryValues.delete(key);
      }),
    };

    expect(() => installBrowserBridgeRegistration(plan, registry)).toThrow(
      "injected registry failure",
    );
    expect(registryValues.size).toBe(0);
    expect(
      plan.manifests.every((manifest) => !fs.existsSync(manifest.manifestPath)),
    ).toBe(true);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("preserves both registration and rollback failures", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-registration-double-failure-"),
    );
    roots.push(root);
    const plan = createBrowserBridgeRegistrationPlan({
      platform: "win32",
      homeDir: "C:\\Users\\eliza",
      windowsConfigDir: root,
      executablePath: "C:\\Program Files\\Eliza\\browser-host.exe",
      chromeExtensionIds: [chromeId],
      firefoxExtensionIds: [],
    });
    const primary = new Error("injected registration failure");
    const cleanup = new Error("injected rollback failure");
    const registry = {
      readDefaultValue: vi.fn(() => null),
      setDefaultValue: vi.fn(() => {
        throw primary;
      }),
      deleteKey: vi.fn(() => {
        throw cleanup;
      }),
    };

    let received: unknown;
    try {
      installBrowserBridgeRegistration(plan, registry);
    } catch (error) {
      received = error;
    }
    expect(received).toBeInstanceOf(AggregateError);
    if (!(received instanceof AggregateError)) {
      throw new Error("expected aggregate registration rollback failure");
    }
    expect(received.cause).toBe(primary);
    expect(received.errors).toEqual([primary, cleanup]);
  });

  it("does not remove a registration replaced by another installation", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-registration-owned-"),
    );
    roots.push(root);
    const plan = createBrowserBridgeRegistrationPlan({
      platform: "win32",
      homeDir: "C:\\Users\\eliza",
      windowsConfigDir: root,
      executablePath: "C:\\Program Files\\Eliza\\browser-host.exe",
      chromeExtensionIds: [chromeId],
      firefoxExtensionIds: [],
    });
    const manifest = plan.manifests[0];
    if (!manifest) throw new Error("expected Chrome registration manifest");
    fs.mkdirSync(path.dirname(manifest.manifestPath), { recursive: true });
    fs.writeFileSync(manifest.manifestPath, "newer manifest", "utf8");
    const registry = {
      readDefaultValue: vi.fn(() => manifest.manifestPath),
      setDefaultValue: vi.fn(),
      deleteKey: vi.fn(),
    };

    uninstallBrowserBridgeRegistration(plan, registry);

    expect(registry.deleteKey).not.toHaveBeenCalled();
    expect(fs.readFileSync(manifest.manifestPath, "utf8")).toBe(
      "newer manifest",
    );
  });

  it("preserves an exact manifest when the Windows registry pointer was replaced", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-registration-registry-replaced-"),
    );
    roots.push(root);
    const plan = createBrowserBridgeRegistrationPlan({
      platform: "win32",
      homeDir: "C:\\Users\\eliza",
      windowsConfigDir: root,
      executablePath: "C:\\Program Files\\Eliza\\browser-host.exe",
      chromeExtensionIds: [chromeId],
      firefoxExtensionIds: [],
    });
    const manifest = plan.manifests[0];
    if (!manifest) throw new Error("expected Chrome registration manifest");
    fs.mkdirSync(path.dirname(manifest.manifestPath), { recursive: true });
    fs.writeFileSync(manifest.manifestPath, manifest.contents, "utf8");
    const registry = {
      readDefaultValue: vi.fn(() => "C:\\OtherApp\\native-host.json"),
      setDefaultValue: vi.fn(),
      deleteKey: vi.fn(),
    };

    uninstallBrowserBridgeRegistration(plan, registry);

    expect(registry.deleteKey).not.toHaveBeenCalled();
    expect(fs.readFileSync(manifest.manifestPath, "utf8")).toBe(
      manifest.contents,
    );
  });
});
