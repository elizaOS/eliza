#!/usr/bin/env node
/**
 * iOS Simulator voice round-trip lane for the production self-test path. Local
 * mode is authoritative and default: it validates a fresh full-Bun app, stages
 * every required inference asset, seeds canonical on-device state before React
 * mounts, and rejects results not owned by the current run. Remote mode remains
 * an explicit compatibility path for the deterministic host agent.
 *
 * The bundled fixture does not require a microphone, so ASR, agent SSE, TTS
 * decode, and playback can run headlessly. Audible speaker/acoustic-loop proof
 * remains a distinct physical-hardware claim.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildIosVoiceSelfTestPreferenceSeed,
  evaluateVoiceSelfTestReport,
  IOS_VOICE_SELFTEST_REQUEST_BUDGET_MS,
  iosLocalVoiceArtifactProblems,
  isIosVoiceSelfTestResultFresh,
  parseIosVoiceSelfTestMode,
  planIosVoiceSelfTestHost,
  REQUIRED_IOS_LOCAL_VOICE_ASSETS,
  selectIosVoiceSelfTestBootTrace,
} from "./ios-voice-selftest-lib.mjs";
import {
  DEFAULT_HOST_AGENT_PORT,
  startDeviceE2eHostAgent,
} from "./lib/host-agent.mjs";
import {
  assertIosAppRendererFresh,
  rendererManifestPathFromAppPath,
} from "./lib/ios-renderer-stamp.mjs";
import {
  clearIosSmokeDefaults,
  flushIosPreferencesCache,
  readIosPreferenceString,
  writeIosDefaultsString,
} from "./lib/ios-sim-defaults-hygiene.mjs";
import {
  captureIosSimulatorScreenshot,
  startIosSimulatorVideo,
} from "./lib/ios-simulator-capture.mjs";
import {
  copyFileIfChanged,
  stageIosFullBunSmokeModel,
} from "./mobile-local-chat-smoke.mjs";

const appDir = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const repoRoot = path.resolve(appDir, "..", "..");
const resultDir = path.join(appDir, "test-results", "ios-voice-selftest");
const cleanupHelperScript = path.join(
  repoRoot,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

const ONBOARDING_REQUEST_KEY = "eliza:ios-onboarding-smoke:request";
const ONBOARDING_RESULT_KEY = "eliza:ios-onboarding-smoke:result";
const VOICE_REQUEST_KEY = "eliza:ios-voice-selftest:request";
const VOICE_RESULT_KEY = "eliza:ios-voice-selftest:result";
const DEFAULT_HOST_AGENT_PORT_STRING = String(DEFAULT_HOST_AGENT_PORT);
const DEFAULT_VOICE_BUNDLE = path.join(
  os.homedir(),
  ".local",
  "state",
  "eliza",
  "local-inference",
  "models",
  "eliza-1-2b.bundle",
);
const LOCAL_STATE_KEYS = [
  ONBOARDING_REQUEST_KEY,
  ONBOARDING_RESULT_KEY,
  VOICE_REQUEST_KEY,
  VOICE_RESULT_KEY,
];

const has = (flag) => process.argv.includes(flag);
const val = (flag, fallback = null) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const log = (message) => console.log(`[ios-voice-selftest] ${message}`);

function printHelp() {
  console.log(`Usage: node packages/app/scripts/ios-voice-selftest-smoke.mjs [options]

Options:
  --mode local|remote       Runtime exercised by the production self-test (default: local)
  --app-path PATH           Exact iOS Simulator .app to validate and install
  --skip-install            Reuse the installed app, still validating it before launch
  --voice-bundle PATH       Source eliza-1 voice bundle (default: ${DEFAULT_VOICE_BUNDLE})
  --api-base URL            Remote mode only; omit to own a deterministic host agent
  --host-agent-port PORT    Preferred deterministic host port in remote mode
  --device NAME             Simulator to boot when none is running (default: iPhone 16 Pro)
  --no-video                Disable best-effort Simulator video capture
  --help                    Print this help`);
}

if (has("--help")) {
  printHelp();
  process.exit(0);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    stdio: options.stdio ?? "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status}`,
    );
  }
  return result.stdout?.trim() ?? "";
}

function tryRun(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd ?? repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    // error-policy:J6 optional host probe — callers treat null as an explicit
    // unavailable result and hard-fail separately when the value is required
    if (options.warnOnFailure) {
      log(
        `${options.label ?? `${command} ${args.join(" ")}`} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return null;
  }
}

function removePathRecursive(targetPath) {
  const result = spawnSync(
    "node",
    [cleanupHelperScript, path.relative(repoRoot, targetPath)],
    { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `failed to remove ${targetPath}`,
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readAppIdentity() {
  const src = fs.readFileSync(path.join(appDir, "app.config.ts"), "utf8");
  return (
    val("--app-id") ??
    src.match(/appId:\s*["']([^"']+)["']/)?.[1] ??
    "ai.elizaos.app"
  );
}

function simctl(args) {
  return run("xcrun", ["simctl", ...args], { stdio: "pipe" });
}

function bootedUdid() {
  const json = tryRun("xcrun", [
    "simctl",
    "list",
    "devices",
    "booted",
    "--json",
  ]);
  if (!json) return null;
  const parsed = JSON.parse(json);
  for (const devices of Object.values(parsed.devices ?? {})) {
    const booted = devices.find((device) => device.state === "Booted");
    if (booted?.udid) return booted.udid;
  }
  return null;
}

function ensureSimulatorBooted() {
  if (process.platform !== "darwin") {
    throw new Error("iOS voice self-test requires macOS with xcrun simctl.");
  }
  const existing = bootedUdid();
  if (existing) {
    log(`reusing booted simulator ${existing}`);
    return existing;
  }
  const target = val("--device", "iPhone 16 Pro");
  log(`booting simulator ${target}`);
  simctl(["boot", target]);
  tryRun("open", ["-a", "Simulator"]);
  const udid = bootedUdid();
  if (!udid) throw new Error(`Simulator ${target} did not reach Booted state.`);
  return udid;
}

function latestBuiltApp() {
  const derivedData = path.join(
    os.homedir(),
    "Library",
    "Developer",
    "Xcode",
    "DerivedData",
  );
  if (!fs.existsSync(derivedData)) return null;
  const output = tryRun("find", [
    derivedData,
    "-name",
    "App.app",
    "-path",
    "*/Debug-iphonesimulator/*",
    "-type",
    "d",
  ]);
  const apps = (output ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => ({ path: entry, mtimeMs: fs.statSync(entry).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return apps[0]?.path ?? null;
}

function installedAppPath(udid, appId) {
  return tryRun("xcrun", ["simctl", "get_app_container", udid, appId, "app"]);
}

function installLatestApp(udid, appId, candidatePath) {
  if (!has("--skip-install")) {
    if (!candidatePath) {
      throw new Error(
        "Could not find a Debug-iphonesimulator App.app. Build the iOS simulator app first or pass --app-path.",
      );
    }
    tryRun("xcrun", ["simctl", "terminate", udid, appId]);
    tryRun("xcrun", ["simctl", "uninstall", udid, appId]);
    log(`installing ${candidatePath}`);
    simctl(["install", udid, candidatePath]);
  }
  const installed = installedAppPath(udid, appId);
  if (!installed) {
    throw new Error(
      `${appId} is not installed in simulator ${udid}${has("--skip-install") ? " for --skip-install" : " after simctl install"}.`,
    );
  }
  return installed;
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function fileBytes(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.isFile() ? stats.size : 0;
  } catch {
    // error-policy:J3 a missing artifact is an explicit zero-byte invalid
    // signal consumed by the aggregate artifact validator below
    return 0;
  }
}

function readPlistValue(plistPath, key) {
  if (!fs.existsSync(plistPath)) return null;
  const value = tryRun("plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    plistPath,
  ]);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function appExecutablePaths(appPath) {
  const executable = readPlistValue(
    path.join(appPath, "Info.plist"),
    "CFBundleExecutable",
  );
  if (typeof executable !== "string" || !executable) return [];
  return [
    path.join(appPath, executable),
    path.join(appPath, `${executable}.debug.dylib`),
  ].filter((candidate) => fs.existsSync(candidate));
}

function validateLocalVoiceApp(appPath, expectedCommit) {
  assertIosAppRendererFresh({
    appPath,
    repoRoot,
    label: `local voice ${appPath}`,
    log,
  });
  const manifestPath = rendererManifestPathFromAppPath(appPath);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `local voice app has no renderer manifest: ${manifestPath}`,
    );
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const agentBundle = path.join(appPath, "public", "agent", "agent-bundle.js");
  const engineFramework = path.join(
    appPath,
    "Frameworks",
    "ElizaBunEngine.framework",
  );
  const engineBinary = path.join(engineFramework, "ElizaBunEngine");
  const engineInfo = path.join(engineFramework, "Info.plist");
  const executablePaths = appExecutablePaths(appPath);
  const architectures = executablePaths
    .map((binary) => tryRun("lipo", ["-archs", binary]) ?? "")
    .join(" ");
  const exportedSymbols = executablePaths
    .map((binary) => tryRun("nm", ["-gU", binary]) ?? "")
    .join("\n");
  const problems = iosLocalVoiceArtifactProblems({
    manifest,
    expectedCommit,
    agentBundleBytes: fileBytes(agentBundle),
    engineBytes: fileBytes(engineBinary),
    engineAbiVersion: readPlistValue(engineInfo, "ElizaBunEngineABIVersion"),
    engineNoJit: readPlistValue(engineInfo, "ElizaBunEngineNoJIT"),
    engineExecutionProfile: readPlistValue(
      engineInfo,
      "ElizaBunEngineExecutionProfile",
    ),
    architectures,
    exportedSymbols,
  });
  if (executablePaths.length === 0) {
    problems.push("app executable is missing");
  }
  if (problems.length > 0) {
    throw new Error(
      `local voice app failed preflight (${appPath}):\n- ${problems.join("\n- ")}\nBuild with bun run --cwd packages/app build:ios:local:sim:full-bun and the fused local-inference bridge enabled.`,
    );
  }
  const receipt = {
    appPath,
    manifest,
    agentBundle: { path: agentBundle, bytes: fileBytes(agentBundle) },
    engine: {
      path: engineBinary,
      bytes: fileBytes(engineBinary),
      sha256: sha256File(engineBinary),
      abiVersion: readPlistValue(engineInfo, "ElizaBunEngineABIVersion"),
      noJit: readPlistValue(engineInfo, "ElizaBunEngineNoJIT"),
      executionProfile: readPlistValue(
        engineInfo,
        "ElizaBunEngineExecutionProfile",
      ),
    },
    appExecutables: executablePaths.map((binary) => ({
      path: binary,
      bytes: fileBytes(binary),
      sha256: sha256File(binary),
    })),
    architectures,
  };
  log(
    `local artifact PASS commit=${manifest.commit} runtime=${manifest.runtimeMode} target=${manifest.capacitorTarget} arch=${architectures}`,
  );
  return receipt;
}

function resolveTextModelSource(voiceBundleRoot) {
  if (process.env.ELIZA_IOS_FULL_BUN_SMOKE_MODEL_PATH?.trim()) {
    return process.env.ELIZA_IOS_FULL_BUN_SMOKE_MODEL_PATH.trim();
  }
  const candidates = [
    path.join(voiceBundleRoot, "text", "eliza-1-2b-128k.gguf"),
    path.join(voiceBundleRoot, "text", "eliza-1-e2b-128k.gguf"),
  ];
  const source = candidates.find((candidate) => fs.existsSync(candidate));
  if (!source) {
    throw new Error(
      `local voice text model is missing; expected one of:\n- ${candidates.join("\n- ")}\nSet ELIZA_IOS_FULL_BUN_SMOKE_MODEL_PATH explicitly.`,
    );
  }
  return source;
}

function assetCandidates(asset) {
  if (Array.isArray(asset.candidates)) return asset.candidates;
  return asset.relativePaths.map((relativePath) => ({
    relativePath,
    destination: asset.destination,
    magic: asset.magic,
  }));
}

function inspectModelAsset(filePath, { id, minBytes, magic }) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${id} asset is missing: ${filePath}`);
  }
  const stats = fs.statSync(filePath);
  if (!stats.isFile() || stats.size < minBytes) {
    throw new Error(
      `${id} asset is not a valid file (${stats.size} bytes, minimum ${minBytes}): ${filePath}`,
    );
  }
  const prefix = Buffer.alloc(Buffer.byteLength(magic));
  const descriptor = fs.openSync(filePath, "r");
  try {
    fs.readSync(descriptor, prefix, 0, prefix.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (prefix.toString("ascii") !== magic) {
    throw new Error(
      `${id} asset has magic ${JSON.stringify(prefix.toString("ascii"))}, expected ${JSON.stringify(magic)}: ${filePath}`,
    );
  }
  return { path: filePath, bytes: stats.size, sha256: sha256File(filePath) };
}

function stageLocalVoiceModels(udid, appId, voiceBundleRoot) {
  const textSource = resolveTextModelSource(voiceBundleRoot);
  process.env.ELIZA_IOS_FULL_BUN_SMOKE_MODEL_PATH = textSource;
  let { bundleRoot, modelPath } = stageIosFullBunSmokeModel(udid, appId);
  const textSourceReceipt = inspectModelAsset(textSource, {
    id: "text-model source",
    minBytes: 1_000_000,
    magic: "GGUF",
  });
  let textDestinationReceipt = inspectModelAsset(modelPath, {
    id: "text-model destination",
    minBytes: 1_000_000,
    magic: "GGUF",
  });
  if (textDestinationReceipt.sha256 !== textSourceReceipt.sha256) {
    fs.rmSync(modelPath, { force: true });
    ({ bundleRoot, modelPath } = stageIosFullBunSmokeModel(udid, appId));
    textDestinationReceipt = inspectModelAsset(modelPath, {
      id: "text-model destination",
      minBytes: 1_000_000,
      magic: "GGUF",
    });
  }
  if (textDestinationReceipt.sha256 !== textSourceReceipt.sha256) {
    throw new Error(
      `text-model staged hash ${textDestinationReceipt.sha256} != source ${textSourceReceipt.sha256}`,
    );
  }
  const staged = [
    {
      id: "text-model",
      source: textSourceReceipt,
      destination: textDestinationReceipt,
    },
  ];

  for (const asset of REQUIRED_IOS_LOCAL_VOICE_ASSETS) {
    const candidates = assetCandidates(asset);
    const selected = candidates.find((candidate) =>
      fs.existsSync(path.join(voiceBundleRoot, candidate.relativePath)),
    );
    if (!selected) {
      throw new Error(
        `${asset.id} source is missing; expected one of:\n- ${candidates
          .map((candidate) =>
            path.join(voiceBundleRoot, candidate.relativePath),
          )
          .join("\n- ")}`,
      );
    }
    const source = path.join(voiceBundleRoot, selected.relativePath);
    const destination = path.join(bundleRoot, selected.destination);
    const sourceReceipt = inspectModelAsset(source, {
      id: asset.id,
      minBytes: asset.minBytes,
      magic: selected.magic,
    });
    for (const candidate of candidates) {
      const stalePath = path.join(bundleRoot, candidate.destination);
      if (stalePath !== destination) fs.rmSync(stalePath, { force: true });
    }
    copyFileIfChanged(source, destination);
    let destinationReceipt = inspectModelAsset(destination, {
      id: asset.id,
      minBytes: asset.minBytes,
      magic: selected.magic,
    });
    if (destinationReceipt.sha256 !== sourceReceipt.sha256) {
      fs.rmSync(destination, { force: true });
      copyFileIfChanged(source, destination);
      destinationReceipt = inspectModelAsset(destination, {
        id: asset.id,
        minBytes: asset.minBytes,
        magic: selected.magic,
      });
    }
    if (destinationReceipt.sha256 !== sourceReceipt.sha256) {
      throw new Error(
        `${asset.id} staged hash ${destinationReceipt.sha256} != source ${sourceReceipt.sha256}`,
      );
    }
    staged.push({
      id: asset.id,
      source: sourceReceipt,
      destination: destinationReceipt,
    });
  }

  const receipt = {
    sourceBundleRoot: voiceBundleRoot,
    stagedBundleRoot: bundleRoot,
    assets: staged,
  };
  fs.writeFileSync(
    path.join(resultDir, "local-voice-assets.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
  );
  log(`staged and verified ${staged.length} local inference assets`);
  return receipt;
}

function takeScreenshot(udid, label) {
  try {
    return captureIosSimulatorScreenshot({
      target: udid,
      artifactDir: resultDir,
      filename: `${label}.png`,
      log,
    });
  } catch (error) {
    // error-policy:J6 best-effort evidence capture — the test verdict still
    // comes from the machine-readable voice report
    log(
      `screenshot "${label}" failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  }
}

function startVideo(udid) {
  if (has("--no-video")) return null;
  return startIosSimulatorVideo({
    target: udid,
    artifactDir: resultDir,
    filename: "voice-selftest.mp4",
    log,
  });
}

function captureRunOwnedBootTrace(udid, appId, requestedAtMs) {
  const dataContainer = tryRun("xcrun", [
    "simctl",
    "get_app_container",
    udid,
    appId,
    "data",
  ]);
  if (!dataContainer) {
    throw new Error(
      "could not resolve the iOS app data container for boot evidence",
    );
  }
  const traceFiles = [
    "eliza-boot-trace.prev.jsonl",
    "eliza-boot-trace.jsonl",
  ].map((name) => path.join(dataContainer, "Documents", name));
  const entries = [];
  let invalidLines = 0;
  for (const traceFile of traceFiles) {
    if (!fs.existsSync(traceFile)) continue;
    for (const line of fs.readFileSync(traceFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // error-policy:J3 a concurrently appended partial JSONL line is an
        // explicit invalid sample; required current-run stages still gate pass
        invalidLines += 1;
      }
    }
  }
  const selection = selectIosVoiceSelfTestBootTrace(entries, {
    requestedAtMs,
  });
  const { entries: currentEntries, traceId, required } = selection;

  const privateArtifact = path.join(resultDir, "native-boot.private.jsonl");
  fs.writeFileSync(
    privateArtifact,
    `${currentEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const summary = {
    classification: "scrubbed-public-summary",
    rawClassification: "private-raw-do-not-publish-without-review",
    traceIdSha256: createHash("sha256").update(traceId).digest("hex"),
    requestedAt: new Date(requestedAtMs).toISOString(),
    required,
    invalidLines,
    stages: currentEntries.map((entry) => ({
      ts: entry.ts,
      elapsedMs: entry.elapsedMs,
      source: entry.source,
      stage: entry.stage,
      ...(typeof entry.phase === "string" ? { phase: entry.phase } : {}),
      ...(typeof entry.ready === "boolean" ? { ready: entry.ready } : {}),
      ...(typeof entry.engine === "string" ? { engine: entry.engine } : {}),
      ...(typeof entry.engineMode === "string"
        ? { engineMode: entry.engineMode }
        : {}),
      ...(typeof entry.durationMs === "number"
        ? { durationMs: entry.durationMs }
        : {}),
    })),
  };
  const summaryArtifact = path.join(resultDir, "native-boot-summary.json");
  fs.writeFileSync(summaryArtifact, `${JSON.stringify(summary, null, 2)}\n`);
  return {
    privateArtifact: {
      path: privateArtifact,
      bytes: fs.statSync(privateArtifact).size,
      classification: summary.rawClassification,
    },
    summaryArtifact: {
      path: summaryArtifact,
      bytes: fs.statSync(summaryArtifact).size,
      classification: summary.classification,
    },
    required,
  };
}

async function pollResult(udid, appId, ownership) {
  const delayMs = Number.parseInt(
    process.env.IOS_VOICE_SELFTEST_DELAY_MS ?? "1000",
    10,
  );
  let lastRaw = "";
  let attempt = 0;
  while (Date.now() <= ownership.deadlineAtMs) {
    attempt += 1;
    lastRaw =
      readIosPreferenceString({
        udid,
        bundleId: appId,
        key: VOICE_RESULT_KEY,
      }) ?? "";
    if (lastRaw) {
      let parsed = null;
      try {
        parsed = JSON.parse(lastRaw);
      } catch (error) {
        // error-policy:J3 corrupt interim result blob — keep polling until a
        // valid terminal result arrives or the lane times out
        if (attempt % 15 === 0) {
          log(
            `result JSON parse failed (attempt ${attempt}, deadline ${new Date(ownership.deadlineAtMs).toISOString()}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        parsed = null;
      }
      const terminal =
        parsed?.phase === "complete" || parsed?.phase === "failed";
      if (terminal && isIosVoiceSelfTestResultFresh(parsed, ownership)) {
        return parsed;
      }
      if (attempt % 15 === 0) {
        log(
          `${terminal ? "ignoring non-owned terminal result" : "still running"} (attempt ${attempt}): ${lastRaw.slice(0, 200)}`,
        );
      }
    }
    await sleep(delayMs);
  }
  throw new Error(
    `iOS voice self-test reached request deadline ${new Date(ownership.deadlineAtMs).toISOString()}. Last result: ${lastRaw || "<none>"}`,
  );
}

async function main() {
  const appId = readAppIdentity();
  const parsedMode = parseIosVoiceSelfTestMode(process.argv.slice(2));
  const hostPlan = planIosVoiceSelfTestHost(parsedMode);
  let apiBase = hostPlan.apiBase;
  const udid = ensureSimulatorBooted();
  removePathRecursive(resultDir);
  fs.mkdirSync(resultDir, { recursive: true });
  const hostAgent = hostPlan.ownsHostAgent
    ? await startDeviceE2eHostAgent({
        repoRoot,
        artifactDir: resultDir,
        requestedPort: val("--host-agent-port"),
        preferredPort:
          process.env.ELIZA_IOS_HOST_AGENT_PORT ??
          DEFAULT_HOST_AGENT_PORT_STRING,
        log,
      })
    : null;
  apiBase = apiBase ?? hostAgent?.apiBase;
  if (!apiBase)
    throw new Error("voice self-test could not resolve an API base");
  let recording = null;
  let installedPath = null;

  try {
    const expectedCommit = run("git", ["rev-parse", "HEAD"], {
      stdio: "pipe",
    });
    const candidatePath = has("--skip-install")
      ? null
      : (val("--app-path") ?? latestBuiltApp());
    const artifactReceipt = {
      expectedCommit,
      candidate: null,
      installed: null,
    };
    if (parsedMode.mode === "local" && candidatePath) {
      artifactReceipt.candidate = validateLocalVoiceApp(
        candidatePath,
        expectedCommit,
      );
    }
    installedPath = installLatestApp(udid, appId, candidatePath);
    if (parsedMode.mode === "local") {
      artifactReceipt.installed = validateLocalVoiceApp(
        installedPath,
        expectedCommit,
      );
      stageLocalVoiceModels(
        udid,
        appId,
        path.resolve(val("--voice-bundle", DEFAULT_VOICE_BUNDLE)),
      );
      fs.writeFileSync(
        path.join(resultDir, "local-app-artifact.json"),
        `${JSON.stringify(artifactReceipt, null, 2)}\n`,
      );
    }
    tryRun("xcrun", ["simctl", "terminate", udid, appId]);
    clearIosSmokeDefaults({
      udid,
      bundleId: appId,
      extraKeys: LOCAL_STATE_KEYS,
      log,
    });
    const requestedAt = new Date().toISOString();
    const requestedAtMs = Date.parse(requestedAt);
    const deadlineAtMs = requestedAtMs + IOS_VOICE_SELFTEST_REQUEST_BUDGET_MS;
    const deadlineAt = new Date(deadlineAtMs).toISOString();
    const runId = `ios-voice-${requestedAtMs}-${process.pid}`;
    const preferenceSeed = buildIosVoiceSelfTestPreferenceSeed({
      mode: parsedMode.mode,
      apiBase,
      runId,
      requestedAt,
      deadlineAt,
    });
    for (const [key, value] of Object.entries(preferenceSeed)) {
      writeIosDefaultsString({
        udid,
        bundleId: appId,
        key,
        value,
      });
    }
    flushIosPreferencesCache(udid);

    recording = startVideo(udid);
    log(`launching ${appId} on ${udid}`);
    simctl(["launch", udid, appId]);
    await sleep(1500);
    takeScreenshot(udid, "fresh-launch");
    log(`armed ${parsedMode.mode} voice self-test run ${runId} for ${apiBase}`);

    const result = await pollResult(udid, appId, {
      runId,
      requestedAtMs,
      deadlineAtMs,
    });
    const screenshot = takeScreenshot(udid, "voice-selftest-result");
    const video = recording ? await recording.stop() : null;
    recording = null;
    const resultPath = path.join(resultDir, "result.json");
    const resultArtifacts = {
      ...result,
      screenshot,
      video,
      nativeBootTrace: { status: "pending" },
    };
    fs.writeFileSync(
      resultPath,
      `${JSON.stringify(resultArtifacts, null, 2)}\n`,
    );
    let nativeBootTrace;
    try {
      nativeBootTrace = captureRunOwnedBootTrace(udid, appId, requestedAtMs);
    } catch (error) {
      // error-policy:J2 preserve the behavior result before rethrowing the
      // evidence-gate failure to the outer smoke boundary
      fs.writeFileSync(
        resultPath,
        `${JSON.stringify(
          {
            ...resultArtifacts,
            nativeBootTrace: {
              status: "failed",
              error: error instanceof Error ? error.message : String(error),
            },
          },
          null,
          2,
        )}\n`,
      );
      throw new Error(
        `native boot evidence gate failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    fs.writeFileSync(
      resultPath,
      `${JSON.stringify(
        {
          ...resultArtifacts,
          nativeBootTrace: { status: "pass", ...nativeBootTrace },
        },
        null,
        2,
      )}\n`,
    );

    const verdict = evaluateVoiceSelfTestReport(result.report ?? result, {
      requireLocalInference: parsedMode.mode === "local",
    });
    if (!verdict.pass) {
      throw new Error(
        `iOS voice round-trip did not pass: ${verdict.reasons.join("; ")}\nstages=${JSON.stringify(verdict.stageStatuses)} transcript=${JSON.stringify(verdict.transcript)} reply=${JSON.stringify(verdict.reply.slice(0, 120))}`,
      );
    }
    log(
      `PASS overall=${verdict.overall} stages=${JSON.stringify(verdict.stageStatuses)} transcript=${JSON.stringify(verdict.transcript)} reply=${JSON.stringify(verdict.reply.slice(0, 120))}`,
    );
    log(`artifacts: ${resultDir}`);
  } catch (error) {
    // error-policy:J1 simulator smoke boundary — capture best-effort evidence
    // and rethrow so the CLI exits nonzero
    const screenshot = takeScreenshot(udid, "failure");
    if (recording) {
      await recording.stop();
      recording = null;
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${screenshot ? ` (screenshot: ${screenshot})` : ""}`,
    );
  } finally {
    await hostAgent?.stop();
    if (installedPath) {
      clearIosSmokeDefaults({
        udid,
        bundleId: appId,
        extraKeys: LOCAL_STATE_KEYS,
        log,
      });
      const cleanupPolicy = {
        nativeSmokePreferences: "cleared",
        installedApp: "retained",
        wkWebViewRuntimeState:
          parsedMode.mode === "local"
            ? "intentionally retained as canonical local state; this lane has no in-app cleanup acknowledgement and does not claim WKWebView cleanup"
            : "not modified by local-mode override",
        skipInstall: has("--skip-install"),
      };
      fs.writeFileSync(
        path.join(resultDir, "cleanup-policy.json"),
        `${JSON.stringify(cleanupPolicy, null, 2)}\n`,
      );
      if (parsedMode.mode === "local") {
        log(cleanupPolicy.wkWebViewRuntimeState);
      }
    }
  }
}

main().catch((error) => {
  // error-policy:J1 CLI boundary — the caller observes the nonzero exit
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
