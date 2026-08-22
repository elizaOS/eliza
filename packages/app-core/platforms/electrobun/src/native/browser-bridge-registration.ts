/**
 * Plans and applies per-user Chrome and Firefox native-host registrations for
 * packaged desktop builds; callers decide when installation is authorized.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateChromeNativeHostManifest,
  generateFirefoxNativeHostManifest,
  serializeNativeHostManifest,
} from "./browser-bridge-host-manifest";
import { BROWSER_BRIDGE_NATIVE_HOST_NAME } from "./browser-bridge-native-protocol";

export interface BrowserBridgeRegistrationPlan {
  platform: NodeJS.Platform;
  manifests: Array<{
    browser: "chrome" | "firefox";
    manifestPath: string;
    contents: string;
    windowsRegistryKey?: string;
  }>;
}

export function createBrowserBridgeRegistrationPlan(options: {
  platform: NodeJS.Platform;
  homeDir: string;
  executablePath: string;
  chromeExtensionIds: readonly string[];
  firefoxExtensionIds: readonly string[];
  windowsConfigDir?: string;
}): BrowserBridgeRegistrationPlan {
  const manifests: BrowserBridgeRegistrationPlan["manifests"] = [];
  const manifestName = `${BROWSER_BRIDGE_NATIVE_HOST_NAME}.json`;
  const windowsConfigDir =
    options.windowsConfigDir ??
    path.join(options.homeDir, "AppData", "Local", "elizaOS", "BrowserBridge");
  if (options.chromeExtensionIds.length > 0) {
    const manifestPath =
      options.platform === "darwin"
        ? path.join(
            options.homeDir,
            "Library",
            "Application Support",
            "Google",
            "Chrome",
            "NativeMessagingHosts",
            manifestName,
          )
        : options.platform === "win32"
          ? path.join(windowsConfigDir, "chrome", manifestName)
          : path.join(
              options.homeDir,
              ".config",
              "google-chrome",
              "NativeMessagingHosts",
              manifestName,
            );
    manifests.push({
      browser: "chrome",
      manifestPath,
      contents: serializeNativeHostManifest(
        generateChromeNativeHostManifest({
          executablePath: options.executablePath,
          extensionIds: options.chromeExtensionIds,
        }),
      ),
      ...(options.platform === "win32"
        ? {
            windowsRegistryKey: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${BROWSER_BRIDGE_NATIVE_HOST_NAME}`,
          }
        : {}),
    });
  }
  if (options.firefoxExtensionIds.length > 0) {
    const manifestPath =
      options.platform === "darwin"
        ? path.join(
            options.homeDir,
            "Library",
            "Application Support",
            "Mozilla",
            "NativeMessagingHosts",
            manifestName,
          )
        : options.platform === "win32"
          ? path.join(windowsConfigDir, "firefox", manifestName)
          : path.join(
              options.homeDir,
              ".mozilla",
              "native-messaging-hosts",
              manifestName,
            );
    manifests.push({
      browser: "firefox",
      manifestPath,
      contents: serializeNativeHostManifest(
        generateFirefoxNativeHostManifest({
          executablePath: options.executablePath,
          extensionIds: options.firefoxExtensionIds,
        }),
      ),
      ...(options.platform === "win32"
        ? {
            windowsRegistryKey: `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${BROWSER_BRIDGE_NATIVE_HOST_NAME}`,
          }
        : {}),
    });
  }
  return { platform: options.platform, manifests };
}

function atomicWritePrivateFile(filePath: string, contents: string): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(temporaryPath, 0o600);
  fs.renameSync(temporaryPath, filePath);
}

export interface WindowsRegistryExecutor {
  setDefaultValue(key: string, value: string): void;
  deleteKey(key: string): void;
}

export const defaultWindowsRegistryExecutor: WindowsRegistryExecutor = {
  setDefaultValue(key, value) {
    const result = spawnSync(
      "reg.exe",
      ["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.status !== 0)
      throw new Error("native-host registry update failed");
  },
  deleteKey(key) {
    const result = spawnSync("reg.exe", ["delete", key, "/f"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0 && result.status !== 1) {
      throw new Error("native-host registry removal failed");
    }
  },
};

export function installBrowserBridgeRegistration(
  plan: BrowserBridgeRegistrationPlan,
  windowsRegistry: WindowsRegistryExecutor = defaultWindowsRegistryExecutor,
): void {
  for (const manifest of plan.manifests) {
    atomicWritePrivateFile(manifest.manifestPath, manifest.contents);
    if (manifest.windowsRegistryKey) {
      windowsRegistry.setDefaultValue(
        manifest.windowsRegistryKey,
        manifest.manifestPath,
      );
    }
  }
}

export function uninstallBrowserBridgeRegistration(
  plan: BrowserBridgeRegistrationPlan,
  windowsRegistry: WindowsRegistryExecutor = defaultWindowsRegistryExecutor,
): void {
  for (const manifest of plan.manifests) {
    if (manifest.windowsRegistryKey) {
      windowsRegistry.deleteKey(manifest.windowsRegistryKey);
    }
    fs.rmSync(manifest.manifestPath, { force: true });
  }
}

export function defaultBrowserBridgeRegistrationPlan(options: {
  executablePath: string;
  chromeExtensionIds: readonly string[];
  firefoxExtensionIds: readonly string[];
}): BrowserBridgeRegistrationPlan {
  return createBrowserBridgeRegistrationPlan({
    platform: process.platform,
    homeDir: os.homedir(),
    ...options,
  });
}

export function resolveBrowserBridgeNativeHostExecutable(
  moduleDir: string,
  platform: NodeJS.Platform = process.platform,
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  const executableName = `browser-bridge-native-host${platform === "win32" ? ".exe" : ""}`;
  const candidates = [
    path.resolve(moduleDir, "..", executableName),
    path.resolve(moduleDir, "..", "..", "build", executableName),
  ];
  const resolved = candidates.find(exists);
  if (!resolved)
    throw new Error("packaged browser native-host executable is missing");
  return resolved;
}
