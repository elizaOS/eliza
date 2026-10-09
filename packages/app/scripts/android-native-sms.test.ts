import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const runner = path.join(import.meta.dirname, "android-native-sms.ts");
for (const [name, args, error] of [
  [
    "rejects remote devices before invoking adb",
    ["--sender", "172.17.0.2:6522", "--receiver", "emulator-5582"],
    /Choose local emulator/,
  ],
  [
    "rejects odd console ports",
    ["--sender", "emulator-5581", "--receiver", "emulator-5582"],
    /console port/,
  ],
  [
    "does not silently replace peer delivery with loopback",
    ["--sender", "emulator-5580", "--receiver", "emulator-5580"],
    /two distinct emulators/,
  ],
  [
    "rejects ambiguous transport selection",
    ["--sender", "emulator-5580", "--receiver", "emulator-5582", "--loopback"],
    /Choose --receiver or --loopback/,
  ],
]) {
  test(name, () => {
    const result = spawnSync(process.execPath, [runner, ...args], {
      encoding: "utf8",
      timeout: 10000,
      // Any attempt to launch adb is a failure: these inputs must stop before
      // touching devices, leases, build tools, or generated run directories.
      env: { ...process.env, PATH: "" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
    assert.doesNotMatch(result.stderr, /spawnSync adb|ENOENT/);
  });
}
