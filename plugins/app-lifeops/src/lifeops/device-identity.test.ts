import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getDeviceFingerprint,
  getDeviceId,
  resetCachedDeviceId,
} from "./device-identity.js";

const ENV_KEYS = [
  "MILADY_DEVICE_ID",
  "ELIZA_DEVICE_ID",
  "ELIZA_STATE_DIR",
] as const;

const savedEnv: Record<string, string | undefined> = {};
let tmpStateDir: string;

function deviceIdCacheFile(): string {
  return path.join(tmpStateDir, "device-id");
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "milady-device-id-"));
  process.env.ELIZA_STATE_DIR = tmpStateDir;
  resetCachedDeviceId();
});

afterEach(() => {
  resetCachedDeviceId();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  fs.rmSync(tmpStateDir, { recursive: true, force: true });
});

describe("device-identity", () => {
  it("returns MILADY_DEVICE_ID when set", () => {
    process.env.MILADY_DEVICE_ID = "milady-fixed-id";
    expect(getDeviceId()).toBe("milady-fixed-id");
    expect(fs.existsSync(deviceIdCacheFile())).toBe(false);
  });

  it("returns ELIZA_DEVICE_ID when MILADY_DEVICE_ID is unset", () => {
    process.env.ELIZA_DEVICE_ID = "eliza-fixed-id";
    expect(getDeviceId()).toBe("eliza-fixed-id");
    expect(fs.existsSync(deviceIdCacheFile())).toBe(false);
  });

  it("prefers MILADY_DEVICE_ID over ELIZA_DEVICE_ID", () => {
    process.env.MILADY_DEVICE_ID = "milady-wins";
    process.env.ELIZA_DEVICE_ID = "eliza-loses";
    expect(getDeviceId()).toBe("milady-wins");
  });

  it("falls back to the cached file when env is not set", () => {
    fs.mkdirSync(tmpStateDir, { recursive: true });
    fs.writeFileSync(deviceIdCacheFile(), "cached-device-id\n", "utf8");
    expect(getDeviceId()).toBe("cached-device-id");
  });

  it("generates and persists a device id when neither env nor file is set", () => {
    expect(fs.existsSync(deviceIdCacheFile())).toBe(false);
    const generated = getDeviceId();
    expect(generated).toMatch(/-[0-9a-f]{6}$/);
    expect(
      generated.startsWith(
        `${os.hostname().replace(/[^A-Za-z0-9._-]/g, "-")}-`,
      ),
    ).toBe(true);
    expect(fs.readFileSync(deviceIdCacheFile(), "utf8").trim()).toBe(generated);
  });

  it("returns the same id on subsequent calls (in-memory cache)", () => {
    const first = getDeviceId();
    const second = getDeviceId();
    expect(second).toBe(first);
  });

  it("returns the same id across resets when the file has been persisted", () => {
    const first = getDeviceId();
    resetCachedDeviceId();
    const second = getDeviceId();
    expect(second).toBe(first);
  });

  it("ignores empty / whitespace-only env values", () => {
    process.env.MILADY_DEVICE_ID = "   ";
    process.env.ELIZA_DEVICE_ID = "";
    const id = getDeviceId();
    expect(id).toMatch(/-[0-9a-f]{6}$/);
    expect(fs.existsSync(deviceIdCacheFile())).toBe(true);
  });

  it("fingerprint contains hostname, platform, and a mac (or null)", () => {
    process.env.MILADY_DEVICE_ID = "fp-test-id";
    const fp = getDeviceFingerprint();
    expect(fp.id).toBe("fp-test-id");
    expect(fp.hostname).toBe(os.hostname());
    expect(fp.platform).toBe(os.platform());
    expect(
      fp.primaryMacAddress === null || typeof fp.primaryMacAddress === "string",
    ).toBe(true);
    if (fp.primaryMacAddress !== null) {
      expect(fp.primaryMacAddress).not.toBe("00:00:00:00:00:00");
    }
  });
});
