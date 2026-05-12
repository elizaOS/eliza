import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "@elizaos/agent";

const ENV_KEYS = ["ELIZA_DEVICE_ID", "MILADY_DEVICE_ID"] as const;
const CACHE_FILE_NAME = "device-id";
const RANDOM_SUFFIX_BYTES = 3; // 3 bytes -> 6 hex chars

export interface DeviceFingerprint {
  id: string;
  hostname: string;
  platform: NodeJS.Platform;
  primaryMacAddress: string | null;
}

let cachedDeviceId: string | null = null;

function readEnvDeviceId(env: NodeJS.ProcessEnv): string | null {
  for (const key of ENV_KEYS) {
    const raw = env[key];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function readFileDeviceId(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const contents = fs.readFileSync(filePath, "utf8").trim();
  return contents.length > 0 ? contents : null;
}

function sanitizeHostname(hostname: string): string {
  const cleaned = hostname.trim().replace(/[^A-Za-z0-9._-]/g, "-");
  return cleaned.length > 0 ? cleaned : "host";
}

function generateDeviceId(hostname: string): string {
  const suffix = crypto.randomBytes(RANDOM_SUFFIX_BYTES).toString("hex");
  return `${sanitizeHostname(hostname)}-${suffix}`;
}

function persistDeviceId(filePath: string, deviceId: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, deviceId, "utf8");
}

function deviceIdCachePath(env: NodeJS.ProcessEnv): string {
  return path.join(resolveStateDir(env), CACHE_FILE_NAME);
}

/**
 * Returns a stable, process-lifetime device identifier.
 *
 * Resolution order:
 *   1. `ELIZA_DEVICE_ID` env var
 *   2. `ELIZA_DEVICE_ID` env var
 *   3. Cached value at `<state-dir>/device-id`
 *   4. Newly generated `<hostname>-<6-char-hex>`, persisted to that file
 *
 * The result is memoized for the lifetime of the process so repeated calls
 * are cheap and guaranteed to return the same value.
 */
export function getDeviceId(env: NodeJS.ProcessEnv = process.env): string {
  if (cachedDeviceId !== null) {
    return cachedDeviceId;
  }

  const fromEnv = readEnvDeviceId(env);
  if (fromEnv !== null) {
    cachedDeviceId = fromEnv;
    return cachedDeviceId;
  }

  const cachePath = deviceIdCachePath(env);
  const fromFile = readFileDeviceId(cachePath);
  if (fromFile !== null) {
    cachedDeviceId = fromFile;
    return cachedDeviceId;
  }

  const generated = generateDeviceId(os.hostname());
  persistDeviceId(cachePath, generated);
  cachedDeviceId = generated;
  return cachedDeviceId;
}

function readPrimaryMacAddress(): string | null {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    const addrs = interfaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.internal) continue;
      const mac = addr.mac;
      if (typeof mac !== "string") continue;
      if (mac.length === 0 || mac === "00:00:00:00:00:00") continue;
      return mac;
    }
  }
  return null;
}

/**
 * Returns a coarse fingerprint of the current device suitable for logging
 * and presence-signal aggregation. Does not include any user-identifying
 * data beyond what `os.hostname()` / `os.networkInterfaces()` already expose.
 */
export function getDeviceFingerprint(
  env: NodeJS.ProcessEnv = process.env,
): DeviceFingerprint {
  return {
    id: getDeviceId(env),
    hostname: os.hostname(),
    platform: os.platform(),
    primaryMacAddress: readPrimaryMacAddress(),
  };
}

/**
 * Test-only: drops the in-memory cache so the next `getDeviceId` call
 * re-runs the env -> file -> generate resolution.
 */
export function resetCachedDeviceId(): void {
  cachedDeviceId = null;
}
