/** Persists the per-user browser broker HMAC key with owner-only filesystem permissions. */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "./auth-bridge";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

interface WindowsSecretCommandResult {
  status: number | null;
  stdout: string;
}

export interface BrowserBridgeBrokerSecretOptions {
  platform?: NodeJS.Platform;
  windowsHelperPath?: string;
  runWindowsHelper?: (
    command: string,
    args: string[],
    options: { encoding: "utf8"; timeout: number; windowsHide: true },
  ) => WindowsSecretCommandResult;
}

export function resolveWindowsBrowserBridgeSecretHelper(
  moduleDir = MODULE_DIR,
  exists: (candidate: string) => boolean = fs.existsSync,
): string {
  const candidates = [
    path.resolve(moduleDir, "browser-bridge-secret.ps1"),
    path.resolve(moduleDir, "..", "browser-bridge-secret.ps1"),
    path.resolve(moduleDir, "..", "..", "scripts", "browser-bridge-secret.ps1"),
  ];
  const resolved = candidates.find(exists);
  if (!resolved)
    throw new Error("packaged Windows broker secret helper is missing");
  return resolved;
}

export function windowsBrowserBridgeSecretInvocation(
  operation: "read" | "get-or-create",
  secretPath: string,
  helperPath: string,
): { command: string; args: string[] } {
  if (
    (!path.isAbsolute(helperPath) && !path.win32.isAbsolute(helperPath)) ||
    !helperPath.endsWith(".ps1")
  ) {
    throw new Error("Windows broker secret helper path is invalid");
  }
  return {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      helperPath,
      "-Operation",
      operation,
      "-Path",
      secretPath,
    ],
  };
}

function runWindowsSecretHelper(
  operation: "read" | "get-or-create",
  secretPath: string,
  options: BrowserBridgeBrokerSecretOptions,
): Buffer {
  const invocation = windowsBrowserBridgeSecretInvocation(
    operation,
    secretPath,
    options.windowsHelperPath ?? resolveWindowsBrowserBridgeSecretHelper(),
  );
  const result = (options.runWindowsHelper ?? spawnSync)(
    invocation.command,
    invocation.args,
    { encoding: "utf8", timeout: 5_000, windowsHide: true },
  );
  if (result.status !== 0)
    throw new Error("Windows DPAPI broker secret helper failed");
  const stdout =
    typeof result.stdout === "string"
      ? result.stdout
      : result.stdout.toString("utf8");
  const secret = Buffer.from(stdout.trim(), "base64");
  if (secret.byteLength !== 32) {
    throw new Error("Windows DPAPI broker secret has invalid length");
  }
  return secret;
}

export function resolveBrowserBridgeBrokerSecretPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), "browser-bridge", "broker-secret");
}

function assertNoSymlinkTraversal(targetPath: string, stateRoot: string): void {
  const absolute = path.resolve(targetPath);
  const boundary = path.resolve(stateRoot);
  const relative = path.relative(path.dirname(boundary), absolute);
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("browser bridge broker secret escapes the state directory");
  }
  let current = path.dirname(boundary);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new Error(
          "browser bridge broker secret path traverses a symlink",
        );
      }
    } catch (error) {
      // error-policy:J3 a missing suffix is valid while securely creating a new path.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function assertPrivateSecretDirectory(
  directory: string,
  expectedUid: number,
): void {
  const stat = fs.lstatSync(directory);
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new Error(
      "browser bridge broker secret directory must be a real mode-0700 directory",
    );
  }
  if (expectedUid >= 0 && stat.uid !== expectedUid) {
    throw new Error(
      "browser bridge broker secret directory is not owned by the current user",
    );
  }
}

export function loadBrowserBridgeBrokerSecret(
  env: NodeJS.ProcessEnv = process.env,
  expectedUid = typeof process.getuid === "function" ? process.getuid() : -1,
  options: BrowserBridgeBrokerSecretOptions = {},
): Buffer | null {
  const secretPath = resolveBrowserBridgeBrokerSecretPath(env);
  const stateRoot = resolveStateDir(env);
  if (!fs.existsSync(secretPath)) return null;
  if ((options.platform ?? process.platform) === "win32") {
    return runWindowsSecretHelper("read", secretPath, options);
  }
  assertNoSymlinkTraversal(secretPath, stateRoot);
  assertPrivateSecretDirectory(path.dirname(secretPath), expectedUid);
  const stat = fs.lstatSync(secretPath);
  if (
    stat.isSymbolicLink() ||
    !stat.isFile() ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      "browser bridge broker secret must be a regular mode-0600 file",
    );
  }
  if (expectedUid >= 0 && stat.uid !== expectedUid) {
    throw new Error(
      "browser bridge broker secret is not owned by the current user",
    );
  }
  const secret = fs.readFileSync(secretPath);
  if (secret.byteLength !== 32)
    throw new Error("browser bridge broker secret has invalid length");
  return secret;
}

export function loadOrCreateBrowserBridgeBrokerSecret(
  env: NodeJS.ProcessEnv = process.env,
  randomBytes: (size: number) => Buffer = crypto.randomBytes,
  expectedUid = typeof process.getuid === "function" ? process.getuid() : -1,
  options: BrowserBridgeBrokerSecretOptions = {},
): Buffer {
  if ((options.platform ?? process.platform) === "win32") {
    return runWindowsSecretHelper(
      "get-or-create",
      resolveBrowserBridgeBrokerSecretPath(env),
      options,
    );
  }
  const existing = loadBrowserBridgeBrokerSecret(env, expectedUid, options);
  if (existing) return existing;
  const secretPath = resolveBrowserBridgeBrokerSecretPath(env);
  const stateRoot = resolveStateDir(env);
  const directory = path.dirname(secretPath);
  assertNoSymlinkTraversal(directory, stateRoot);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkTraversal(directory, stateRoot);
  assertPrivateSecretDirectory(directory, expectedUid);
  const secret = randomBytes(32);
  if (secret.byteLength !== 32)
    throw new Error("broker secret generator returned invalid length");
  try {
    const descriptor = fs.openSync(
      secretPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      fs.writeFileSync(descriptor, secret);
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    return secret;
  } catch (error) {
    // error-policy:J2 a concurrent creator is accepted only if its completed file validates.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const concurrentlyCreated = loadBrowserBridgeBrokerSecret(
        env,
        expectedUid,
      );
      if (concurrentlyCreated) return concurrentlyCreated;
    }
    throw error;
  }
}
