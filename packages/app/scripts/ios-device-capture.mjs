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
 *
 * Exit code: non-zero when the harness fails (including "boot never reached
 * home or the error card") — attachments are still exported first.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDevicectlDeviceList } from "./ios-device-devicectl.mjs";
import {
  buildPlistXml,
  classifyIsolatedReruns,
  evaluateRunnerStaleness,
  extractXctestrunAppPaths,
  findDeviceRecord,
  parseCliArgs,
  parseFailedTestIdentifiers,
  parsePlist,
  resolveDeviceId,
  resolveXctestrunTestRoot,
  rewriteXctestrunUITargetApp,
} from "./ios-device-lib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const iosProjectDir = path.join(appRoot, "ios", "App");

const log = (message) => console.log(`[ios-device-capture] ${message}`);
const fail = (message) => {
  console.error(`[ios-device-capture] ERROR: ${message}`);
  process.exit(1);
};

function runInherit(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    fail(
      `${command} ${args.slice(0, 4).join(" ")} … exited with ${result.status}`,
    );
  }
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
      return { path: full, mtimeMs: fs.statSync(full).mtimeMs };
    });
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    booleans: [
      "skip-build",
      "allow-stale-runner",
      "no-retry-isolation",
      "help",
    ],
  });
  if (args.help) {
    console.log(
      "Usage: node scripts/ios-device-capture.mjs --platform sim|device [--device <udid>] [--skip-build] [--allow-stale-runner] [--no-retry-isolation] [--output <dir>] [--app-path <App.app>] [--boot-timeout <sec>] [--interval <sec>] [--agent-ready-timeout <sec>] [--derived-data <dir>] [--only-testing <id>]",
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
        // Sim: signing is irrelevant, skip it. Device: the test RUNNER must be
        // properly signed or installd rejects it (0xe8008018 "identity no
        // longer valid" — the exact first-device-run failure). The project
        // carries CODE_SIGN_STYLE=Automatic + the team id, so let xcodebuild
        // sign and mint the ai.elizaos.app.xctrunner wildcard team profile
        // (-allowProvisioningUpdates needs the Xcode account session that
        // minted the app profile in the first place).
        ...(platform === "sim"
          ? [
              "CODE_SIGNING_ALLOWED=NO",
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
  }
  fs.writeFileSync(xmlPath, buildPlistXml(parsed));
  xctestrunPath = xmlPath;

  // 4. Destination for the run.
  let destination;
  let simUdid = null;
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
    const bundles = extractXctestrunAppPaths(parsed, testRoot).filter(
      (bundle) => bundle.endsWith(".app") && fs.existsSync(bundle),
    );
    for (const bundle of bundles) {
      log(`simctl install ${path.basename(bundle)}`);
      runInherit("xcrun", ["simctl", "install", udid, bundle]);
    }
  } else {
    const deviceId = resolveDeviceId({ flagValue: args.device ?? null });
    if (!deviceId)
      fail("device platform needs --device or ELIZA_IOS_DEVICE_ID.");
    const record = resolvePhysicalDeviceUdid(deviceId);
    destination = `platform=iOS,id=${record.udid}`;
  }
  log(`destination: ${destination}`);

  // runHarness clears each result bundle before writing (so the main run and
  // every isolated re-run start from a clean .xcresult).
  const resultBundle = path.join(outputDir, "BootCapture.xcresult");

  // 5. Run the harness. TEST_RUNNER_-prefixed env vars are forwarded by
  //    xcodebuild into the test-runner process (how the Swift side reads
  //    ELIZA_BOOT_TIMEOUT_SECONDS / ELIZA_BOOT_SCREENSHOT_INTERVAL_SECONDS).
  //    Default = the whole AppUITests target, so the lane exercises both the
  //    boot-capture suite AND the WKWebView gesture-semantics suite (#11353);
  //    narrow with --only-testing AppUITests/<Class>[/<test>].
  const onlyTesting = args["only-testing"] || "AppUITests";
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
  };

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

  // Read the failed-test identifiers out of a produced .xcresult so the
  // retry-in-isolation pass can re-run each one alone. Returns [] on any
  // missing bundle / non-zero summary / unparseable output (fail-closed: no
  // isolable failures found means the suite verdict stands).
  const readFailedTestIdentifiers = (bundlePath) => {
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
      fallbackTarget: onlyTesting.split("/")[0] || "AppUITests",
    });
  };

  // Record the whole run on the simulator (walkthrough evidence for the
  // gesture-loop lane; no-op on a physical device). Started just before the
  // harness so it captures every gesture, stopped in `finally` so a failing run
  // still yields its video.
  const simVideo = startSimVideo({ udid: simUdid, outputDir });
  let testResult;
  try {
    testResult = runHarness(onlyTesting, resultBundle);
  } finally {
    const videoPath = await simVideo.stop();
    if (videoPath) log(`simulator video: ${videoPath}`);
  }

  // 6. Export attachments regardless of the verdict — a failed boot's
  //    screenshots are exactly the evidence we want. Clear any prior export
  //    first: xcresulttool refuses to write manifest.json into a dir that
  //    already has one (stale attachments would also mix runs).
  const attachmentsDir = path.join(outputDir, "attachments");
  fs.rmSync(attachmentsDir, { recursive: true, force: true });
  fs.mkdirSync(attachmentsDir, { recursive: true });
  if (fs.existsSync(resultBundle)) {
    runInherit("xcrun", [
      "xcresulttool",
      "export",
      "attachments",
      "--path",
      resultBundle,
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
        resultBundle,
      ],
      { encoding: "utf8" },
    );
    if (summary.status === 0) {
      fs.writeFileSync(
        path.join(outputDir, "test-summary.json"),
        summary.stdout,
      );
    }
  } else {
    log("warning: no .xcresult bundle produced — nothing to export.");
  }

  const exported = fs.existsSync(attachmentsDir)
    ? fs.readdirSync(attachmentsDir)
    : [];
  log(`attachments: ${exported.length} file(s) in ${attachmentsDir}`);
  log(`result bundle: ${resultBundle}`);

  if (testResult.status === 0) {
    log("boot capture PASSED (home or startup-failure card reached).");
    return;
  }

  // 7. Retry-in-isolation (#13566): device XCUITest terminate/relaunch cycles
  //    flake through devicectl, and a single flaky termination can poison
  //    subsequent tests in the same monolithic invocation. Re-run EACH failed
  //    test alone; a test that passes isolated is a `flake` (exit 0 stands),
  //    one that fails both is a real `fail` (exit nonzero). Skipped with
  //    --no-retry-isolation, which keeps the legacy hard-fail-on-any behavior.
  const suiteFailures = readFailedTestIdentifiers(resultBundle);
  if (args["no-retry-isolation"] || suiteFailures.length === 0) {
    const why = args["no-retry-isolation"]
      ? "--no-retry-isolation set"
      : "no isolable failed-test identifiers parsed from the .xcresult";
    writeFlakeSummary(outputDir, { skipped: true, reason: why });
    fail(
      `harness run failed (xcodebuild exit ${testResult.status}); ${why}. ` +
        "Exit 65 means a test assertion failed — e.g. the boot never reached home " +
        `or the startup-failure card. Review the screenshots in ${attachmentsDir}.`,
    );
  }

  log(
    `retry-in-isolation: re-running ${suiteFailures.length} failed test(s) alone — ` +
      suiteFailures.map((f) => f.identifier).join(", "),
  );
  const isolatedResults = [];
  const isolationDir = path.join(outputDir, "isolation");
  fs.mkdirSync(isolationDir, { recursive: true });
  for (const failure of suiteFailures) {
    const safeName = failure.identifier.replace(/[^A-Za-z0-9._-]/g, "_");
    const isoBundle = path.join(isolationDir, `${safeName}.xcresult`);
    log(`  isolated re-run: ${failure.identifier}`);
    const isoResult = runHarness(failure.identifier, isoBundle);
    isolatedResults.push({
      identifier: failure.identifier,
      isolatedPassed: isoResult.status === 0,
    });
  }

  const classification = classifyIsolatedReruns(suiteFailures, isolatedResults);
  writeFlakeSummary(outputDir, {
    skipped: false,
    verdicts: classification.verdicts,
    flakes: classification.flakes,
    realFailures: classification.realFailures,
  });
  for (const v of classification.verdicts) {
    log(`  ${v.verdict.toUpperCase()}: ${v.identifier}`);
  }

  if (classification.exitNonZero) {
    fail(
      `harness run failed: ${classification.realFailures.length} test(s) failed ` +
        `both in-suite AND isolated (${classification.realFailures.join(", ")}). ` +
        (classification.flakes.length > 0
          ? `${classification.flakes.length} flake(s) recorded. `
          : "") +
        `Review the screenshots in ${attachmentsDir}.`,
    );
  }
  log(
    `boot capture PASSED after isolation: all ${classification.flakes.length} ` +
      "suite failure(s) were flakes (passed on isolated re-run).",
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
