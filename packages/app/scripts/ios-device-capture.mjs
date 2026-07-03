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
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDevicectlDeviceList } from "./ios-device-devicectl.mjs";
import {
  buildPlistXml,
  extractXctestrunAppPaths,
  findDeviceRecord,
  parseCliArgs,
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

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    booleans: ["skip-build", "help"],
  });
  if (args.help) {
    console.log(
      "Usage: node scripts/ios-device-capture.mjs --platform sim|device [--device <udid>] [--skip-build] [--output <dir>] [--app-path <App.app>] [--boot-timeout <sec>] [--interval <sec>] [--agent-ready-timeout <sec>] [--derived-data <dir>] [--only-testing <id>]",
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
  if (platform === "sim") {
    const udid = args.device || bootedSimulatorUdid();
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

  const resultBundle = path.join(outputDir, "BootCapture.xcresult");
  fs.rmSync(resultBundle, { recursive: true, force: true });

  // 5. Run the harness. TEST_RUNNER_-prefixed env vars are forwarded by
  //    xcodebuild into the test-runner process (how the Swift side reads
  //    ELIZA_BOOT_TIMEOUT_SECONDS / ELIZA_BOOT_SCREENSHOT_INTERVAL_SECONDS).
  //    Default = the whole AppUITests target, so the lane exercises both the
  //    boot-capture suite AND the WKWebView gesture-semantics suite (#11353);
  //    narrow with --only-testing AppUITests/<Class>[/<test>].
  const onlyTesting = args["only-testing"] || "AppUITests";
  const testResult = spawnSync(
    "xcodebuild",
    [
      "test-without-building",
      "-xctestrun",
      xctestrunPath,
      "-destination",
      destination,
      "-resultBundlePath",
      resultBundle,
      "-only-testing",
      onlyTesting,
    ],
    {
      cwd: iosProjectDir,
      stdio: "inherit",
      env: {
        ...process.env,
        TEST_RUNNER_ELIZA_BOOT_TIMEOUT_SECONDS:
          args["boot-timeout"] ??
          process.env.ELIZA_BOOT_TIMEOUT_SECONDS ??
          "180",
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
      },
    },
  );

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

  if (testResult.status !== 0) {
    fail(
      `harness run failed (xcodebuild exit ${testResult.status}). ` +
        "Exit 65 means a test assertion failed — e.g. the boot never reached home " +
        `or the startup-failure card. Review the screenshots in ${attachmentsDir}.`,
    );
  }
  log("boot capture PASSED (home or startup-failure card reached).");
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => fail(error?.stack ?? String(error)));
}
