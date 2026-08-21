/** Stores Safari enrollment HMAC material inside the provisioned shared App Group container. */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAC_BROWSER_BRIDGE_APP_GROUP } from "./browser-bridge-broker-transport";

export const MAC_BROWSER_BRIDGE_SHARED_SECRET_NAME = "s";

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

export function resolveMacBrowserBridgeSharedSecretPath(
  containerPath: string,
): string {
  if (!path.isAbsolute(containerPath)) {
    throw new Error("browser bridge App Group container path must be absolute");
  }
  return path.join(containerPath, MAC_BROWSER_BRIDGE_SHARED_SECRET_NAME);
}

function validateContainer(containerPath: string, expectedUid: number): void {
  const stat = fs.lstatSync(containerPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      "browser bridge App Group container must be a real directory",
    );
  }
  if (expectedUid >= 0 && stat.uid !== expectedUid) {
    throw new Error("browser bridge App Group container has the wrong owner");
  }
}

function readSecretDescriptor(
  descriptor: number,
  secretPath: string,
  expectedUid: number,
): Buffer {
  const descriptorStat = fs.fstatSync(descriptor);
  const pathStat = fs.lstatSync(secretPath);
  if (
    pathStat.isSymbolicLink() ||
    !descriptorStat.isFile() ||
    !pathStat.isFile() ||
    descriptorStat.dev !== pathStat.dev ||
    descriptorStat.ino !== pathStat.ino ||
    (descriptorStat.mode & 0o777) !== 0o600
  ) {
    throw new Error(
      "browser bridge App Group secret is not a private regular file",
    );
  }
  if (expectedUid >= 0 && descriptorStat.uid !== expectedUid) {
    throw new Error("browser bridge App Group secret has the wrong owner");
  }
  const secret = Buffer.alloc(32);
  let offset = 0;
  while (offset < secret.byteLength) {
    const count = fs.readSync(
      descriptor,
      secret,
      offset,
      secret.byteLength - offset,
      offset,
    );
    if (count === 0) break;
    offset += count;
  }
  if (offset !== 32 || descriptorStat.size !== 32) {
    throw new Error("browser bridge App Group secret has invalid length");
  }
  return secret;
}

export function loadMacBrowserBridgeSharedSecret(
  containerPath: string,
  expectedUid = typeof process.getuid === "function" ? process.getuid() : -1,
): Buffer {
  validateContainer(containerPath, expectedUid);
  const secretPath = resolveMacBrowserBridgeSharedSecretPath(containerPath);
  const descriptor = fs.openSync(
    secretPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
  );
  try {
    return readSecretDescriptor(descriptor, secretPath, expectedUid);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function loadOrCreateMacBrowserBridgeSharedSecret(
  containerPath: string,
  randomBytes: (size: number) => Buffer = crypto.randomBytes,
  expectedUid = typeof process.getuid === "function" ? process.getuid() : -1,
): Buffer {
  validateContainer(containerPath, expectedUid);
  const secretPath = resolveMacBrowserBridgeSharedSecretPath(containerPath);
  const secret = randomBytes(32);
  if (secret.byteLength !== 32) {
    throw new Error(
      "browser bridge App Group secret generator returned invalid length",
    );
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      secretPath,
      fs.constants.O_RDWR |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    // error-policy:J1 an existing item is accepted only through the same no-follow validation path.
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return loadMacBrowserBridgeSharedSecret(containerPath, expectedUid);
    }
    throw error;
  }
  try {
    fs.fchmodSync(descriptor, 0o600);
    let offset = 0;
    while (offset < secret.byteLength) {
      offset += fs.writeSync(
        descriptor,
        secret,
        offset,
        secret.byteLength - offset,
        offset,
      );
    }
    fs.fsyncSync(descriptor);
    const validated = readSecretDescriptor(descriptor, secretPath, expectedUid);
    if (!crypto.timingSafeEqual(secret, validated)) {
      throw new Error(
        "browser bridge App Group secret write verification failed",
      );
    }
    return validated;
  } finally {
    fs.closeSync(descriptor);
  }
}
