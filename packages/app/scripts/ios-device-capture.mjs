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
 *   4. By default, shard AppUITests into isolated invocations and reset the
 *      app container between shards. BootCapture's onboarding tests are
 *      separate shards so cloud/local first-run paths both start fresh.
 *   5. `xcodebuild test-without-building -xctestrun …` drives each shard,
 *      screenshotting at intervals (XCUIScreen) and asserting the boot
 *      reaches home or the startup-failure card.
 *   6. `xcrun xcresulttool export attachments` lands every screenshot + the
 *      AX snapshot in --output/attachments/<shard>.
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
const DEFAULT_APP_BUNDLE_ID = "ai.elizaos.app";
const DEFAULT_TEST_SHARDS = [
  {
    name: "boot-reaches-home",
    onlyTesting: "AppUITests/BootCaptureUITests/testBootReachesHomeOrErrorCard",
  },
  {
    name: "composer-typed-text",
    onlyTesting: "AppUITests/BootCaptureUITests/testComposerAcceptsTypedText",
  },
  {
    name: "composer-send-reply",
    onlyTesting:
      "AppUITests/BootCaptureUITests/testComposerSendsPromptAndWaitsForReply",
  },
  {
    name: "onboarding-cloud",
    onlyTesting:
      "AppUITests/BootCaptureUITests/testCloudOnboardingChatAndVoice",
  },
  {
    name: "onboarding-local",
    onlyTesting:
      "AppUITests/BootCaptureUITests/testLocalOnboardingChatAndVoice",
  },
  {
    name: "gesture-semantics",
    onlyTesting: "AppUITests/GestureSemanticsUITests",
  },
  {
    name: "launcher-gesture-loop",
    onlyTesting: "AppUITests/LauncherGestureLoopUITests",
  },
  {
    name: "view-walkthrough",
    onlyTesting: "AppUITests/ViewWalkthroughUITests",
  },
  {
    name: "widget-gallery",
    onlyTesting: "AppUITests/WidgetGalleryCaptureUITests",
  },
  {
    name: "device-lifecycle",
    onlyTesting: "AppUITests/DeviceLifecycleUITests",
  },
];

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

function readAppBundleId() {
  const configPath = path.join(appRoot, "app.config.ts");
  if (!fs.existsSync(configPath)) return DEFAULT_APP_BUNDLE_ID;
  const appId = fs
    .readFileSync(configPath, "utf8")
    .match(/appId:\s*["']([^"']+)["']/)?.[1];
  return appId || DEFAULT_APP_BUNDLE_ID;
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
}

function defaultShardsFor(args) {
  if (args["only-testing"]) {
    return [
      {
        name: safeName(args["only-testing"]),
        onlyTesting: args["only-testing"],
      },
    ];
  }
  return DEFAULT_TEST_SHARDS;
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

function installSimulatorBundles(udid, bundles) {
  for (const bundle of bundles) {
    log(`simctl install ${path.basename(bundle)}`);
    runInherit("xcrun", ["simctl", "install", udid, bundle]);
  }
}

function resetSimulatorAppContainer({ udid, appBundleId, bundles, shardName }) {
  log(`reset simulator app container for shard ${shardName}`);
  spawnSync("xcrun", ["simctl", "terminate", udid, appBundleId], {
    stdio: "ignore",
  });
  spawnSync("xcrun", ["simctl", "uninstall", udid, appBundleId], {
    stdio: "ignore",
  });
  installSimulatorBundles(udid, bundles);
}

function resetDeviceAppContainer({ deviceIdentifier, appBundleId, shardName }) {
  log(`reset device app container for shard ${shardName}`);
  spawnSync(
    "xcrun",
    [
      "devicectl",
      "device",
      "uninstall",
      "app",
      "--device",
      deviceIdentifier,
      appBundleId,
    ],
    { stdio: "ignore" },
  );
  // xcodebuild installs the app/runner from the .xctestrun for physical-device
  // test-without-building. The explicit uninstall is the isolation boundary.
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    booleans: ["skip-build", "help"],
  });
  if (args.help) {
    console.log(
      "Usage: node scripts/ios-device-capture.mjs --platform sim|device [--device <udid>] [--skip-build] [--output <dir>] [--app-path <App.app>] [--boot-timeout <sec>] [--interval <sec>] [--agent-ready-timeout <sec>] [--derived-data <dir>] [--only-testing <id>] [--bundle-id <id>]",
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
  const appBundleId = args["bundle-id"] || readAppBundleId();
  const shards = defaultShardsFor(args);
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
  let simUdid = null;
  let deviceIdentifier = null;
  let installableSimulatorBundles = [];
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
    // Pre-install the runner + target app on the sim for each shard. Without
    // this a fresh test-without-building can race xcodebuild's own install
    // transaction and fail with "Unknown application display identifier".
    installableSimulatorBundles = extractXctestrunAppPaths(
      parsed,
      testRoot,
    ).filter((bundle) => bundle.endsWith(".app") && fs.existsSync(bundle));
  } else {
    const deviceId = resolveDeviceId({ flagValue: args.device ?? null });
    if (!deviceId)
      fail("device platform needs --device or ELIZA_IOS_DEVICE_ID.");
    const record = resolvePhysicalDeviceUdid(deviceId);
    deviceIdentifier = record.identifier;
    destination = `platform=iOS,id=${record.udid}`;
  }
  log(`destination: ${destination}`);
  log(`test shards: ${shards.map((shard) => shard.name).join(", ")}`);

  const shardResults = [];
  for (const [index, shard] of shards.entries()) {
    const shardName = safeName(
      `${String(index + 1).padStart(2, "0")}-${shard.name}`,
    );
    const resultBundle = path.join(outputDir, `${shardName}.xcresult`);
    fs.rmSync(resultBundle, { recursive: true, force: true });

    if (platform === "sim") {
      resetSimulatorAppContainer({
        udid: simUdid,
        appBundleId,
        bundles: installableSimulatorBundles,
        shardName,
      });
    } else {
      resetDeviceAppContainer({
        deviceIdentifier,
        appBundleId,
        shardName,
      });
    }

    const simVideo = startSimVideo({
      udid: simUdid,
      outputDir,
      filename: `${shardName}.mp4`,
    });
    let testResult;
    try {
      testResult = spawnSync(
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
          shard.onlyTesting,
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
            TEST_RUNNER_ELIZA_AGENT_READY_TIMEOUT_SECONDS:
              args["agent-ready-timeout"] ??
              process.env.ELIZA_AGENT_READY_TIMEOUT_SECONDS ??
              "240",
            TEST_RUNNER_ELIZA_LOCAL_MODEL_DOWNLOAD_WAIT_SECONDS:
              args["local-download-wait"] ??
              process.env.ELIZA_LOCAL_MODEL_DOWNLOAD_WAIT_SECONDS ??
              "0",
            ...(process.env.ELIZA_LOOP_SEED
              ? { TEST_RUNNER_ELIZA_LOOP_SEED: process.env.ELIZA_LOOP_SEED }
              : {}),
            ...(process.env.ELIZA_LOOP_ACTIONS
              ? {
                  TEST_RUNNER_ELIZA_LOOP_ACTIONS:
                    process.env.ELIZA_LOOP_ACTIONS,
                }
              : {}),
          },
        },
      );
    } finally {
      const videoPath = await simVideo.stop();
      if (videoPath) log(`simulator video: ${videoPath}`);
    }

    const attachmentsDir = path.join(outputDir, "attachments", shardName);
    fs.rmSync(attachmentsDir, { recursive: true, force: true });
    fs.mkdirSync(attachmentsDir, { recursive: true });
    let summaryPath = null;
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
        summaryPath = path.join(outputDir, `${shardName}.test-summary.json`);
        fs.writeFileSync(summaryPath, summary.stdout);
      }
    } else {
      log(`warning: no .xcresult bundle produced for ${shardName}.`);
    }

    const exported = fs.existsSync(attachmentsDir)
      ? fs.readdirSync(attachmentsDir)
      : [];
    const status = testResult.status ?? 1;
    shardResults.push({
      name: shard.name,
      onlyTesting: shard.onlyTesting,
      appBundleId,
      reset:
        platform === "sim" ? "simctl uninstall/install" : "devicectl uninstall",
      status,
      resultBundle,
      attachmentsDir,
      attachmentCount: exported.length,
      summaryPath,
    });
    log(
      `shard ${shardName}: exit=${status}, attachments=${exported.length}, result=${resultBundle}`,
    );
  }

  fs.writeFileSync(
    path.join(outputDir, "test-summary.json"),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        platform,
        destination,
        appBundleId,
        shards: shardResults,
      },
      null,
      2,
    )}\n`,
  );

  const failed = shardResults.filter((result) => result.status !== 0);
  if (failed.length > 0) {
    fail(
      `harness shard run failed (${failed.length}/${shardResults.length} shard(s)): ` +
        failed.map((result) => result.name).join(", ") +
        `. Review per-shard screenshots in ${path.join(outputDir, "attachments")}.`,
    );
  }
  log("boot capture PASSED (all isolated shards passed).");
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => fail(error?.stack ?? String(error)));
}
