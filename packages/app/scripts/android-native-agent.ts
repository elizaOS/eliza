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
const embedding = process.argv.includes("--embedding");
const speech = process.argv.includes("--speech-model-dir");
const speechModelDir = speech
  ? process.argv[process.argv.indexOf("--speech-model-dir") + 1]
  : undefined;
if (speech && (!speechModelDir || speechModelDir.startsWith("--") || embedding))
  throw new Error(
    "Pass --speech-model-dir <pinned-kokoro-directory> separately from --embedding",
  );
const nativeInference = embedding || speech;
const scenario = embedding
  ? "native embedding"
  : speech
    ? "native speech transport and PCM diagnostics"
    : "native agent lifecycle";
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
  scenario,
  ...(speech
    ? {
        speechQualification: {
          scope: "transport, finite PCM, input rejection and resident reload",
          intelligibility: "unqualified",
          unresolvedIssue: "https://github.com/elizaOS/eliza/issues/30679",
        },
      }
    : {}),
  fixture: nativeInference
    ? "Production native inference host and APK-packaged model artifacts"
    : "Minimal WebView page; production MainActivity, Agent library and ElizaAgentService",
  pass: false,
  problems: [],
  artifacts: [],
};
const lease = await acquireDeviceLease(`android:${serial}`, { waitMs: 0 });
let installed = false;
let samplerPath: string | null = null;
let samplerReady = false;
try {
  if (adb("shell", "getprop", "ro.kernel.qemu").trim() !== "1")
    throw new Error("Use a disposable Android emulator");
  if (!adb("shell", "getprop", "ro.product.cpu.abilist").includes("x86_64"))
    throw new Error("This host lane currently requires an x86_64 emulator");
  if (adb("shell", "pm", "list", "packages", "ai.elizaos.app").trim())
    throw new Error("Refusing to replace an existing Eliza installation");
  if (nativeInference) {
    if (process.env.ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB === "1")
      throw new Error(
        "Native inference requires the native library; unset ELIZA_ANDROID_SKIP_FORK_LLAMA_LIB",
      );
    for (const abi of ["arm64-v8a", "x86_64"]) {
      logged(
        `inference-build-${abi}.log`,
        process.execPath,
        [
          "packages/app/scripts/stage-elizavoice-lib.ts",
          "--abi",
          abi,
          "--variant",
          "cpu",
        ],
        1200000,
      );
    }
  }
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
  const voiceAssets = path.join(assets, "agent/models/voice");
  fs.rmSync(voiceAssets, { recursive: true, force: true });
  if (speech && speechModelDir) {
    fs.mkdirSync(voiceAssets, { recursive: true });
    for (const name of ["kokoro-82m-v1_0.gguf", "af_sam.bin"]) {
      fs.copyFileSync(
        path.join(speechModelDir, name),
        path.join(voiceAssets, name),
      );
    }
  }
  if (!nativeInference) {
    logged(
      "filesystem-build.log",
      "bun",
      [
        "build",
        "packages/app/test/android-native-filesystem/contract.ts",
        "--target=bun",
        "--conditions=eliza-source",
        `--outfile=${path.join(assets, "filesystem-contract.js")}`,
      ],
      120000,
    );
    report.filesystemBundleSha256 = hash(
      path.join(assets, "filesystem-contract.js"),
    );
  }
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
  if (embedding) {
    fs.copyFileSync(
      path.join(root, "node_modules/@capacitor/core/dist/capacitor.js"),
      path.join(assets, "public/capacitor.js"),
    );
    fs.writeFileSync(
      path.join(assets, "public/index.html"),
      '<!doctype html><html><head><script src="/capacitor.js"></script></head><body>Android embedding verification</body></html>',
    );
  }
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
  // This helper is restricted to this disposable, debuggable emulator and root.
  if (
    !nativeInference &&
    adb("shell", "getprop", "ro.debuggable").trim() === "1"
  ) {
    try {
      if (adb("shell", "su", "0", "id", "-u").trim() !== "0")
        throw new Error("root unavailable");
      const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
      if (!sdk) throw new Error("Android SDK unavailable");
      const ndkRoot = path.join(sdk, "ndk");
      const ndk = fs
        .readdirSync(ndkRoot)
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .at(-1);
      if (!ndk) throw new Error("Android NDK unavailable");
      const host =
        process.platform === "darwin" ? "darwin-x86_64" : "linux-x86_64";
      const compiler = path.join(
        ndkRoot,
        ndk,
        "toolchains/llvm/prebuilt",
        host,
        "bin/x86_64-linux-android26-clang",
      );
      const binary = path.join(output, "startup-pc-sampler");
      command(compiler, [
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        path.join(fixture, "startup-pc-sampler.c"),
        "-o",
        binary,
      ]);
      samplerPath = `/data/local/tmp/eliza-startup-pc-${process.pid}`;
      adb("push", binary, samplerPath);
      adb("shell", "chmod", "755", samplerPath);
      samplerReady = true;
    } catch (error) {
      report.startupSampler = "unavailable";
      report.startupSamplerError =
        error instanceof Error ? error.name : "Error";
    }
  }
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
      ...(samplerReady && samplerPath
        ? ["-e", "startupPcSampler", samplerPath]
        : []),
      "-e",
      "class",
      embedding
        ? "ai.elizaos.app.BionicEmbeddingInstrumentedTest,ai.elizaos.app.CapacitorBgeInstrumentedTest"
        : speech
          ? "ai.elizaos.app.BionicSpeechInstrumentedTest"
          : "ai.elizaos.app.NativeAgentLifecycleInstrumentedTest,ai.elizaos.app.NativeFilesystemInstrumentedTest",
      "ai.elizaos.app.test/androidx.test.runner.AndroidJUnitRunner",
    ],
    360000,
  );
  const parsed = parseInstrumentation(result, speech ? 1 : 2);
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
  if (embedding) {
    for (const name of [
      "bionic-embedding-proof.json",
      "capacitor-embedding-proof.json",
    ]) {
      if (!report.artifacts.some((artifact) => artifact.path === name))
        report.problems.push(`Missing complete embedding proof: ${name}`);
    }
  }
  if (!nativeInference) {
    for (const name of ["filesystem-write.json", "filesystem-reopen.json"]) {
      if (!report.artifacts.some((artifact) => artifact.path === name))
        report.problems.push(`Missing app-sandbox filesystem proof: ${name}`);
    }
  }
  if (speech) {
    for (const name of ["bionic-speech-proof.json", "bionic-speech.wav"]) {
      if (!report.artifacts.some((artifact) => artifact.path === name))
        report.problems.push(`Missing complete speech proof: ${name}`);
    }
  }
  report.pass = parsed.pass && report.problems.length === 0;
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
          "BionicEmbeddingProof:I",
          "ElizaVoiceNative:V",
          "Capacitor:V",
          "Capacitor/Plugin:V",
          "ElizaBionicInference:V",
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
  if (samplerPath) {
    try {
      adb("shell", "rm", samplerPath);
    } catch {
      report.problems.push("startup sampler cleanup failed");
      report.pass = false;
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
  `${report.pass ? "PASS" : "FAIL"} Android ${scenario}\nEvidence: ${path.join(output, "report.json")}`,
);
if (!report.pass) process.exitCode = 1;
