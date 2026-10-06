import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { findEmulatorSerial, waitForBoot } from "../android/avd-test.ts";

for (const blocked of [
  "wait-for-device",
  "getprop sys.boot_completed",
  "wm dismiss-keyguard",
  null,
]) {
  test(`AVD boot deadline: ${blocked ?? "successful boot"}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "avd-deadline-"));
    try {
      const adb = path.join(directory, "adb");
      await writeFile(
        adb,
        `#!${process.execPath}
const command = process.argv.at(-1);
if (command === ${JSON.stringify(blocked)}) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (command === "getprop sys.boot_completed") {
  console.log("1");
}
`,
        { mode: 0o700 },
      );
      const timeoutMs = blocked === null ? 5000 : 500;
      const started = performance.now();
      if (blocked === null) {
        await waitForBoot(adb, "emulator-fixture", timeoutMs);
      } else {
        await assert.rejects(
          waitForBoot(adb, "emulator-fixture", timeoutMs),
          (error) => {
            const failure = error.cause?.cause ?? error.cause;
            assert.equal(failure?.code, "ETIMEDOUT");
            return true;
          },
        );
      }
      assert.ok(
        performance.now() - started < timeoutMs + 1500,
        "boot exceeded its bounded deadline",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

for (const blocked of ["devices", "name", null]) {
  test(`AVD discovery deadline: ${blocked ?? "matching emulator"}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "avd-discovery-"));
    try {
      const adb = path.join(directory, "adb");
      await writeFile(
        adb,
        `#!${process.execPath}
const command = process.argv.at(-1);
if (command === ${JSON.stringify(blocked)}) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
} else if (command === "devices") {
  console.log("List of devices attached\\nemulator-5554\\tdevice");
} else if (command === "name") {
  console.log("fixture-avd\\nOK");
}
`,
        { mode: 0o700 },
      );
      const timeoutMs = blocked === null ? 5000 : 500;
      const started = performance.now();
      if (blocked === null) {
        assert.equal(
          await findEmulatorSerial(adb, "fixture-avd", timeoutMs),
          "emulator-5554",
        );
      } else {
        await assert.rejects(
          findEmulatorSerial(adb, "fixture-avd", timeoutMs),
          (error) => {
            assert.equal(error.cause?.code, "ETIMEDOUT");
            return true;
          },
        );
      }
      assert.ok(
        performance.now() - started < timeoutMs + 1500,
        "discovery exceeded its deadline",
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
