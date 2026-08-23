/**
 * Plans and applies per-user Chrome and Firefox native-host registrations for
 * packaged desktop builds; callers decide when installation is authorized.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
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

function atomicWritePrivateFile(
  filePath: string,
  contents: string | Uint8Array,
  mode = 0o600,
): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    if (typeof contents === "string") {
      fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", mode });
    } else {
      fs.writeFileSync(temporaryPath, contents, { mode });
    }
    fs.chmodSync(temporaryPath, mode);
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    // error-policy:J2 preserve both the write failure and a failed temporary-file cleanup.
    try {
      fs.rmSync(temporaryPath, { force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "native-host manifest write and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}

export interface WindowsRegistryExecutor {
  readDefaultValue(key: string): string | null;
  setDefaultValue(key: string, value: string): void;
  deleteKey(key: string): void;
}

export const defaultWindowsRegistryExecutor: WindowsRegistryExecutor = {
  readDefaultValue(key) {
    const result = spawnSync("reg.exe", ["query", key, "/ve"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status === 1) return null;
    if (result.status !== 0)
      throw new Error("native-host registry query failed");
    const match = result.stdout.match(/\sREG_SZ\s+(.*?)(?:\r?\n|$)/);
    if (!match)
      throw new Error("native-host registry query returned an invalid value");
    return match[1] ?? "";
  },
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

interface ManifestDirectorySnapshot {
  directoryPath: string;
  previousMode: number | null;
  missingDirectories: string[];
}

function snapshotManifestDirectory(
  filePath: string,
): ManifestDirectorySnapshot {
  const directoryPath = path.dirname(filePath);
  if (fs.existsSync(directoryPath)) {
    return {
      directoryPath,
      previousMode: fs.statSync(directoryPath).mode & 0o777,
      missingDirectories: [],
    };
  }
  const missingDirectories: string[] = [];
  let current = directoryPath;
  while (!fs.existsSync(current)) {
    missingDirectories.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { directoryPath, previousMode: null, missingDirectories };
}

function restoreManifestDirectory(snapshot: ManifestDirectorySnapshot): void {
  if (snapshot.previousMode !== null) {
    fs.chmodSync(snapshot.directoryPath, snapshot.previousMode);
    return;
  }
  for (const directory of snapshot.missingDirectories) {
    try {
      fs.rmdirSync(directory);
    } catch (error) {
      // error-policy:J6 another registration or concurrent writer may still own the directory.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTEMPTY") throw error;
    }
  }
}

export function installBrowserBridgeRegistration(
  plan: BrowserBridgeRegistrationPlan,
  windowsRegistry: WindowsRegistryExecutor = defaultWindowsRegistryExecutor,
): void {
  const snapshots = plan.manifests.map((manifest) => ({
    manifest,
    file: fs.existsSync(manifest.manifestPath)
      ? {
          contents: fs.readFileSync(manifest.manifestPath),
          mode: fs.statSync(manifest.manifestPath).mode & 0o777,
        }
      : null,
    directory: snapshotManifestDirectory(manifest.manifestPath),
    registryValue: manifest.windowsRegistryKey
      ? windowsRegistry.readDefaultValue(manifest.windowsRegistryKey)
      : null,
  }));
  const rollback: Array<() => void> = [];
  try {
    for (const snapshot of snapshots) {
      const { manifest } = snapshot;
      rollback.push(() => {
        if (snapshot.file) {
          atomicWritePrivateFile(
            manifest.manifestPath,
            snapshot.file.contents,
            snapshot.file.mode,
          );
        } else {
          fs.rmSync(manifest.manifestPath, { force: true });
        }
        restoreManifestDirectory(snapshot.directory);
      });
      atomicWritePrivateFile(manifest.manifestPath, manifest.contents);
      const registryKey = manifest.windowsRegistryKey;
      if (registryKey) {
        rollback.push(() => {
          if (snapshot.registryValue === null) {
            windowsRegistry.deleteKey(registryKey);
          } else {
            windowsRegistry.setDefaultValue(
              registryKey,
              snapshot.registryValue,
            );
          }
        });
        windowsRegistry.setDefaultValue(registryKey, manifest.manifestPath);
      }
    }
  } catch (error) {
    // error-policy:J2 partial registration is rolled back before preserving the install failure.
    const rollbackFailures: unknown[] = [];
    for (const restore of rollback.reverse()) {
      try {
        restore();
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError);
      }
    }
    if (rollbackFailures.length > 0) {
      throw new AggregateError(
        [error, ...rollbackFailures],
        "native-host registration and rollback failed",
        { cause: error },
      );
    }
    throw error;
  }
}

export function uninstallBrowserBridgeRegistration(
  plan: BrowserBridgeRegistrationPlan,
  windowsRegistry: WindowsRegistryExecutor = defaultWindowsRegistryExecutor,
): void {
  for (const manifest of plan.manifests) {
    const manifestOwned =
      fs.existsSync(manifest.manifestPath) &&
      fs.readFileSync(manifest.manifestPath, "utf8") === manifest.contents;
    let registryOwned = true;
    if (manifest.windowsRegistryKey) {
      const registeredManifest = windowsRegistry.readDefaultValue(
        manifest.windowsRegistryKey,
      );
      registryOwned = registeredManifest === manifest.manifestPath;
      if (registryOwned && manifestOwned) {
        windowsRegistry.deleteKey(manifest.windowsRegistryKey);
      }
    }
    if (manifestOwned && registryOwned) {
      fs.rmSync(manifest.manifestPath, { force: true });
    }
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
