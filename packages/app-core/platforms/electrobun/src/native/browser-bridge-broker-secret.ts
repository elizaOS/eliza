/** Persists the per-user browser broker HMAC key with owner-only filesystem permissions. */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "./auth-bridge";

export function resolveBrowserBridgeBrokerSecretPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveStateDir(env), "browser-bridge", "broker-secret");
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
): Buffer | null {
  const secretPath = resolveBrowserBridgeBrokerSecretPath(env);
  if (!fs.existsSync(secretPath)) return null;
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
): Buffer {
  const existing = loadBrowserBridgeBrokerSecret(env, expectedUid);
  if (existing) return existing;
  const secretPath = resolveBrowserBridgeBrokerSecretPath(env);
  const directory = path.dirname(secretPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
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
