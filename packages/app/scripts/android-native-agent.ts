#!/usr/bin/env node
/** Exercise library agent plugins against the production Android service and real Bun bundle. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import {
  parseInstrumentation,
  parseNativeArtifacts,
} from "./android-native-plugins.ts";
import { acquireDeviceLease } from "./lib/device-lease.ts";
import { stageAndroidAgentRuntime } from "./lib/stage-android-agent.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const serial = process.argv[process.argv.indexOf("--serial") + 1];
if (!process.argv.includes("--serial") || !serial)
  throw new Error(
    "Pass --serial <fresh-emulator>; this lane requires no existing Eliza app",
  );
const output = testOutputPath(
  "android-native-agent",
  "runs",
  new Date().toISOString().replaceAll(":", "-"),
);
fs.mkdirSync(output, { recursive: true });
const stage = testOutputPath("android-native-agent", "stage");
const project = path.join(root, "packages/app/platforms/android");
const fixture = path.join(root, "packages/app/test/android-native-agent");
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function command(binary, args, timeout = 120000) {
  return execFileSync(binary, args, {
    cwd: root,
    encoding: "utf8",
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
}
const adb = (...args) => command("adb", ["-s", serial, ...args], 360000);
function logged(name, binary, args, timeout) {
  try {
    const result = command(binary, args, timeout);
    fs.writeFileSync(path.join(output, name), result);
    return result;
  } catch (error) {
    fs.writeFileSync(
      path.join(output, name),
      `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
    );
    throw error;
  }
}
const report = {
  serial,
  revision: command("git", ["rev-parse", "HEAD"]).trim(),
  worktreeChanges: command("git", ["status", "--porcelain"]),
  startedAt: new Date().toISOString(),
  builtFromCheckout: true,
  fixture:
    "Minimal WebView page; production MainActivity, Agent library and ElizaAgentService",
  pass: false,
  problems: [],
  artifacts: [],
};
const lease = await acquireDeviceLease(`android:${serial}`, { waitMs: 0 });
let installed = false;
try {
  if (adb("shell", "getprop", "ro.kernel.qemu").trim() !== "1")
    throw new Error("Use a disposable Android emulator");
  if (!adb("shell", "getprop", "ro.product.cpu.abilist").includes("x86_64"))
    throw new Error("This host lane currently requires an x86_64 emulator");
  if (adb("shell", "pm", "list", "packages", "ai.elizaos.app").trim())
    throw new Error("Refusing to replace an existing Eliza installation");
  logged(
    "mobile-build.log",
    "bun",
    ["run", "--cwd", "packages/agent", "build:mobile", "--target=android"],
    1200000,
  );
  const stagingLog = [];
  await stageAndroidAgentRuntime({
    androidDir: stage,
    spikeDir: path.join(root, "scripts/spike-android-agent"),
    log: (line) => stagingLog.push(line),
  });
  fs.writeFileSync(
    path.join(output, "runtime-staging.log"),
    stagingLog.join("\n"),
  );
  const assets = path.join(stage, "app/src/main/assets");
  report.agentBundleSha256 = hash(path.join(assets, "agent/agent-bundle.js"));
  report.deviceFingerprint = adb(
    "shell",
    "getprop",
    "ro.build.fingerprint",
  ).trim();
  fs.mkdirSync(path.join(assets, "public"), { recursive: true });
  fs.copyFileSync(
    path.join(fixture, "__fixtures__/index.html"),
    path.join(assets, "public/index.html"),
  );
  fs.writeFileSync(
    path.join(assets, "capacitor.config.json"),
    JSON.stringify({
      appId: "ai.elizaos.app",
      appName: "Native agent verification",
      webDir: "public",
    }),
  );
  fs.writeFileSync(
    path.join(assets, "capacitor.plugins.json"),
    JSON.stringify([
      {
        pkg: "@elizaos/capacitor-agent",
        classpath: "ai.eliza.plugins.agent.AgentPlugin",
      },
      {
        pkg: "@elizaos/capacitor-bun-runtime",
        classpath: "ai.elizaos.plugins.bunruntime.ElizaBunRuntimePlugin",
      },
    ]),
  );
  const quote = (value) =>
    `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
  const init = path.join(output, "host.init.gradle");
  fs.writeFileSync(
    init,
    `allprojects { p -> p.afterEvaluate { if (p.path == ':app') {
    p.android.sourceSets.main.assets.srcDir(${quote(assets)})
    p.android.sourceSets.main.jniLibs.srcDir(${quote(path.join(stage, "app/src/main/jniLibs"))})
    p.android.sourceSets.androidTest.java.srcDir(${quote(path.join(fixture, "java"))})
    p.android.defaultConfig.ndk.abiFilters.clear()
    p.android.defaultConfig.ndk.abiFilters.add('x86_64')
  } } }\n`,
  );
  logged(
    "gradle.log",
    path.join(project, "gradlew"),
    [
      "-p",
      project,
      "-I",
      init,
      ":app:assembleDebug",
      ":app:assembleDebugAndroidTest",
      "--console=plain",
    ],
    1200000,
  );
  const apk = path.join(project, "app/build/outputs/apk/debug/app-debug.apk");
  const testApk = path.join(
    project,
    "app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
  );
  report.apkSha256 = hash(apk);
  report.testApkSha256 = hash(testApk);
  report.deviceLogSince = `${adb("shell", "date", "+%s").trim()}.000`;
  installed = true;
  adb("install", "-r", "-t", apk);
  adb("install", "-r", "-t", testApk);
  adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  adb("shell", "wm", "dismiss-keyguard");
  const result = logged(
    "instrumentation.log",
    "adb",
    [
      "-s",
      serial,
      "shell",
      "am",
      "instrument",
      "-w",
      "-r",
      "-e",
      "isolatedAgentHost",
      "1",
      "-e",
      "class",
      "ai.elizaos.app.NativeAgentLifecycleInstrumentedTest",
      "ai.elizaos.app.test/androidx.test.runner.AndroidJUnitRunner",
    ],
    360000,
  );
  const parsed = parseInstrumentation(result, 1);
  report.tests = parsed.tests;
  report.problems.push(...parsed.problems);
  for (const artifact of parseNativeArtifacts(result)) {
    const file = path.join(output, artifact.name);
    fs.writeFileSync(file, artifact.bytes);
    report.artifacts.push({
      path: artifact.name,
      bytes: artifact.bytes.length,
      sha256: hash(file),
    });
  }
  report.pass = parsed.pass;
} catch (error) {
  report.problems.push(String(error));
} finally {
  if (installed) {
    try {
      fs.writeFileSync(
        path.join(output, "device.log"),
        adb(
          "logcat",
          "-d",
          "-T",
          report.deviceLogSince,
          "-s",
          "ElizaAgent:I",
          "TestRunner:I",
        ),
      );
    } catch (error) {
      report.pass = false;
      report.problems.push(`device log: ${error}`);
    }
    for (const args of [
      ["shell", "am", "force-stop", "ai.elizaos.app"],
      ["uninstall", "ai.elizaos.app.test"],
      ["uninstall", "ai.elizaos.app"],
    ]) {
      try {
        adb(...args);
      } catch (error) {
        report.pass = false;
        report.problems.push(`cleanup: ${error}`);
      }
    }
  }
  report.finishedAt = new Date().toISOString();
  try {
    fs.writeFileSync(
      path.join(output, "report.json"),
      JSON.stringify(report, null, 2),
    );
  } finally {
    lease.release();
  }
}
console.log(
  `${report.pass ? "PASS" : "FAIL"} Android native agent lifecycle\nEvidence: ${path.join(output, "report.json")}`,
);
if (!report.pass) process.exitCode = 1;
