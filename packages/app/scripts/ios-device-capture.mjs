#!/usr/bin/env node
/**
 * One-command iOS screenshot/recording capture via the committed XCUITest
 * harness (AppUITests / BootCaptureUITests) — works on the SIMULATOR and on
 * a physical device.
 *
 * Flow:
 *   1. Template-sync the iOS project (ensure-capacitor-platform) so the
 *      AppUITests target from packages/app-core/platforms/ios is present in
 *      the generated packages/app/ios project.
 *   2. `xcodebuild build-for-testing -scheme AppUITests` → produces
 *      AppUITests-Runner.app + App.app + an .xctestrun file.
 *   3. (device only, --app-path) rewrite UITargetAppPath in the .xctestrun to
 *      the grafted-signature App.app produced by ios-device-deploy.mjs.
 *   4. `xcodebuild test-without-building -xctestrun …` drives the app,
 *      screenshotting at intervals (XCUIScreen) and asserting the boot
 *      reaches home or the startup-failure card.
 *   5. `xcrun xcresulttool export attachments` lands every screenshot + the
 *      AX snapshot in --output.
 *
 * PREREQUISITE: the App target's web bundle/agent payload must have been
 * staged at least once (`bun run build:ios:local:sim` for the simulator,
 * `bun run ios:device:deploy` for devices) — build-for-testing recompiles the
 * native app but does not regenerate the renderer dist.
 *
 * Usage:
 *   node scripts/ios-device-capture.mjs --platform sim|device
 *     [--device <udid>] [--skip-build] [--output <dir>] [--app-path <App.app>]
 *     [--boot-timeout <sec>] [--interval <sec>] [--agent-ready-timeout <sec>]
 *     [--derived-data <dir>] [--only-testing <Target/Class/test>]
 *     [--bundle-id <id>]
 *
 * Exit code: non-zero when the harness fails (including "boot never reached
 * home or the error card") — attachments are still exported first.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readDevicectlDeviceList,
  readDevicectlDeviceLockState,
} from "./ios-device-devicectl.mjs";
import {
  buildIosXcuitestShardPlan,
  assertDeviceUnlocked,
  buildPlistXml,
  classifyXcresultSummaryForGate,
  classifyCodesignPreflight,
  classifyIsolatedReruns,
  DEFAULT_APP_BUNDLE_ID,
  evaluateRunnerStaleness,
  extractSwiftXcuitestEntries,
  extractXctestrunAppPaths,
  findDeviceRecord,
  findUncoveredIosXcuitestEntries,
  isBenignIosAppAbsence,
  normalizeDeviceLockState,
  parseCliArgs,
  parseFailedTestIdentifiers,
  parsePlist,
  planSignedAppDdOverwrite,
  resolveDeviceId,
  resolveXctestrunTestRoot,
  rewriteXctestrunUITargetApp,
  sweepXctestrunDependentProductPaths,
} from "./ios-device-lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const iosProjectDir = path.join(appRoot, "ios", "App");

const log = (message) => console.log(`[ios-device-capture] ${message}`);
const fail = (message) => {
  console.error(`[ios-device-capture] ERROR: ${message}`);
  process.exit(1);
};

const DEFAULT_ELIZA_CLOUD_BASE = "https://elizacloud.ai";

function readFirstString(env, keys) {
  for (const key of keys) {
    const value = env?.[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

function withoutTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function withPath(base, pathname) {
  const url = new URL(base);
  url.pathname = pathname;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Resolve the HTTP endpoint that proves the app's chat/reply path can answer
 * before the iOS XCUITest suite starts. Prefer the device build's configured
 * API base (local/remote-mac/hybrid builds), otherwise fall back to the cloud
 * agent liveness endpoint used by cloud-only builds.
 */
export function resolveAgentProbeTarget(env = process.env, args = {}) {
  const explicit = readFirstString(args, ["agent-probe-url"]);
  if (explicit) {
    return { kind: "explicit", url: explicit, source: "--agent-probe-url" };
  }

  const apiBase = readFirstString(env, [
    "VITE_ELIZA_IOS_API_BASE",
    "VITE_ELIZA_MOBILE_API_BASE",
    "VITE_ELIZA_ANDROID_API_BASE",
    "ELIZA_IOS_API_BASE",
    "ELIZA_API_BASE",
    "ELIZA_API_BASE_URL",
  ]);
  if (apiBase) {
    return {
      kind: "api-base",
      url: withPath(withoutTrailingSlash(apiBase), "/api/health"),
      source: "configured API base",
    };
  }

  const cloudBase = withoutTrailingSlash(
    readFirstString(env, ["VITE_ELIZA_CLOUD_BASE", "VITE_CLOUD_BASE"]) ??
      DEFAULT_ELIZA_CLOUD_BASE,
  );
  return {
    kind: "cloud-health",
    url: withPath(cloudBase, "/api/health"),
    source: "cloud health endpoint",
  };
}

function normalizeProbeVerdict(response, bodyText) {
  if (!response?.ok) return `not-ready(http ${response?.status ?? "unknown"})`;
  if (!bodyText?.trim()) return "ready";
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return "ready";
  }
  if (body?.ready === false) return "not-ready(ready=false)";
  if (body?.alive === false) return "not-ready(alive=false)";
  const status = typeof body?.status === "string" ? body.status : null;
  if (status && /^(unhealthy|offline|draining|not[-_ ]?ready)$/i.test(status)) {
    return `not-ready(status=${status})`;
  }
  return "ready";
}

export async function probeAgentAvailability({
  target,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5000,
} = {}) {
  if (!target?.url) return { verdict: "unreachable(no target)", target };
  if (typeof fetchImpl !== "function") {
    return { verdict: "unreachable(fetch unavailable)", target };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(target.url, {
      method: "GET",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    const text = await response.text().catch(() => "");
    return { verdict: normalizeProbeVerdict(response, text), target };
  } catch (error) {
    const detail =
      error?.name === "AbortError" ? "timeout" : (error?.message ?? error);
    return { verdict: `unreachable(${String(detail)})`, target };
  } finally {
    clearTimeout(timer);
  }
}

function collectSkippedChatRows(value, rows = []) {
  if (!value || typeof value !== "object") return rows;
  if (Array.isArray(value)) {
    for (const item of value) collectSkippedChatRows(item, rows);
    return rows;
  }
  const statusFields = [
    value.status,
    value.result,
    value.testStatus,
    value.state,
    value.outcome,
  ]
    .filter((field) => typeof field === "string")
    .join(" ");
  const skipped = /\bskip(?:ped)?\b/i.test(statusFields);
  const identifier = [
    value.testIdentifierString,
    value.testIdentifier,
    value.identifier,
    value.testName,
    value.name,
  ]
    .filter((field) => typeof field === "string" && field.trim())
    .join(" ");
  const chatLike = /chat|message|reply/i.test(identifier);
  if (skipped && chatLike) {
    rows.push({ identifier: identifier.trim() || "unknown-chat-test" });
  }
  for (const child of Object.values(value)) collectSkippedChatRows(child, rows);
  return rows;
}

export function summarizeChatSkipAccounting(summaryJson, probeVerdict) {
  const rows = collectSkippedChatRows(summaryJson);
  const seen = new Set();
  const tests = [];
  for (const row of rows) {
    const identifier = row.identifier.replace(/\s+/g, " ");
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    tests.push(identifier);
  }
  const count = tests.length;
  return {
    count,
    tests,
    message:
      count > 0
        ? `${count} chat leg${count === 1 ? "" : "s"} skipped: agent never ready (${probeVerdict})`
        : null,
  };
}

export function buildRequireChatDecision({
  requireChat = false,
  agentProbeVerdict = "ready",
  chatSkippedCount = 0,
} = {}) {
  const reasons = [];
  if (agentProbeVerdict !== "ready") {
    reasons.push(`agent preflight ${agentProbeVerdict}`);
  }
  if (chatSkippedCount > 0) {
    reasons.push(
      `${chatSkippedCount} chat leg${chatSkippedCount === 1 ? "" : "s"} skipped`,
    );
  }
  return {
    exitNonZero: Boolean(requireChat && reasons.length > 0),
    reason: reasons.join("; "),
  };
}

function runInherit(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    fail(
      `${command} ${args.slice(0, 4).join(" ")} … exited with ${result.status}`,
    );
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForDeviceUnlocked(device, phase) {
  await assertDeviceUnlocked({
    device,
    probeLockState: () => readDevicectlDeviceLockState(device.identifier),
    sleep,
    waitSeconds: process.env.ELIZA_IOS_DEVICE_UNLOCK_WAIT_SECONDS ?? 120,
    pollIntervalSeconds: process.env.ELIZA_IOS_DEVICE_UNLOCK_POLL_SECONDS ?? 5,
    notify: (message) => log(`${phase}: ${message}`),
  });
}

function runResetCommand(command, args, { label, allowAbsentApp = false }) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.status === 0) {
    return { ok: true, benignAbsent: false, output: output.trim() };
  }
  if (allowAbsentApp && isBenignIosAppAbsence(output)) {
    log(`${label}: already absent (${output.trim() || "no output"})`);
    return { ok: false, benignAbsent: true, output: output.trim() };
  }
  fail(
    `${label} failed with exit ${result.status}.\n${output.trim() || "(no output)"}`,
  );
}

function runCaptureCommand(command, args, { label, required = true } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (result.status === 0) return result.stdout.trim();
  if (!required) return null;
  fail(`${label} failed with exit ${result.status}.\n${output.trim()}`);
}

/**
 * Is `appPath` code-signed? `codesign --verify` exits 0 when the bundle carries
 * a valid signature and non-zero (with "code object is not signed at all" on
 * stderr) when it does not. A missing path is treated as unsigned so the
 * preflight fails loudly rather than swallowing it.
 */
function isCodeSigned(appPath) {
  if (!fs.existsSync(appPath)) return false;
  const result = spawnSync("codesign", ["--verify", "--strict", appPath], {
    stdio: "ignore",
  });
  return result.status === 0;
}

/**
 * Record the simulator screen to an .mp4 for the whole test run via
 * `xcrun simctl io recordVideo`. Returns a stop() that SIGINTs the recorder
 * (the only clean way to finalize the container) and resolves the path. Video
 * is the walkthrough evidence for gesture-loop lanes — per-step XCTAttachment
 * screenshots alone cannot show a stuck/janky transition mid-swipe. Simulator
 * only; a physical device has no simctl io surface (returns a no-op stop()).
 */
function startSimVideo({
  udid,
  outputDir,
  filename = "ios-sim-recording.mp4",
}) {
  if (!udid) return { stop: async () => null };
  const target = path.join(outputDir, filename);
  fs.rmSync(target, { force: true });
  const recorder = spawnSync(
    "xcrun",
    ["simctl", "io", udid, "recordVideo", "--help"],
    {
      stdio: "ignore",
    },
  );
  if (recorder.status !== 0 && recorder.status !== null) {
    log(
      "simctl io recordVideo unavailable on this toolchain — skipping video.",
    );
    return { stop: async () => null };
  }
  const child = spawn(
    "xcrun",
    ["simctl", "io", udid, "recordVideo", "--codec", "h264", "-f", target],
    { stdio: "ignore" },
  );
  child.on("error", () => {});
  log(`recording simulator video → ${target}`);
  return {
    async stop() {
      child.kill("SIGINT");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      try {
        return fs.statSync(target).size > 0 ? target : null;
      } catch {
        return null;
      }
    },
  };
}

function bootedSimulatorUdid() {
  const raw = execFileSync(
    "xcrun",
    ["simctl", "list", "devices", "booted", "-j"],
    {
      encoding: "utf8",
    },
  );
  const payload = JSON.parse(raw);
  for (const devices of Object.values(payload.devices ?? {})) {
    for (const device of devices) {
      if (device.state === "Booted") return device.udid;
    }
  }
  return null;
}

function resolvePhysicalDeviceUdid(deviceId) {
  const payload = readDevicectlDeviceList();
  const record = findDeviceRecord(payload, deviceId);
  if (!record)
    fail(`device "${deviceId}" not found. xcrun devicectl list devices`);
  return record;
}

function newestXctestrun(productsDir) {
  if (!fs.existsSync(productsDir)) return null;
  const candidates = fs
    .readdirSync(productsDir)
    .filter((name) => name.endsWith(".xctestrun"))
    .map((name) => {
      const full = path.join(productsDir, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.full ?? null;
}

// Committed XCUITest Swift sources the runner is compiled from. A --skip-build
// runner older than any of these executes stale tests (#13566).
const APPUITESTS_SOURCE_DIR = path.resolve(
  scriptDir,
  "..",
  "..",
  "app-core",
  "platforms",
  "ios",
  "App",
  "AppUITests",
);

function collectAppUITestsSources(sourceDir = APPUITESTS_SOURCE_DIR) {
  if (!fs.existsSync(sourceDir)) return [];
  return fs
    .readdirSync(sourceDir)
    .filter((name) => name.endsWith(".swift"))
    .map((name) => {
      const full = path.join(sourceDir, name);
      return {
        path: full,
        mtimeMs: fs.statSync(full).mtimeMs,
        text: fs.readFileSync(full, "utf8"),
      };
    });
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    booleans: [
      "skip-build",
      "strict-gate",
      "allow-stale-runner",
      "no-retry-isolation",
      "require-chat",
      "help",
    ],
  });
  if (args.help) {
    console.log(
      "Usage: node scripts/ios-device-capture.mjs --platform sim|device [--device <udid>] [--skip-build] [--strict-gate] [--allow-stale-runner] [--no-retry-isolation] [--require-chat] [--output <dir>] [--app-path <App.app>] [--boot-timeout <sec>] [--interval <sec>] [--agent-ready-timeout <sec>] [--derived-data <dir>] [--only-testing <id>] [--bundle-id <id>]",
    );
    return;
  }
  if (process.platform !== "darwin") fail("xcodebuild requires macOS.");

  const platform =
    args.platform === "device"
      ? "device"
      : args.platform === "sim"
        ? "sim"
        : null;
  if (!platform) fail("--platform sim|device is required.");
  const bundleId = args["bundle-id"] || DEFAULT_APP_BUNDLE_ID;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.resolve(
    args.output || path.join(appRoot, "ios", "build", "boot-capture", stamp),
  );
  fs.mkdirSync(outputDir, { recursive: true });

  const derivedData = path.resolve(
    args["derived-data"] ||
      process.env.ELIZA_IOS_DERIVED_DATA_PATH ||
      path.join(appRoot, "ios", "build", "xcuitest-dd"),
  );

  // 1. Make sure the committed AppUITests target is materialized in the
  //    generated (gitignored) packages/app/ios project. Do NOT resync
  //    templates when it already is: a bare template sync reverts the
  //    lane-specific Podfile/overlay that run-mobile-build writes (full-Bun
  //    engine pods etc.), which desyncs Pods and strips the engine from the
  //    next build. run-mobile-build's own sync+overlay is the canonical path.
  const generatedPbxproj = path.join(
    iosProjectDir,
    "App.xcodeproj",
    "project.pbxproj",
  );
  if (!fs.existsSync(path.join(iosProjectDir, "App.xcworkspace"))) {
    fail(
      `iOS workspace missing at ${iosProjectDir}. Run a mobile build first ` +
        "(bun run build:ios:local:sim for the simulator lane).",
    );
  }
  if (
    !fs.existsSync(generatedPbxproj) ||
    !fs.readFileSync(generatedPbxproj, "utf8").includes("AppUITests")
  ) {
    fail(
      "the generated iOS project has no AppUITests target — it predates the " +
        "committed harness. Re-run the mobile build lane you are capturing " +
        "(e.g. bun run build:ios:local:sim), which template-syncs the project " +
        "AND reapplies the lane overlay, then retry.",
    );
  }

  // 2. build-for-testing.
  const buildDestination =
    platform === "sim"
      ? "generic/platform=iOS Simulator"
      : "generic/platform=iOS";
  if (!args["skip-build"]) {
    log(`build-for-testing (${buildDestination}) → ${derivedData}`);
    runInherit(
      "xcodebuild",
      [
        "-workspace",
        "App.xcworkspace",
        "-scheme",
        "AppUITests",
        "-configuration",
        "Debug",
        "-destination",
        buildDestination,
        "-derivedDataPath",
        derivedData,
        // Sim: build with ad-hoc signing, not CODE_SIGNING_ALLOWED=NO.
        // WidgetKit can enumerate static widgets from an unsigned simulator
        // build, but iOS 18 Control Center controls launch the appex during
        // enumeration and unsigned appexes fault in XPC peer attribution. The
        // assert-level DeviceExtensionSurfaceUITests shard depends on the same
        // signed-appex path users exercise, so keep simulator builds ad-hoc
        // signed. Device: the test RUNNER must be properly signed or installd
        // rejects it (0xe8008018 "identity no longer valid" — the exact
        // first-device-run failure). The project carries CODE_SIGN_STYLE=
        // Automatic + the team id, so let xcodebuild sign and mint the
        // ai.elizaos.app.xctrunner wildcard team profile (-allowProvisioningUpdates
        // needs the Xcode account session that minted the app profile in the
        // first place).
        ...(platform === "sim"
          ? [
              "CODE_SIGNING_ALLOWED=YES",
              "CODE_SIGN_STYLE=Manual",
              "CODE_SIGN_IDENTITY=-",
              "ARCHS=arm64",
              "ONLY_ACTIVE_ARCH=YES",
              "EXCLUDED_ARCHS=x86_64",
            ]
          : ["-allowProvisioningUpdates"]),
        "build-for-testing",
      ],
      { cwd: iosProjectDir },
    );
  } else {
    log("--skip-build: reusing existing test products");
  }

  const productsDir = path.join(derivedData, "Build", "Products");
  let xctestrunPath = newestXctestrun(productsDir);
  if (!xctestrunPath) {
    fail(`no .xctestrun found under ${productsDir}. Run without --skip-build.`);
  }
  log(`xctestrun: ${xctestrunPath}`);

  // --skip-build stale-runner guard (#13566): a reused runner older than any
  // AppUITests Swift source runs day-old tests and can false-green a change to
  // the very suite under test. Fail-fast with the rebuild command unless the
  // operator passes --allow-stale-runner (which proceeds, logging the delta).
  if (args["skip-build"]) {
    const runnerStat = fs.existsSync(xctestrunPath)
      ? fs.statSync(xctestrunPath)
      : null;
    const staleness = evaluateRunnerStaleness({
      runnerMtimeMs: runnerStat ? runnerStat.mtimeMs : null,
      sources: collectAppUITestsSources(),
      allowStale: Boolean(args["allow-stale-runner"]),
    });
    if (staleness.stale) {
      const newest = staleness.newestSource;
      const detail = newest
        ? `${path.basename(newest.path)} was modified ${Math.round(
            staleness.deltaMs / 1000,
          )}s after the runner was built (${newest.path})`
        : "the reused runner could not be dated";
      const rebuildCmd =
        "rebuild the runner: drop --skip-build (xcodebuild build-for-testing " +
        "-scheme AppUITests), or re-run the mobile build lane you are capturing.";
      if (staleness.overridden) {
        log(
          `WARNING --allow-stale-runner: proceeding with a STALE runner — ${detail}. ` +
            `Results may not reflect the current AppUITests sources. ${rebuildCmd}`,
        );
      } else {
        fail(
          `--skip-build runner is STALE: ${detail}. ${rebuildCmd} ` +
            "Or pass --allow-stale-runner to proceed anyway (logging the delta).",
        );
      }
    }
  }

  // 3. Normalize a working copy of the xctestrun to XML (xcodebuild sometimes
  //    emits binary plists) and parse it — both lanes need the parsed form.
  //    Because the working copy lives in outputDir (not Build/Products),
  //    __TESTROOT__ must be resolved to the original products dir first:
  //    xcodebuild expands it against the .xctestrun file's OWN directory.
  const testRoot = path.dirname(xctestrunPath);
  const xmlPath = path.join(outputDir, "boot-capture.xctestrun");
  fs.copyFileSync(xctestrunPath, xmlPath);
  execFileSync("plutil", ["-convert", "xml1", xmlPath]);
  const parsed = resolveXctestrunTestRoot(
    parsePlist(fs.readFileSync(xmlPath, "utf8")),
    testRoot,
  );
  // Capture the original resolved bundle list before any --app-path rewrites.
  // Once UITargetAppPath points at the signed staged app, the unsigned
  // DerivedData App.app path is no longer discoverable from the parsed
  // xctestrun, but the overwrite/preflight below still needs that original
  // product path.
  const originalBundles = extractXctestrunAppPaths(parsed, testRoot).filter(
    (bundle) => bundle.endsWith(".app"),
  );

  // Device lane: point the harness at the signed App.app graft.
  if (args["app-path"]) {
    const signedApp = path.resolve(args["app-path"]);
    if (!fs.existsSync(signedApp)) fail(`--app-path not found: ${signedApp}`);
    const rewritten = rewriteXctestrunUITargetApp(parsed, signedApp);
    if (rewritten === 0)
      fail("no UITargetAppPath entries found in the xctestrun.");
    log(
      `rewrote ${rewritten} UITargetAppPath entr${rewritten === 1 ? "y" : "ies"} → ${signedApp}`,
    );
    // xcodebuild also installs the bundles listed in each test target's
    // DependentProductPaths; a lingering reference to the unsigned build
    // product App.app there fails the device install 0xe800801c even after
    // the UITargetAppPath rewrite. Point those stale App.app refs at the graft.
    const sweptDeps = sweepXctestrunDependentProductPaths(parsed, signedApp);
    if (sweptDeps > 0) {
      log(
        `swept ${sweptDeps} stale DependentProductPaths entr${sweptDeps === 1 ? "y" : "ies"} → ${signedApp}`,
      );
    }
  }
  fs.writeFileSync(xmlPath, buildPlistXml(parsed));
  xctestrunPath = xmlPath;

  // Device lane: overwrite the UNSIGNED build-product App.app that
  // build-for-testing left in DerivedData with the signed staged app before
  // test-without-building. xcodebuild installs the DD product regardless of
  // the .xctestrun rewrites, so without this the device install fails
  // 0xe800801c ("No code signature"). See #13564.
  if (platform === "device") {
    const signedApp = args["app-path"] ? path.resolve(args["app-path"]) : null;
    // The DD build product is the App.app sitting NEXT TO the runner app in
    // Build/Products; derive it from the xctestrun's own resolved bundle list.
    const derivedDataProductApp =
      originalBundles.find(
        (bundle) => path.basename(bundle) === "App.app" && bundle !== signedApp,
      ) ?? null;
    const overwritePlan = planSignedAppDdOverwrite({
      platform,
      signedAppPath: signedApp,
      derivedDataProductApp,
      productExists: derivedDataProductApp
        ? fs.existsSync(derivedDataProductApp)
        : false,
    });
    if (overwritePlan.overwrite) {
      log(
        `overwriting UNSIGNED DerivedData product ${overwritePlan.to} with the ` +
          `signed staged app ${overwritePlan.from} (device install would else ` +
          "fail 0xe800801c)",
      );
      fs.rmSync(overwritePlan.to, { recursive: true, force: true });
      runInherit("ditto", [overwritePlan.from, overwritePlan.to]);
    } else {
      log(`DerivedData overwrite skipped: ${overwritePlan.reason}`);
    }

    // Preflight: verify the runner app AND the (now-overwritten) DD product are
    // signed, so an unsigned bundle fails fast with the 0xe800801c remediation
    // text instead of an opaque devicectl install error deep in the run.
    const runnerApp =
      originalBundles.find((bundle) => bundle.endsWith("-Runner.app")) ?? null;
    const preflightChecks = [];
    if (runnerApp) {
      preflightChecks.push({
        label: "XCUITest runner",
        path: runnerApp,
        signed: isCodeSigned(runnerApp),
      });
    }
    if (derivedDataProductApp) {
      preflightChecks.push({
        label: "target app (DerivedData product)",
        path: derivedDataProductApp,
        signed: isCodeSigned(derivedDataProductApp),
      });
    }
    if (preflightChecks.length > 0) {
      const verdict = classifyCodesignPreflight({
        checks: preflightChecks,
        appPathProvided: Boolean(signedApp),
      });
      if (!verdict.ok) fail(verdict.message);
      log("codesign preflight: runner + target app signed OK");
    }
  }

  // 4. Destination for the run.
  let destination;
  let simUdid = null;
  let physicalDevice = null;
  let deviceControlId = null;
  const installableBundles = extractXctestrunAppPaths(parsed, testRoot).filter(
    (bundle) => bundle.endsWith(".app") && fs.existsSync(bundle),
  );
  if (platform === "sim") {
    const udid = args.device || bootedSimulatorUdid();
    simUdid = udid;
    if (!udid) {
      fail(
        "no booted simulator found and no --device given.\n" +
          "Boot one: xcrun simctl boot <udid>  (xcrun simctl list devices)",
      );
    }
    destination = `platform=iOS Simulator,id=${udid}`;
    // Pre-install the runner + target app on the sim. Without this the first
    // test-without-building on fresh products can fail with "SBMainWorkspace:
    // Unknown application display identifier ai.elizaos.app.xctrunner" —
    // FrontBoard races xcodebuild's own install transaction.
    for (const bundle of installableBundles) {
      log(`simctl install ${path.basename(bundle)}`);
      runInherit("xcrun", ["simctl", "install", udid, bundle]);
    }
  } else {
    const deviceId = resolveDeviceId({ flagValue: args.device ?? null });
    if (!deviceId)
      fail("device platform needs --device or ELIZA_IOS_DEVICE_ID.");
    const record = resolvePhysicalDeviceUdid(deviceId);
    physicalDevice = record;
    await waitForDeviceUnlocked(record, "preflight");
    deviceControlId = record.identifier;
    destination = `platform=iOS,id=${record.udid}`;
  }
  log(`destination: ${destination}`);

  const captureSimulatorContainerProof = (label) => {
    const appContainer = runCaptureCommand(
      "xcrun",
      ["simctl", "get_app_container", simUdid, bundleId, "app"],
      { label: `reset ${label}: get app container` },
    );
    const dataContainer = runCaptureCommand(
      "xcrun",
      ["simctl", "get_app_container", simUdid, bundleId, "data"],
      { label: `reset ${label}: get data container`, required: false },
    );
    // `simctl listapps` takes the device as its first positional and prints a
    // NeXTSTEP plist. Xcode 26 dropped the `-j` JSON flag from this subcommand,
    // so passing `-j` makes simctl read it as the device ("Invalid device: -j")
    // and JSON.parse on the plist would fail regardless. We only need a presence
    // proof that the bundle survived the reinstall, so match the bundle key in
    // the plist text instead of parsing it.
    const listappsRaw = runCaptureCommand(
      "xcrun",
      ["simctl", "listapps", simUdid],
      { label: `reset ${label}: listapps proof` },
    );
    const bundleKey = new RegExp(
      `"${bundleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*=`,
    );
    if (!bundleKey.test(listappsRaw)) {
      fail(`reset ${label}: ${bundleId} missing from simctl listapps proof`);
    }
    return {
      appContainer,
      dataContainer,
      listappsPresent: true,
    };
  };

  const resetAppContainer = (label) => {
    if (platform === "sim") {
      log(`reset ${label}: terminate/uninstall ${bundleId} on simulator`);
      runResetCommand("xcrun", ["simctl", "terminate", simUdid, bundleId], {
        label: `reset ${label}: simctl terminate`,
        allowAbsentApp: true,
      });
      const uninstall = runResetCommand(
        "xcrun",
        ["simctl", "uninstall", simUdid, bundleId],
        {
          label: `reset ${label}: simctl uninstall`,
          allowAbsentApp: true,
        },
      );
      for (const bundle of installableBundles) {
        log(`reset ${label}: simctl install ${path.basename(bundle)}`);
        runInherit("xcrun", ["simctl", "install", simUdid, bundle]);
      }
      return {
        platform,
        bundleId,
        uninstall,
        action: "simctl terminate/uninstall + install xctestrun bundles",
        containerProof: captureSimulatorContainerProof(label),
      };
    }

    log(`reset ${label}: uninstall ${bundleId} on device`);
    const uninstall = runResetCommand(
      "xcrun",
      [
        "devicectl",
        "device",
        "uninstall",
        "app",
        "--device",
        deviceControlId,
        bundleId,
      ],
      {
        label: `reset ${label}: devicectl uninstall`,
        allowAbsentApp: true,
      },
    );
    if (args["app-path"]) {
      const signedApp = path.resolve(args["app-path"]);
      log(`reset ${label}: devicectl install ${path.basename(signedApp)}`);
      runInherit("xcrun", [
        "devicectl",
        "device",
        "install",
        "app",
        "--device",
        deviceControlId,
        signedApp,
      ]);
    }
    return {
      platform,
      bundleId,
      uninstall,
      action: args["app-path"]
        ? "devicectl uninstall + install signed app"
        : "devicectl uninstall; xcodebuild installs the target app",
    };
  };

  // 5. Run the harness. TEST_RUNNER_-prefixed env vars are forwarded by
  //    xcodebuild into the test-runner process (how the Swift side reads
  //    ELIZA_BOOT_TIMEOUT_SECONDS / ELIZA_BOOT_SCREENSHOT_INTERVAL_SECONDS).
  const strictGate =
    Boolean(args["strict-gate"]) ||
    process.env.ELIZA_IOS_STRICT_BOOT_GATE === "1";
  //    Default = a deterministic shard list with a fresh app container before
  //    every shard (#13686); narrow with --only-testing AppUITests/<Class>[/<test>].
  const shardPlan = buildIosXcuitestShardPlan({
    onlyTesting:
      args["only-testing"] ||
      (strictGate ? "AppUITests/BootCaptureUITests" : "AppUITests"),
  });
  // The full-matrix coverage guard only applies to the DEFAULT lane that is
  // meant to run every committed XCUITest class. `--strict-gate` deliberately
  // narrows the plan to the boot/chat health class (BootCaptureUITests) — a
  // boot gate is not a coverage gate — so it must not be rejected for "missing"
  // the gesture/widget/device-extension matrix it was never asked to run.
  if (!args["only-testing"] && !strictGate) {
    const uncovered = findUncoveredIosXcuitestEntries({
      entries: extractSwiftXcuitestEntries(collectAppUITestsSources()),
      shards: shardPlan.map((shard) => shard.identifier),
    });
    if (uncovered.length > 0) {
      fail(
        "default AppUITests shard plan is missing committed XCTest coverage:\n" +
          uncovered.map((identifier) => `  - ${identifier}`).join("\n") +
          "\nAdd a class shard or per-test shard before this lane can run.",
      );
    }
  }
  const harnessEnv = {
    ...process.env,
    TEST_RUNNER_ELIZA_BOOT_TIMEOUT_SECONDS:
      args["boot-timeout"] ?? process.env.ELIZA_BOOT_TIMEOUT_SECONDS ?? "180",
    TEST_RUNNER_ELIZA_BOOT_SCREENSHOT_INTERVAL_SECONDS:
      args.interval ??
      process.env.ELIZA_BOOT_SCREENSHOT_INTERVAL_SECONDS ??
      "15",
    // How long the gesture suite waits for the local model to come online
    // before sending chat turns (0 = don't wait; the suite then exercises
    // its warm-up/evicted-thread semantics instead).
    TEST_RUNNER_ELIZA_AGENT_READY_TIMEOUT_SECONDS:
      args["agent-ready-timeout"] ??
      process.env.ELIZA_AGENT_READY_TIMEOUT_SECONDS ??
      "240",
    // Local onboarding only: how long to hold the app foregrounded after
    // finish so the fire-and-forget recommended-model download completes
    // (0 = skip, the default — a multi-GB pull should not slow normal runs).
    TEST_RUNNER_ELIZA_LOCAL_MODEL_DOWNLOAD_WAIT_SECONDS:
      args["local-download-wait"] ??
      process.env.ELIZA_LOCAL_MODEL_DOWNLOAD_WAIT_SECONDS ??
      "0",
    // Seeded launcher gesture-loop (LauncherGestureLoopUITests): forward
    // the reproduction seed + action count so a run replays exactly.
    ...(process.env.ELIZA_LOOP_SEED
      ? { TEST_RUNNER_ELIZA_LOOP_SEED: process.env.ELIZA_LOOP_SEED }
      : {}),
    ...(process.env.ELIZA_LOOP_ACTIONS
      ? { TEST_RUNNER_ELIZA_LOOP_ACTIONS: process.env.ELIZA_LOOP_ACTIONS }
      : {}),
    ...(strictGate
      ? {
          TEST_RUNNER_ELIZA_REQUIRE_HOME: "1",
          TEST_RUNNER_ELIZA_REQUIRE_REPLY: "1",
          TEST_RUNNER_ELIZA_REQUIRE_NO_SKIPS: "1",
          TEST_RUNNER_ELIZA_FAIL_ON_SKIP: "1",
        }
      : {}),
  };

  const agentProbeTarget = resolveAgentProbeTarget(process.env, args);
  log(`agent availability preflight (${agentProbeTarget.source}): ${agentProbeTarget.url}`);
  const agentProbe = await probeAgentAvailability({ target: agentProbeTarget });
  log(`agent availability preflight verdict: ${agentProbe.verdict}`);

  const runHarness = (testing, bundlePath) => {
    fs.rmSync(bundlePath, { recursive: true, force: true });
    return spawnSync(
      "xcodebuild",
      [
        "test-without-building",
        "-xctestrun",
        xctestrunPath,
        "-destination",
        destination,
        "-resultBundlePath",
        bundlePath,
        "-only-testing",
        testing,
      ],
      { cwd: iosProjectDir, stdio: "inherit", env: harnessEnv },
    );
  };

  const exportArtifacts = (bundlePath, targetDir) => {
    const attachmentsDir = path.join(targetDir, "attachments");
    fs.rmSync(attachmentsDir, { recursive: true, force: true });
    fs.mkdirSync(attachmentsDir, { recursive: true });
    let summaryJson = null;
    if (fs.existsSync(bundlePath)) {
      runInherit("xcrun", [
        "xcresulttool",
        "export",
        "attachments",
        "--path",
        bundlePath,
        "--output-path",
        attachmentsDir,
      ]);
      const summary = spawnSync(
        "xcrun",
        [
          "xcresulttool",
          "get",
          "test-results",
          "summary",
          "--path",
          bundlePath,
          "--format",
          "json",
        ],
        { encoding: "utf8" },
      );
      if (summary.status === 0) {
        fs.writeFileSync(
          path.join(targetDir, "test-summary.json"),
          summary.stdout,
        );
        try {
          summaryJson = JSON.parse(summary.stdout);
        } catch {
          summaryJson = null;
        }
      }
    } else {
      log(`warning: no .xcresult bundle produced at ${bundlePath}`);
    }
    const exported = fs.existsSync(attachmentsDir)
      ? fs.readdirSync(attachmentsDir)
      : [];
    return { attachmentsDir, attachmentCount: exported.length, summaryJson };
  };

  // Read the failed-test identifiers out of a produced .xcresult so the
  // retry-in-isolation pass can re-run each one alone. Returns [] on any
  // missing bundle / non-zero summary / unparseable output (fail-closed: no
  // isolable failures found means the suite verdict stands).
  const readFailedTestIdentifiers = (bundlePath, fallbackTarget) => {
    if (!fs.existsSync(bundlePath)) return [];
    const summary = spawnSync(
      "xcrun",
      [
        "xcresulttool",
        "get",
        "test-results",
        "summary",
        "--path",
        bundlePath,
        "--format",
        "json",
      ],
      { encoding: "utf8" },
    );
    if (summary.status !== 0) return [];
    return parseFailedTestIdentifiers(summary.stdout, {
      fallbackTarget,
    });
  };

  const shardsRoot = path.join(outputDir, "shards");
  fs.mkdirSync(shardsRoot, { recursive: true });
  log(
    `xcuitest shards: ${shardPlan.length} (${shardPlan
      .map((shard) => shard.identifier)
      .join(", ")})`,
  );

  const shardSummaries = [];
  for (const shard of shardPlan) {
    const shardDir = path.join(shardsRoot, shard.resultName);
    fs.mkdirSync(shardDir, { recursive: true });
    const resultBundle = path.join(shardDir, `${shard.resultName}.xcresult`);
    log(`shard ${shard.index}/${shardPlan.length}: ${shard.identifier}`);
    const reset = resetAppContainer(shard.resultName);

    const simVideo = startSimVideo({
      udid: simUdid,
      outputDir: shardDir,
      filename: `${shard.resultName}.mp4`,
    });
    let testResult;
    try {
      testResult = runHarness(shard.identifier, resultBundle);
    } finally {
      const videoPath = await simVideo.stop();
      if (videoPath) log(`simulator video: ${videoPath}`);
    }

    const artifacts = exportArtifacts(resultBundle, shardDir);
    const shardSummary = {
      ...shard,
      bundleId,
      reset,
      resultBundle,
      attachmentsDir: artifacts.attachmentsDir,
      attachmentCount: artifacts.attachmentCount,
      exitStatus: testResult.status,
      passed: testResult.status === 0,
      flakeClassification: null,
      chatSkipAccounting: summarizeChatSkipAccounting(
        artifacts.summaryJson,
        agentProbe.verdict,
      ),
    };
    if (strictGate) {
      const verdict = classifyXcresultSummaryForGate(artifacts.summaryJson);
      shardSummary.strictGate = verdict;
      if (!verdict.ok) {
        shardSummary.passed = false;
        log(
          `strict summary gate failed (${shard.resultName}): ${verdict.reason}; ` +
            `stats=${JSON.stringify(verdict.stats)}`,
        );
      }
    }
    log(
      `shard ${shard.resultName}: exit=${testResult.status} attachments=${artifacts.attachmentCount}`,
    );
    if (shardSummary.chatSkipAccounting.message) {
      log(shardSummary.chatSkipAccounting.message);
    }

    if (testResult.status !== 0) {
      const suiteFailures = readFailedTestIdentifiers(
        resultBundle,
        "AppUITests",
      );
      if (args["no-retry-isolation"] || suiteFailures.length === 0) {
        const why = args["no-retry-isolation"]
          ? "--no-retry-isolation set"
          : "no isolable failed-test identifiers parsed from the .xcresult";
        const skipped = { skipped: true, reason: why };
        writeFlakeSummary(shardDir, skipped);
        shardSummary.flakeClassification = skipped;
      } else {
        log(
          `retry-in-isolation (${shard.resultName}): ${suiteFailures.length} failed test(s) — ` +
            suiteFailures.map((f) => f.identifier).join(", "),
        );
        const isolatedResults = [];
        const isolationDir = path.join(shardDir, "isolation");
        fs.mkdirSync(isolationDir, { recursive: true });
        for (const failure of suiteFailures) {
          const safeName = failure.identifier.replace(/[^A-Za-z0-9._-]/g, "_");
          const isoBundle = path.join(isolationDir, `${safeName}.xcresult`);
          log(`  isolated re-run: ${failure.identifier}`);
          resetAppContainer(`isolation-${safeName}`);
          const isoResult = runHarness(failure.identifier, isoBundle);
          exportArtifacts(isoBundle, path.join(isolationDir, safeName));
          isolatedResults.push({
            identifier: failure.identifier,
            isolatedPassed: isoResult.status === 0,
          });
        }

        const classification = classifyIsolatedReruns(
          suiteFailures,
          isolatedResults,
        );
        const classificationPayload = {
          skipped: false,
          verdicts: classification.verdicts,
          flakes: classification.flakes,
          realFailures: classification.realFailures,
        };
        writeFlakeSummary(shardDir, classificationPayload);
        shardSummary.flakeClassification = classificationPayload;
        shardSummary.passed = !classification.exitNonZero;
        for (const v of classification.verdicts) {
          log(`  ${v.verdict.toUpperCase()}: ${v.identifier}`);
        }
      }
    }
    shardSummaries.push(shardSummary);
  }

  const chatSkipAccounting = shardSummaries.reduce(
    (acc, shard) => {
      const tests = shard.chatSkipAccounting?.tests ?? [];
      for (const test of tests) {
        if (!acc.seen.has(test)) {
          acc.seen.add(test);
          acc.tests.push(test);
        }
      }
      return acc;
    },
    { seen: new Set(), tests: [] },
  );
  const aggregateChatSkipAccounting = {
    count: chatSkipAccounting.tests.length,
    tests: chatSkipAccounting.tests,
    message:
      chatSkipAccounting.tests.length > 0
        ? `${chatSkipAccounting.tests.length} chat leg${chatSkipAccounting.tests.length === 1 ? "" : "s"} skipped: agent never ready (${agentProbe.verdict})`
        : null,
  };
  const aggregate = {
    generatedAt: new Date().toISOString(),
    platform,
    bundleId,
    destination,
    sharded: args["only-testing"] ? "explicit-only-testing" : "default",
    agentAvailability: agentProbe,
    requireChat: Boolean(args["require-chat"]),
    chatSkipAccounting: aggregateChatSkipAccounting,
    shards: shardSummaries,
  };
  fs.writeFileSync(
    path.join(outputDir, "test-summary.json"),
    `${JSON.stringify(aggregate, null, 2)}\n`,
  );

  const failedShards = shardSummaries.filter((shard) => !shard.passed);
  if (failedShards.length > 0 && physicalDevice) {
    const lockState = normalizeDeviceLockState(
      readDevicectlDeviceLockState(physicalDevice.identifier),
    );
    if (lockState.locked) {
      fail(
        `device locked during run (${lockState.reason ?? "lockState reported locked"}). ` +
          `Unlock ${physicalDevice.name} and set Settings > Display & Brightness > Auto-Lock > Never for lane devices. ` +
          `Review shard artifacts under ${shardsRoot}.`,
      );
    }
  }

  if (aggregateChatSkipAccounting.message) {
    log(aggregateChatSkipAccounting.message);
  }
  const requireChatDecision = buildRequireChatDecision({
    requireChat: Boolean(args["require-chat"]),
    agentProbeVerdict: agentProbe.verdict,
    chatSkippedCount: aggregateChatSkipAccounting.count,
  });
  if (requireChatDecision.exitNonZero) {
    fail(`--require-chat failed: ${requireChatDecision.reason}.`);
  }

  if (failedShards.length > 0) {
    fail(
      `iOS capture failed: ${failedShards.length}/${shardSummaries.length} shard(s) failed ` +
        `(${failedShards.map((shard) => shard.identifier).join(", ")}). ` +
        `Review shard artifacts under ${shardsRoot}.`,
    );
  }
  log(
    `iOS capture PASSED: ${shardSummaries.length} shard(s) completed with fresh containers.`,
  );
}

// Persist the flake classification into the run's test-summary output so trend
// data exists across runs (#13566).
function writeFlakeSummary(outputDir, payload) {
  try {
    fs.writeFileSync(
      path.join(outputDir, "flake-classification.json"),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  } catch (error) {
    // error-policy:J5 — trend-data side-output is non-authoritative; a write
    // failure must NOT mask or alter the real pass/fail verdict, but is logged
    // observably (not silently swallowed) so a broken output dir is visible.
    log(
      `warning: could not write flake-classification.json (${
        error?.message ?? error
      }); the run verdict is unaffected.`,
    );
  }
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => fail(error?.stack ?? String(error)));
}
