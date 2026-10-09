/** Checks device preparation through an executable ADB double and its command log. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareAndroidE2eDevice } from "./android-device.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fakeAdb(mode: string, confirmation = "confirmed") {
  const directory = mkdtempSync(path.join(os.tmpdir(), "android-prepare-"));
  temporaryDirectories.push(directory);
  const commandLog = path.join(directory, "commands.jsonl");
  const executable = path.join(directory, "adb.cjs");
  writeFileSync(commandLog, "");
  writeFileSync(
    executable,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(args) + "\\n");
if (args.includes("getenforce")) console.log(${JSON.stringify(mode)});
if (args.includes("get")) console.log(${JSON.stringify(confirmation)});
`,
    { mode: 0o700 },
  );
  return {
    executable,
    commands: () =>
      readFileSync(commandLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
  };
}

describe("Android E2E device security policy", () => {
  it("prepares hosted emulator UI without rooting or changing SELinux", async () => {
    const adb = fakeAdb("Enforcing");
    await prepareAndroidE2eDevice(adb.executable, "emulator-5580", "host");
    expect(adb.commands()).toEqual([
      ["-s", "emulator-5580", "shell", "getenforce"],
      [
        "-s",
        "emulator-5580",
        "shell",
        "settings",
        "put",
        "secure",
        "immersive_mode_confirmations",
        "confirmed",
      ],
      [
        "-s",
        "emulator-5580",
        "shell",
        "settings",
        "get",
        "secure",
        "immersive_mode_confirmations",
      ],
    ]);
  });

  it.each(["Permissive", "Disabled", "", "unknown"])(
    "rejects hosted %j policy before mutating device settings",
    async (mode) => {
      const adb = fakeAdb(mode);
      await expect(
        prepareAndroidE2eDevice(adb.executable, "emulator-5580", "host"),
      ).rejects.toThrow("requires SELinux Enforcing");
      expect(adb.commands()).toEqual([
        ["-s", "emulator-5580", "shell", "getenforce"],
      ]);
    },
  );

  it("only reads the policy on a hosted physical device", async () => {
    const adb = fakeAdb("Enforcing");
    await prepareAndroidE2eDevice(adb.executable, "physical-device", "host");
    expect(adb.commands()).toEqual([
      ["-s", "physical-device", "shell", "getenforce"],
    ]);
  });

  it("fails when the native immersive overlay cannot be acknowledged", async () => {
    const adb = fakeAdb("Enforcing", "null");
    await expect(
      prepareAndroidE2eDevice(adb.executable, "emulator-5580", "host"),
    ).rejects.toThrow(
      "failed to acknowledge Android immersive-mode confirmation",
    );
  });

  it("preserves the embedded emulator's existing permissive preparation", async () => {
    const adb = fakeAdb("Permissive");
    await expect(
      prepareAndroidE2eDevice(adb.executable, "emulator-5580", "local"),
    ).resolves.toBe(true);
    expect(adb.commands()).toContainEqual(["-s", "emulator-5580", "root"]);
    expect(adb.commands()).toContainEqual([
      "-s",
      "emulator-5580",
      "shell",
      "setenforce",
      "0",
    ]);
  });

  it("rejects an unknown backend without touching the device", async () => {
    const adb = fakeAdb("Enforcing");
    await expect(
      prepareAndroidE2eDevice(adb.executable, "emulator-5580", "typo"),
    ).rejects.toThrow("Unknown Android E2E backend");
    expect(adb.commands()).toEqual([]);
  });
});
