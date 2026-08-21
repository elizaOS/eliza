/** Generates deterministic Chrome and Firefox native-host manifests without installing them. */

import path from "node:path";
import { BROWSER_BRIDGE_NATIVE_HOST_NAME } from "./browser-bridge-native-protocol";

const HOST_DESCRIPTION = "elizaOS Agent Browser Bridge enrollment host";

function validateAbsoluteExecutablePath(executablePath: string): string {
  const isWindowsPath =
    /^[A-Za-z]:[\\/]/.test(executablePath) || executablePath.startsWith("\\\\");
  if (
    (!path.posix.isAbsolute(executablePath) && !isWindowsPath) ||
    executablePath.includes("\0")
  ) {
    throw new Error("native messaging host executable path must be absolute");
  }
  return isWindowsPath
    ? path.win32.normalize(executablePath)
    : path.posix.normalize(executablePath);
}

function validateChromeExtensionId(id: string): string {
  if (!/^[a-p]{32}$/.test(id))
    throw new Error("Chrome extension ID is invalid");
  return id;
}

function validateFirefoxExtensionId(id: string): string {
  if (id.length === 0 || id.length > 128 || !/^[A-Za-z0-9@._{}-]+$/.test(id)) {
    throw new Error("Firefox extension ID is invalid");
  }
  return id;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export function generateChromeNativeHostManifest(options: {
  executablePath: string;
  extensionIds: readonly string[];
}): Record<string, unknown> {
  const extensionIds = uniqueSorted(
    options.extensionIds.map(validateChromeExtensionId),
  );
  if (extensionIds.length === 0)
    throw new Error("at least one Chrome extension ID is required");
  return {
    name: BROWSER_BRIDGE_NATIVE_HOST_NAME,
    description: HOST_DESCRIPTION,
    path: validateAbsoluteExecutablePath(options.executablePath),
    type: "stdio",
    allowed_origins: extensionIds.map((id) => `chrome-extension://${id}/`),
  };
}

export function generateFirefoxNativeHostManifest(options: {
  executablePath: string;
  extensionIds: readonly string[];
}): Record<string, unknown> {
  const extensionIds = uniqueSorted(
    options.extensionIds.map(validateFirefoxExtensionId),
  );
  if (extensionIds.length === 0)
    throw new Error("at least one Firefox extension ID is required");
  return {
    name: BROWSER_BRIDGE_NATIVE_HOST_NAME,
    description: HOST_DESCRIPTION,
    path: validateAbsoluteExecutablePath(options.executablePath),
    type: "stdio",
    allowed_extensions: extensionIds,
  };
}

export function serializeNativeHostManifest(
  manifest: Record<string, unknown>,
): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
