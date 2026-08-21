/** Resolves the signed helper contract for Safari app-group and shared-Keychain enrollment. */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAC_BROWSER_BRIDGE_APP_GROUP,
  MAC_BROWSER_BRIDGE_KEYCHAIN_ACCOUNT,
  MAC_BROWSER_BRIDGE_KEYCHAIN_SERVICE,
} from "./browser-bridge-broker-transport";

export function resolveMacBrowserBridgeAppGroupContainer(
  homeDir = os.homedir(),
): string {
  return path.join(
    homeDir,
    "Library",
    "Group Containers",
    MAC_BROWSER_BRIDGE_APP_GROUP,
  );
}

export function resolveMacBrowserBridgeKeychainHelper(
  moduleDir: string,
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  const candidates = [
    path.resolve(moduleDir, "..", "browser-bridge-keychain-helper"),
    path.resolve(
      moduleDir,
      "..",
      "..",
      "build",
      "browser-bridge-keychain-helper",
    ),
  ];
  const resolved = candidates.find(exists);
  if (!resolved) throw new Error("packaged shared-Keychain helper is missing");
  return resolved;
}

export function macSharedKeychainHelperInvocation(
  helperPath: string,
  accessGroup: string,
): {
  command: string;
  args: string[];
} {
  if (!path.isAbsolute(helperPath))
    throw new Error("shared Keychain helper path must be absolute");
  if (!/^[A-Z0-9]{10}\.ai\.elizaos\.browserbridge\.shared$/.test(accessGroup)) {
    throw new Error("shared Keychain access group is not concrete");
  }
  return {
    command: helperPath,
    args: [
      "get-or-create",
      "--service",
      MAC_BROWSER_BRIDGE_KEYCHAIN_SERVICE,
      "--account",
      MAC_BROWSER_BRIDGE_KEYCHAIN_ACCOUNT,
      "--access-group",
      accessGroup,
      "--bytes",
      "32",
    ],
  };
}

export function loadOrCreateMacSharedKeychainSecret(
  helperPath: string,
  accessGroup: string,
): Buffer {
  const invocation = macSharedKeychainHelperInvocation(helperPath, accessGroup);
  const result = spawnSync(invocation.command, invocation.args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.status !== 0) throw new Error("shared Keychain helper failed");
  const secret = Buffer.from(result.stdout.trim(), "base64");
  if (secret.byteLength !== 32)
    throw new Error("shared Keychain helper returned invalid secret");
  return secret;
}
