#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const ISSUE = "9958";

const DIMENSIONS = {
  platform: [
    "web",
    "linux",
    "macos-electrobun",
    "windows-electrobun",
    "ios",
    "android",
  ],
  transcriptionState: ["off", "on"],
  chimeIn: ["should-respond", "should-not-respond"],
  wakewordContext: [
    "idle-wake",
    "already-listening-wake-inert",
    "mid-transcription-wake",
  ],
  noiseRejection: [
    "quiet",
    "noisy-reverberant",
    "echo-self-voice",
    "overlapping-speech",
  ],
  voices: ["owner", "enrolled-contact", "unknown", "multi-speaker"],
};

const UI_SMOKE_MATRIX_ENV = {
  ELIZA_UI_SMOKE_SKIP_BUILD: "1",
  ELIZA_UI_SMOKE_SKIP_VIEW_BUILD: "1",
  ELIZA_UI_SMOKE_SKIP_CORE_BUILD: "1",
};

const CELLS = [
  {
    id: "web.fake-mic.roundtrip",
    title:
      "Web fake-device mic capture -> ASR -> agent -> local TTS + barge-in",
    platform: "web",
    dimensions: {
      transcriptionState: "off",
      chimeIn: "should-respond",
      wakewordContext: "idle-wake",
      noiseRejection: "quiet",
      voices: "owner",
    },
    class: "live-client-audio-barge-in",
    command: [
      "bun",
      "run",
      "--cwd",
      "packages/app",
      "test:e2e",
      "test/ui-smoke/voice-realaudio.spec.ts",
    ],
    env: UI_SMOKE_MATRIX_ENV,
    evidence: ["packages/app/test-results", "e2e-recordings/app/test-results"],
    probe: "web",
  },
  {
    id: "web.fake-mic.transcript-roundtrip",
    title:
      "Web fake-device transcript capture -> record -> player -> chat attachment + voice-control bridge parity",
    platform: "web",
    dimensions: {
      transcriptionState: "on",
      chimeIn: "should-not-respond",
      wakewordContext: "mid-transcription-wake",
      noiseRejection: "quiet",
      voices: "owner",
    },
    class: "transcripts-roundtrip-voice-control-bridge-parity",
    command: [
      "bun",
      "run",
      "--cwd",
      "packages/app",
      "test:e2e",
      "test/ui-smoke/transcript-realaudio.spec.ts",
    ],
    env: UI_SMOKE_MATRIX_ENV,
    evidence: ["packages/app/test-results", "e2e-recordings/app/test-results"],
    probe: "web",
  },
  {
    id: "web.workbench.respond-no-respond",
    title: "Headful workbench should-respond / should-not-respond client cells",
    platform: "web",
    dimensions: {
      transcriptionState: "off",
      chimeIn: "should-not-respond",
      wakewordContext: "idle-wake",
      noiseRejection: "quiet",
      voices: "multi-speaker",
    },
    class: "chime-in-matrix",
    command: [
      "bun",
      "run",
      "--cwd",
      "packages/app",
      "test:e2e",
      "test/ui-smoke/voice-workbench-response-state-sse.spec.ts",
    ],
    env: UI_SMOKE_MATRIX_ENV,
    evidence: [
      ".github/issue-evidence/8785-voice-headful",
      "packages/app/test-results",
    ],
    probe: "web",
  },
  {
    id: "linux.fused-acoustic.workbench-real",
    title:
      "Linux fused ASR/VAD/diarization/Kokoro workbench real-service matrix",
    platform: "linux",
    dimensions: {
      transcriptionState: "off",
      chimeIn: "should-respond",
      wakewordContext: "idle-wake",
      noiseRejection: "noisy-reverberant",
      voices: "multi-speaker",
    },
    class: "real-acoustic-workbench",
    command: [
      "bun",
      "run",
      "--cwd",
      "plugins/plugin-local-inference",
      "voice:workbench",
      "--real",
    ],
    evidence: [
      "$VOICE_REAL_MATRIX_OUT/voice-workbench-real",
      ".github/issue-evidence/9147-real-audio-matrix-m4max.md",
    ],
    probe: "linuxFused",
  },
  {
    id: "linux.fused-acoustic.barge-in",
    title: "Linux fused voice barge-in latency and cancellation harness",
    platform: "linux",
    dimensions: {
      transcriptionState: "off",
      chimeIn: "should-respond",
      wakewordContext: "already-listening-wake-inert",
      noiseRejection: "echo-self-voice",
      voices: "owner",
    },
    class: "barge-in",
    command: [
      "bun",
      "run",
      "--cwd",
      "plugins/plugin-local-inference",
      "voice:bargein-bench",
    ],
    evidence: ["plugins/plugin-local-inference/native/verify"],
    probe: "linuxFused",
  },
  {
    id: "macos.electrobun.live-roundtrip",
    title:
      "macOS Electrobun live mic -> ASR -> agent -> Kokoro -> speaker loop",
    platform: "macos-electrobun",
    dimensions: {
      transcriptionState: "off",
      chimeIn: "should-respond",
      wakewordContext: "idle-wake",
      noiseRejection: "quiet",
      voices: "owner",
    },
    class: "desktop-live-voice",
    command: ["bun", "run", "--cwd", "packages/app", "test:desktop:voice"],
    env: { ELIZA_VOICE_DESKTOP_SELFTEST: "1" },
    evidence: [
      "$ELIZA_VOICE_MATRIX_OUT/macos.electrobun.live-roundtrip",
      "packages/app/test-results",
    ],
    probe: "macosElectrobun",
  },
  {
    id: "windows.electrobun.live-roundtrip",
    title:
      "Windows Electrobun live mic -> ASR -> agent -> Kokoro -> speaker loop",
    platform: "windows-electrobun",
    dimensions: {
      transcriptionState: "off",
      chimeIn: "should-respond",
      wakewordContext: "idle-wake",
      noiseRejection: "quiet",
      voices: "owner",
    },
    class: "desktop-live-voice",
    command: ["bun", "run", "--cwd", "packages/app", "test:desktop:voice"],
    env: { ELIZA_VOICE_DESKTOP_SELFTEST: "1" },
    evidence: [
      "$ELIZA_VOICE_MATRIX_OUT/windows.electrobun.live-roundtrip",
      "packages/app/test-results",
    ],
    probe: "windowsElectrobun",
  },
  {
    id: "ios.sim-or-device.voice-roundtrip",
    title: "iOS simulator/device voice self-test and capture evidence",
    platform: "ios",
    dimensions: {
      transcriptionState: "off",
      chimeIn: "should-respond",
      wakewordContext: "idle-wake",
      noiseRejection: "quiet",
      voices: "owner",
    },
    class: "mobile-live-voice",
    command: [
      "bun",
      "run",
      "--cwd",
      "packages/app",
      "capture:ios-sim",
      "--",
      "--issue",
      ISSUE,
      "--slug",
      "voice-ios",
    ],
    evidence: [`.github/issue-evidence/${ISSUE}-voice-ios-ios-sim.*`],
    probe: "ios",
  },
  {
    id: "ios.talkmode.native-bridge",
    title:
      "TalkMode iOS transcript, permission, state, and barge-in bridge contracts",
    platform: "ios",
    dimensions: {
      transcriptionState: "off",
      chimeIn: "should-respond",
      wakewordContext: "already-listening-wake-inert",
      noiseRejection: "echo-self-voice",
      voices: "owner",
    },
    class: "native-bridge-unit",
    command: [
      "swift",
      "test",
      "--disable-index-store",
      "--package-path",
      "plugins/plugin-native-talkmode/ios",
    ],
    evidence: ["plugins/plugin-native-talkmode/ios/Tests"],
    probe: "swiftPackage",
  },
  {
    id: "ios.swabble.native-bridge",
    title: "Swabble iOS wake-firing -> JS bridge event contract",
    platform: "ios",
    dimensions: {
      transcriptionState: "off",
      chimeIn: "should-respond",
      wakewordContext: "idle-wake",
      noiseRejection: "quiet",
      voices: "owner",
    },
    class: "native-bridge-unit",
    command: [
      "swift",
      "test",
      "--disable-index-store",
      "--package-path",
      "plugins/plugin-native-swabble/ios",
    ],
    evidence: ["plugins/plugin-native-swabble/ios/Tests"],
    probe: "swiftPackage",
  },
  {
    id: "android.device.voice-roundtrip",
    title:
      "Android device WebView real on-device STT -> agent -> TTS voice self-test",
    platform: "android",
    dimensions: {
      transcriptionState: "off",
      chimeIn: "should-respond",
      wakewordContext: "idle-wake",
      noiseRejection: "quiet",
      voices: "owner",
    },
    class: "mobile-live-voice",
    command: ["bun", "run", "--cwd", "packages/app", "test:e2e:android:local"],
    evidence: ["packages/app/test-results", ".github/issue-evidence"],
    probe: "android",
  },
  {
    id: "android.talkmode.native-bridge",
    title:
      "TalkMode Android capture lifecycle, transcript, permission, and barge-in bridge contracts",
    platform: "android",
    dimensions: {
      transcriptionState: "off",
      chimeIn: "should-respond",
      wakewordContext: "already-listening-wake-inert",
      noiseRejection: "echo-self-voice",
      voices: "owner",
    },
    class: "native-bridge-unit",
    command: [
      "./gradlew",
      "-p",
      "../../../scripts/android-voice-bridge-gradle",
      ":elizaos-capacitor-talkmode:testDebugUnitTest",
    ],
    cwd: "packages/app-core/platforms/android",
    evidence: ["plugins/plugin-native-talkmode/android/src/test/java"],
    probe: "androidGradle",
  },
  {
    id: "android.swabble.native-bridge",
    title: "Swabble Android wake-firing -> JS bridge event contract",
    platform: "android",
    dimensions: {
      transcriptionState: "off",
      chimeIn: "should-respond",
      wakewordContext: "idle-wake",
      noiseRejection: "quiet",
      voices: "owner",
    },
    class: "native-bridge-unit",
    command: [
      "./gradlew",
      "-p",
      "../../../scripts/android-voice-bridge-gradle",
      ":elizaos-capacitor-swabble:testDebugUnitTest",
    ],
    cwd: "packages/app-core/platforms/android",
    evidence: ["plugins/plugin-native-swabble/android/src/test/java"],
    probe: "androidGradle",
  },
  {
    id: "wake.openwakeword.real-head",
    title: "Real openWakeWord head wake-context cells",
    platform: "linux",
    dimensions: {
      transcriptionState: "on",
      chimeIn: "should-not-respond",
      wakewordContext: "mid-transcription-wake",
      noiseRejection: "overlapping-speech",
      voices: "multi-speaker",
    },
    class: "wakeword-device-gap",
    command: ["node", "packages/scripts/voice-openwakeword-eval.mjs"],
    evidence: [
      "$ELIZA_VOICE_MATRIX_OUT/wake.openwakeword.real-head/openwakeword-eval.json",
      "$ELIZA_VOICE_OPENWAKEWORD_REPORT",
    ],
    probe: "openWakeWord",
  },
  {
    id: "stt.stage-b.apple-sfspeech",
    title:
      "Stage-B STT Apple arm: real on-device SFSpeechRecognizer latency/WER over synthesised speech (quiet + 10dB noise)",
    platform: "macos-electrobun",
    dimensions: {
      transcriptionState: "on",
      chimeIn: "should-respond",
      wakewordContext: "idle-wake",
      noiseRejection: "noisy-reverberant",
      voices: "owner",
    },
    class: "stt-evaluation",
    command: ["node", "packages/scripts/stage-b-stt-bench.mjs"],
    evidence: [".github/issue-evidence/9958-stt-stage-b-eval"],
    probe: "stageBSttApple",
  },
  {
    id: "stt.stage-b.evaluation",
    title:
      "Stage-B STT evaluation: iOS battery/energy + Android SpeechRecognizer (NNAPI) vs fused ASR",
    platform: "android",
    dimensions: {
      transcriptionState: "on",
      chimeIn: "should-respond",
      wakewordContext: "idle-wake",
      noiseRejection: "noisy-reverberant",
      voices: "multi-speaker",
    },
    class: "stt-evaluation",
    command: ["node", "packages/scripts/voice-stage-b-eval.mjs"],
    evidence: [
      "$ELIZA_VOICE_MATRIX_OUT/stt.stage-b.evaluation/stage-b-eval.json",
      "$ELIZA_VOICE_STAGE_B_REPORT",
    ],
    probe: "stageBStt",
  },
];

function parseArgs(argv) {
  const args = {
    run: false,
    out: path.join(".github", "issue-evidence", `${ISSUE}-voice-matrix`),
    platforms: new Set(),
    includeHeavy: false,
    requireGreen: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--run") args.run = true;
    else if (token === "--include-heavy") args.includeHeavy = true;
    else if (token === "--require-green") args.requireGreen = true;
    else if (token === "--out") args.out = argv[++i] ?? args.out;
    else if (token === "--platform") {
      for (const p of String(argv[++i] ?? "").split(",")) {
        if (p.trim()) args.platforms.add(p.trim());
      }
    }
  }
  return args;
}

function commandExists(name) {
  const cmd = process.platform === "win32" ? "where" : "which";
  return spawnSync(cmd, [name], { stdio: "ignore" }).status === 0;
}

function findFiles(root, predicate, found = []) {
  if (!fs.existsSync(root)) return found;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) findFiles(fullPath, predicate, found);
    else if (entry.isFile() && predicate(fullPath)) found.push(fullPath);
  }
  return found;
}

function hasPackagedDesktopLauncher(platform) {
  const explicit = process.env.ELIZA_TEST_PACKAGED_LAUNCHER_PATH?.trim();
  if (explicit) return fs.existsSync(explicit);
  const roots = [
    path.join(REPO_ROOT, "packages/app-core/platforms/electrobun/build"),
    path.join(REPO_ROOT, "packages/app-core/platforms/electrobun/artifacts"),
  ];
  if (platform === "darwin") {
    return roots.some(
      (root) =>
        findFiles(root, (fullPath) =>
          fullPath.endsWith(
            `${path.sep}Contents${path.sep}MacOS${path.sep}launcher`,
          ),
        ).length > 0,
    );
  }
  if (platform === "win32") {
    return roots.some(
      (root) =>
        findFiles(
          root,
          (fullPath) =>
            path.basename(fullPath).toLowerCase() === "launcher.exe",
        ).length > 0,
    );
  }
  return false;
}

function oneLine(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function readDefaultIosAppId() {
  const fromEnv =
    process.env.ELIZA_VOICE_IOS_APP_ID?.trim() ||
    process.env.ELIZA_IOS_APP_ID?.trim();
  if (fromEnv) return fromEnv;

  const appConfigPath = path.join(REPO_ROOT, "packages/app/app.config.ts");
  try {
    const source = fs.readFileSync(appConfigPath, "utf8");
    return source.match(/\bappId:\s*["']([^"']+)["']/)?.[1] ?? "ai.elizaos.app";
  } catch {
    return "ai.elizaos.app";
  }
}

function readDefaultAndroidAppId() {
  const fromEnv =
    process.env.ELIZA_VOICE_ANDROID_APP_ID?.trim() ||
    process.env.ELIZA_ANDROID_APP_ID?.trim() ||
    process.env.ELIZA_APP_ID?.trim();
  if (fromEnv) return fromEnv;

  const appConfigPath = path.join(REPO_ROOT, "packages/app/app.config.ts");
  try {
    const source = fs.readFileSync(appConfigPath, "utf8");
    return source.match(/\bappId:\s*["']([^"']+)["']/)?.[1] ?? "ai.elizaos.app";
  } catch {
    return "ai.elizaos.app";
  }
}

function simctl(args) {
  return spawnSync("xcrun", ["simctl", ...args], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function adb(args) {
  return spawnSync("adb", args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function attachedAndroidDevice() {
  const result = adb(["devices"]);
  if (result.status !== 0) {
    const detail = oneLine(result.stderr || result.stdout);
    return {
      serial: null,
      reason: `adb devices failed${detail ? `: ${detail}` : ""}`,
    };
  }

  const rows = String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial]) => serial && serial !== "List");
  const requested = process.env.ANDROID_SERIAL?.trim();
  if (requested) {
    const row = rows.find(([serial]) => serial === requested);
    if (row?.[1] === "device") return { serial: requested, reason: null };
    return {
      serial: null,
      reason: `ELIZA_VOICE_ANDROID_READY=1 but ANDROID_SERIAL=${requested} is not attached in device state`,
    };
  }

  const device = rows.find(([, state]) => state === "device");
  if (device?.[0]) return { serial: device[0], reason: null };
  return {
    serial: null,
    reason:
      "ELIZA_VOICE_ANDROID_READY=1 but no Android device/emulator is attached in device state; attach a device/emulator and install the current app before capture",
  };
}

function installedAndroidApp(serial, appId) {
  const result = adb(["-s", serial, "shell", "pm", "path", appId]);
  if (result.status === 0 && /^package:/m.test(result.stdout ?? "")) {
    return { installed: true, reason: null };
  }
  const detail = oneLine(result.stderr || result.stdout);
  return {
    installed: false,
    reason: `ELIZA_VOICE_ANDROID_READY=1 but ${appId} is not installed on Android device ${serial}; build/redeploy the current APK before capture${detail ? ` (${detail})` : ""}`,
  };
}

function bootedIosSimulator() {
  const result = simctl(["list", "devices", "booted", "--json"]);
  if (result.status !== 0) {
    const detail = oneLine(result.stderr || result.stdout);
    return {
      device: null,
      reason: `xcrun simctl list devices booted failed${detail ? `: ${detail}` : ""}`,
    };
  }

  let json;
  try {
    json = JSON.parse(result.stdout || "{}");
  } catch (error) {
    return {
      device: null,
      reason: `xcrun simctl list devices booted returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  for (const [runtime, devices] of Object.entries(json.devices ?? {})) {
    if (!String(runtime).toLowerCase().includes("ios")) continue;
    for (const device of Array.isArray(devices) ? devices : []) {
      if (device?.state === "Booted" && device?.udid) {
        return {
          device: {
            udid: device.udid,
            name: device.name ?? device.udid,
            runtime,
          },
          reason: null,
        };
      }
    }
  }

  return {
    device: null,
    reason:
      "ELIZA_VOICE_IOS_READY=1 but no booted iOS simulator is available; boot a simulator and install the current app before capture",
  };
}

function installedIosAppContainer(udid, appId) {
  const result = simctl(["get_app_container", udid, appId, "data"]);
  const containerPath = oneLine(result.stdout);
  if (result.status === 0 && containerPath) {
    return { path: containerPath, reason: null };
  }
  const detail = oneLine(result.stderr || result.stdout);
  return {
    path: null,
    reason: `ELIZA_VOICE_IOS_READY=1 but ${appId} is not installed on booted simulator ${udid}; build/redeploy the current iOS app before capture${detail ? ` (${detail})` : ""}`,
  };
}

function runCapture(command, cwd, extraEnv = {}, context = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(command[0], command.slice(1), {
    cwd: path.resolve(REPO_ROOT, cwd ?? "."),
    encoding: "utf8",
    env: {
      ...process.env,
      ...(context.matrixOut
        ? { ELIZA_VOICE_MATRIX_OUT: context.matrixOut }
        : {}),
      ...(context.cellId ? { ELIZA_VOICE_MATRIX_CELL_ID: context.cellId } : {}),
      ...extraEnv,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status ?? 1,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function probeCell(cell) {
  if (!commandExists("bun")) {
    return { available: false, reason: "bun is not available on PATH" };
  }
  switch (cell.probe) {
    case "web":
      return {
        available: true,
        reason: "Chromium fake-device mic lane is host-runnable",
      };
    case "linuxFused":
      if (process.platform !== "linux")
        return {
          available: false,
          reason: `requires Linux runner; current=${process.platform}`,
        };
      if (!process.env.ELIZA_INFERENCE_LIBRARY)
        return {
          available: false,
          reason: "ELIZA_INFERENCE_LIBRARY is not set",
        };
      if (!process.env.ELIZA_ASR_BUNDLE)
        return { available: false, reason: "ELIZA_ASR_BUNDLE is not set" };
      return {
        available: true,
        reason: "Linux fused voice environment is provisioned",
      };
    case "openWakeWord":
      if (!process.env.ELIZA_VOICE_OPENWAKEWORD_REPORT?.trim()) {
        return {
          available: false,
          reason:
            "ELIZA_VOICE_OPENWAKEWORD_REPORT is not set to a reviewed real-head openWakeWord JSON report",
        };
      }
      if (
        !fs.existsSync(
          path.resolve(REPO_ROOT, process.env.ELIZA_VOICE_OPENWAKEWORD_REPORT),
        )
      ) {
        return {
          available: true,
          reason: `openWakeWord report configured but missing: ${process.env.ELIZA_VOICE_OPENWAKEWORD_REPORT}`,
        };
      }
      return {
        available: true,
        reason: `openWakeWord report configured: ${process.env.ELIZA_VOICE_OPENWAKEWORD_REPORT}`,
      };
    case "macosElectrobun":
      if (process.platform !== "darwin")
        return {
          available: false,
          reason: `requires macOS runner; current=${process.platform}`,
        };
      if (process.env.ELIZA_VOICE_MACOS_ELECTROBUN_READY !== "1") {
        return {
          available: false,
          reason:
            "set ELIZA_VOICE_MACOS_ELECTROBUN_READY=1 on a macOS Electrobun voice runner with loopback mic/audio capture",
        };
      }
      if (!process.env.ELIZA_VOICE_DESKTOP_API_BASE?.trim()) {
        return {
          available: false,
          reason:
            "ELIZA_VOICE_DESKTOP_API_BASE is not set to a real app-core API base",
        };
      }
      if (!hasPackagedDesktopLauncher("darwin")) {
        return {
          available: false,
          reason:
            "packaged macOS Electrobun launcher is missing; build/redeploy the latest desktop app before capture",
        };
      }
      return {
        available: true,
        reason:
          "macOS Electrobun voice runner enabled with packaged launcher and API base",
      };
    case "windowsElectrobun":
      if (process.platform !== "win32")
        return {
          available: false,
          reason: `requires Windows runner; current=${process.platform}`,
        };
      if (process.env.ELIZA_VOICE_WINDOWS_ELECTROBUN_READY !== "1") {
        return {
          available: false,
          reason:
            "set ELIZA_VOICE_WINDOWS_ELECTROBUN_READY=1 on a Windows Electrobun voice runner with loopback mic/audio capture",
        };
      }
      if (!process.env.ELIZA_VOICE_DESKTOP_API_BASE?.trim()) {
        return {
          available: false,
          reason:
            "ELIZA_VOICE_DESKTOP_API_BASE is not set to a real app-core API base",
        };
      }
      if (!hasPackagedDesktopLauncher("win32")) {
        return {
          available: false,
          reason:
            "packaged Windows Electrobun launcher is missing; build/redeploy the latest desktop app before capture",
        };
      }
      return {
        available: true,
        reason:
          "Windows Electrobun voice runner enabled with packaged launcher and API base",
      };
    case "ios":
      if (process.platform !== "darwin")
        return {
          available: false,
          reason: `requires macOS host with xcrun; current=${process.platform}`,
        };
      if (!commandExists("xcrun"))
        return { available: false, reason: "xcrun is not available" };
      if (process.env.ELIZA_VOICE_IOS_READY !== "1") {
        return {
          available: false,
          reason:
            "set ELIZA_VOICE_IOS_READY=1 after booting an iOS simulator and installing the current app build with voice assets",
        };
      }
      {
        const booted = bootedIosSimulator();
        if (!booted.device) {
          return { available: false, reason: booted.reason };
        }
        const appId = readDefaultIosAppId();
        const container = installedIosAppContainer(booted.device.udid, appId);
        if (!container.path) {
          return { available: false, reason: container.reason };
        }
        return {
          available: true,
          reason: `iOS voice capture runner enabled for ${appId} on ${booted.device.name} (${booted.device.udid})`,
        };
      }
    case "swiftPackage":
      if (process.platform !== "darwin")
        return {
          available: false,
          reason: `requires macOS Swift toolchain; current=${process.platform}`,
        };
      if (!commandExists("swift"))
        return { available: false, reason: "swift is not available on PATH" };
      return {
        available: true,
        reason: "macOS Swift Package test toolchain is available",
      };
    case "android":
      if (!commandExists("adb"))
        return { available: false, reason: "adb is not available" };
      if (process.env.ELIZA_VOICE_ANDROID_READY !== "1") {
        return {
          available: false,
          reason:
            "set ELIZA_VOICE_ANDROID_READY=1 on an Android device runner with the current APK and voice assets installed",
        };
      }
      {
        const device = attachedAndroidDevice();
        if (!device.serial) return { available: false, reason: device.reason };
        const appId = readDefaultAndroidAppId();
        const app = installedAndroidApp(device.serial, appId);
        if (!app.installed) return { available: false, reason: app.reason };
        return {
          available: true,
          reason: `Android voice runner enabled for ${appId} on ${device.serial}`,
        };
      }
    case "androidGradle": {
      const androidDir = path.join(
        REPO_ROOT,
        cell.cwd ?? "packages/app-core/platforms/android",
      );
      if (!fs.existsSync(androidDir)) {
        return {
          available: false,
          reason: `${path.relative(REPO_ROOT, androidDir)} is not generated; run packages/app cap:sync:android or build:android first`,
        };
      }
      const gradlew = path.join(
        androidDir,
        process.platform === "win32" ? "gradlew.bat" : "gradlew",
      );
      if (!fs.existsSync(gradlew))
        return {
          available: false,
          reason: "generated Android project has no Gradle wrapper",
        };
      const bridgeProjectDir = path.join(
        REPO_ROOT,
        "packages",
        "scripts",
        "android-voice-bridge-gradle",
      );
      if (!fs.existsSync(path.join(bridgeProjectDir, "settings.gradle")))
        return {
          available: false,
          reason: "Android voice bridge Gradle project is missing",
        };
      return {
        available: true,
        reason: "Android voice bridge Gradle project exists",
      };
    }
    case "stageBSttApple":
      if (process.platform !== "darwin")
        return {
          available: false,
          reason: `Apple SFSpeechRecognizer Stage-B arm requires macOS; current=${process.platform}`,
        };
      if (!commandExists("swift"))
        return {
          available: false,
          reason:
            "swift toolchain not available to build the Stage-B recognizer",
        };
      if (!commandExists("say") || !commandExists("afconvert"))
        return {
          available: false,
          reason:
            "macOS say/afconvert not available for on-device speech synthesis",
        };
      return {
        available: true,
        reason:
          "macOS on-device SFSpeechRecognizer + say/afconvert available for a real Stage-B latency/WER measurement",
      };
    case "stageBStt": {
      const report = process.env.ELIZA_VOICE_STAGE_B_REPORT?.trim();
      if (!report) {
        return {
          available: false,
          reason:
            "ELIZA_VOICE_STAGE_B_REPORT is not set to a reviewed iOS+Android+fused ASR Stage-B JSON report",
        };
      }
      const reportPath = path.resolve(REPO_ROOT, report);
      if (!fs.existsSync(reportPath)) {
        return {
          available: true,
          reason: `Stage-B report configured but missing: ${path.relative(REPO_ROOT, reportPath)}`,
        };
      }
      return {
        available: true,
        reason: `Stage-B report configured: ${path.relative(REPO_ROOT, reportPath)}`,
      };
    }
    default:
      return { available: false, reason: `unknown probe ${cell.probe}` };
  }
}

function statusFor(args, probe, execution) {
  if (!probe.available) return "skip";
  if (!args.run) return "pending";
  if (!execution) return "pending";
  return execution.exitCode === 0 ? "pass" : "fail";
}

function renderMarkdown(report) {
  const rows = report.cells.map((cell) => {
    const cmd = cell.command
      .map((part) => (part.includes(" ") ? JSON.stringify(part) : part))
      .join(" ");
    return `| \`${cell.id}\` | ${cell.status} | ${cell.platform} | ${cell.class} | ${cell.probe.reason.replaceAll("|", "\\|")} | \`${cmd.replaceAll("|", "\\|")}\` |`;
  });
  return [
    "# Voice Live Matrix",
    "",
    `Generated: ${report.generatedAt}`,
    `Host: ${report.host.platform} ${report.host.arch} (${report.host.hostname})`,
    "",
    "| Cell | Status | Platform | Class | Probe / Result | Command |",
    "|---|---:|---|---|---|---|",
    ...rows,
    "",
    "## Summary",
    "",
    `- Pass: ${report.summary.pass}`,
    `- Fail: ${report.summary.fail}`,
    `- Pending: ${report.summary.pending}`,
    `- Skip: ${report.summary.skip}`,
    "",
    "Hardware-unavailable cells are explicit `skip` rows. They are not evidence of platform coverage.",
    "",
  ].join("\n");
}

function renderHtml(report) {
  const esc = (s) =>
    String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const rows = report.cells
    .map(
      (cell) =>
        `<tr class="${esc(cell.status)}"><td><code>${esc(cell.id)}</code><br>${esc(cell.title)}</td><td>${esc(cell.status)}</td><td>${esc(cell.platform)}</td><td>${esc(cell.class)}</td><td>${esc(
          Object.entries(cell.dimensions)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n"),
        )}</td><td>${esc(cell.probe.reason)}</td><td><code>${esc(cell.command.join(" "))}</code></td><td>${esc(cell.evidence.join("\n"))}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<meta charset="utf-8">
<title>Voice Live Matrix</title>
<style>
body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:24px;background:#fafafa;color:#151515}
table{width:100%;border-collapse:collapse;background:white}
th,td{border:1px solid #ddd;padding:8px;vertical-align:top;white-space:pre-wrap}
th{background:#f1f1f1;text-align:left}
.pass td:nth-child(2){color:#116b2d;font-weight:700}
.fail td:nth-child(2){color:#9a1b1b;font-weight:700}
.skip td:nth-child(2),.pending td:nth-child(2){color:#7a5b00;font-weight:700}
code{font-size:12px}
</style>
<h1>Voice Live Matrix</h1>
<p>Generated ${esc(report.generatedAt)} on ${esc(report.host.platform)} ${esc(report.host.arch)} (${esc(report.host.hostname)}).</p>
<p>Pass ${report.summary.pass} · Fail ${report.summary.fail} · Pending ${report.summary.pending} · Skip ${report.summary.skip}</p>
<table><thead><tr><th>Cell</th><th>Status</th><th>Platform</th><th>Class</th><th>Dimensions</th><th>Probe / Result</th><th>Command</th><th>Evidence</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const outDir = path.resolve(REPO_ROOT, args.out);
  const selected = CELLS.filter(
    (cell) =>
      args.platforms.size === 0 ||
      args.platforms.has(cell.platform) ||
      args.platforms.has(cell.id),
  );
  const platformFilters = Array.from(args.platforms).sort();
  const selectionError =
    args.platforms.size > 0 && selected.length === 0
      ? `no voice matrix cells matched --platform=${platformFilters.join(",")}`
      : null;
  const cells = [];
  for (const cell of selected) {
    const probe = probeCell(cell);
    let execution = null;
    if (args.run && probe.available) {
      execution = runCapture(cell.command, cell.cwd, cell.env, {
        matrixOut: outDir,
        cellId: cell.id,
      });
      probe.reason =
        execution.exitCode === 0
          ? `command passed (${execution.finishedAt})`
          : `command failed with exit ${execution.exitCode}${execution.signal ? ` signal ${execution.signal}` : ""}`;
    }
    cells.push({
      ...cell,
      cwd: cell.cwd ?? ".",
      env: cell.env ?? {},
      probe,
      execution: execution
        ? {
            exitCode: execution.exitCode,
            signal: execution.signal,
            startedAt: execution.startedAt,
            finishedAt: execution.finishedAt,
            stdoutTail: execution.stdout.slice(-4000),
            stderrTail: execution.stderr.slice(-4000),
          }
        : null,
      status: statusFor(args, probe, execution),
    });
  }

  const summary = { pass: 0, fail: 0, pending: 0, skip: 0 };
  for (const cell of cells) summary[cell.status] += 1;

  const report = {
    schema: "eliza_voice_live_matrix_v1",
    issue: Number(ISSUE),
    generatedAt: new Date().toISOString(),
    mode: args.run ? "run" : "probe",
    dimensions: DIMENSIONS,
    selection: {
      platformFilters,
      matched: selected.length,
      error: selectionError,
    },
    host: {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      runnerOs: process.env.RUNNER_OS ?? null,
      runnerArch: process.env.RUNNER_ARCH ?? null,
    },
    summary,
    cells,
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "voice-matrix.json"),
    JSON.stringify(report, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "voice-matrix.md"),
    renderMarkdown(report),
  );
  fs.writeFileSync(path.join(outDir, "index.html"), renderHtml(report));
  console.log(
    `[voice:matrix] wrote ${path.relative(REPO_ROOT, outDir)}/voice-matrix.json`,
  );
  console.log(
    `[voice:matrix] pass=${summary.pass} fail=${summary.fail} pending=${summary.pending} skip=${summary.skip}`,
  );
  if (selectionError) console.error(`[voice:matrix] ${selectionError}`);

  if (
    selectionError ||
    summary.fail > 0 ||
    (args.requireGreen && (summary.pending > 0 || summary.skip > 0))
  ) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(
    `[voice:matrix] ${error instanceof Error ? error.stack : String(error)}`,
  );
  process.exit(1);
});
