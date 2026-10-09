import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  __setDeviceSecretPathForTests,
  getDeviceSecret,
} from "./internal-routes";

let dir: string;
beforeEach(() => {
  vi.stubEnv("ELIZA_DEVICE_SECRET", undefined);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "app-device-secret-"));
  __setDeviceSecretPathForTests(path.join(dir, "device-secret"));
});
afterEach(() => {
  __setDeviceSecretPathForTests(null);
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

it("preserves the persisted identity after clearing the process cache", () => {
  const secret = getDeviceSecret();
  __setDeviceSecretPathForTests(path.join(dir, "device-secret"));
  expect(getDeviceSecret()).toBe(secret);
  expect(fs.readFileSync(path.join(dir, "device-secret"), "utf8").trim()).toBe(
    secret,
  );
});

it("rejects a corrupt persisted secret without replacing it", () => {
  fs.writeFileSync(path.join(dir, "device-secret"), "broken");
  expect(getDeviceSecret).toThrow(
    expect.objectContaining({ code: "DEVICE_SECRET_INVALID" }),
  );
  expect(fs.readFileSync(path.join(dir, "device-secret"), "utf8")).toBe(
    "broken",
  );
});

it("does not cache a generated secret after persistence fails", () => {
  fs.mkdirSync(path.join(dir, "device-secret"));
  expect(getDeviceSecret).toThrow();
  expect(getDeviceSecret).toThrow();
  fs.rmdirSync(path.join(dir, "device-secret"));
  const secret = getDeviceSecret();
  expect(fs.readFileSync(path.join(dir, "device-secret"), "utf8").trim()).toBe(
    secret,
  );
});

it("rejects an explicitly invalid environment secret", () => {
  vi.stubEnv("ELIZA_DEVICE_SECRET", "short");
  expect(getDeviceSecret).toThrow(
    expect.objectContaining({ code: "DEVICE_SECRET_INVALID" }),
  );
  expect(fs.existsSync(path.join(dir, "device-secret"))).toBe(false);
});
