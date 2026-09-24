#!/usr/bin/env node
/** Send through the production bridge; require explicit peer or modem-loopback delivery. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import {
  inventory,
  parseInstrumentation,
  parseNativeArtifacts,
} from "./android-native-plugins.mjs";
import { acquireDeviceLease } from "./lib/device-lease.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const args = process.argv.slice(2);
const option = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const sender = option("--sender");
const loopback = args.includes("--loopback");
const receiver = loopback ? sender : option("--receiver");
if (loopback && args.includes("--receiver"))
  throw Error("Choose --receiver or --loopback, not both");
const port = (serial) => {
  if (!/^emulator-\d+$/.test(serial ?? ""))
    throw Error(
      "Choose local emulator serials with --sender and --receiver, or explicit --loopback",
    );
  const value = Number(serial.slice(9));
  if (value < 5554 || value > 5682 || value % 2)
    throw Error("Expected a local emulator console port between 5554 and 5682");
  return String(value);
};
const senderPort = port(sender);
const receiverPort = port(receiver);
if (sender === receiver && !loopback)
  throw Error(
    "SMS peer proof requires two distinct emulators; select --loopback explicitly for one modem",
  );
const run = (command, argv, timeout = 120000) =>
  execFileSync(command, argv, {
    cwd: root,
    encoding: "utf8",
    timeout,
    maxBuffer: 32 * 1024 * 1024,
  });
const adb = (serial, ...argv) => run("adb", ["-s", serial, ...argv]);
const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const output = testOutputPath(
  "android-native-sms",
  new Date().toISOString().replaceAll(":", "-"),
);
fs.mkdirSync(output, { recursive: true });
const multipart = args.includes("--multipart");
const body =
  `Eliza native SMS round trip ${randomUUID()}` +
  (multipart
    ? `\n${"Hello 🌍 — native multipart round trip.\n".repeat(8)}`
    : "");
const report = {
  revision: run("git", ["rev-parse", "HEAD"]).trim(),
  worktreeChanges: run("git", ["status", "--porcelain"]),
  builtFromCheckout: true,
  startedAt: new Date().toISOString(),
  sender,
  receiver,
  transport: loopback ? "modem-loopback" : "emulator-peer",
  multipart,
  body,
  devices: {},
  results: [],
  problems: [],
};
const leases = [];
const installed = [];
let applicationId;
try {
  for (const serial of [...new Set([sender, receiver])].sort()) {
    if (
      !/^(ranchu|goldfish)$/.test(
        adb(serial, "shell", "getprop", "ro.hardware").trim(),
      )
    )
      throw Error("SMS delivery tests require stock local emulators");
    if (adb(serial, "shell", "pm", "list", "packages", "ai.elizaos.app").trim())
      throw Error(
        "SMS delivery tests require isolated emulators without the user app",
      );
    leases.push(await acquireDeviceLease(`android:${serial}`, { waitMs: 0 }));
    report.devices[serial] = {
      sdk: adb(serial, "shell", "getprop", "ro.build.version.sdk").trim(),
      fingerprint: adb(
        serial,
        "shell",
        "getprop",
        "ro.build.fingerprint",
      ).trim(),
    };
  }
  const plugin = inventory().find(
    (entry) => entry.directory === "plugin-native-messages",
  );
  const build = run(
    path.join(root, "packages/app/platforms/android/gradlew"),
    [
      "-p",
      "packages/app/scripts/android-native-plugins-gradle",
      `:${plugin.project}:assembleDebugAndroidTest`,
      "--console=plain",
    ],
    600000,
  );
  fs.writeFileSync(path.join(output, "build.log"), build);
  const apkDir = path.join(
    root,
    "plugins/plugin-native-messages/android/build/outputs/apk/androidTest/debug",
  );
  const metadata = JSON.parse(
    fs.readFileSync(path.join(apkDir, "output-metadata.json"), "utf8"),
  );
  applicationId = metadata.applicationId;
  if (!applicationId.endsWith(".test") || metadata.elements.length !== 1)
    throw Error("Expected an isolated test APK");
  const apk = path.join(apkDir, metadata.elements[0].outputFile);
  report.apkSha256 = createHash("sha256")
    .update(fs.readFileSync(apk))
    .digest("hex");
  for (const serial of new Set([sender, receiver])) {
    adb(serial, "install", "-r", "-t", "-g", apk);
    installed.push(serial);
    adb(serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP");
    adb(serial, "shell", "wm", "dismiss-keyguard");
  }
  // Do not run the seeded-provider tests: their WRITE_SMS app-op would hide a
  // production non-default-app persistence failure. Delivery must still be
  // checked on the receiver when the sender's bridge reports an error.
  for (const [serial, role] of [
    [sender, "sender"],
    [receiver, "receiver"],
  ]) {
    const log = adb(
      serial,
      "shell",
      "am",
      "instrument",
      "-w",
      "-r",
      "-e",
      "class",
      "ai.eliza.testing.NativeBridgeInstrumentedTest",
      "-e",
      "smsRole",
      role,
      "-e",
      "smsLoopback",
      String(loopback),
      "-e",
      "smsSenderPort",
      senderPort,
      "-e",
      "smsPeerPort",
      receiverPort,
      "-e",
      "smsBody",
      shellQuote(body),
      `${applicationId}/androidx.test.runner.AndroidJUnitRunner`,
    );
    fs.writeFileSync(path.join(output, `${role}.log`), log);
    const result = { role, serial, ...parseInstrumentation(log, 1) };
    result.artifacts = parseNativeArtifacts(log).map(({ name, bytes }) => {
      fs.writeFileSync(path.join(output, name), bytes);
      return {
        path: name,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    report.results.push(result);
    console.log(`${result.pass ? "PASS" : "FAIL"} SMS ${role}`);
  }
} catch (error) {
  report.problems.push(String(error));
  if (error.stdout)
    fs.writeFileSync(path.join(output, "failure.log"), error.stdout);
} finally {
  for (const serial of installed) {
    try {
      const cleanupLog = adb(
        serial,
        "shell",
        "am",
        "instrument",
        "-w",
        "-r",
        "-e",
        "class",
        "ai.eliza.testing.NativeBridgeInstrumentedTest",
        "-e",
        "smsCleanupBody",
        shellQuote(body),
        `${applicationId}/androidx.test.runner.AndroidJUnitRunner`,
      );
      fs.writeFileSync(path.join(output, `cleanup-${serial}.log`), cleanupLog);
      if (!parseInstrumentation(cleanupLog, 1).pass)
        report.problems.push(
          `cleanup ${serial}: SMS cleanup instrumentation failed`,
        );
    } catch (error) {
      report.problems.push(`cleanup ${serial}: ${error}`);
    }
    try {
      adb(serial, "uninstall", applicationId);
    } catch (error) {
      report.problems.push(`uninstall ${serial}: ${error}`);
    }
  }
  report.finishedAt = new Date().toISOString();
  report.pass =
    report.problems.length === 0 &&
    report.results.length === 2 &&
    report.results.every((result) => result.pass);
  try {
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
  } finally {
    for (const lease of leases.reverse()) lease.release();
  }
}
console.log(`Evidence: ${path.join(output, "report.json")}`);
if (!report.pass) process.exitCode = 1;
