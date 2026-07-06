#!/usr/bin/env node
/**
 * One-command iOS DEVICE deploy: unsigned local build → provisioning-profile
 * graft → explicit nested signing → verify → devicectl install → launch.
 *
 * Codifies the exact working recipe from the #11030 iOS boot-fix evidence:
 *   1. Build UNSIGNED via run-mobile-build ios-local (CODE_SIGNING_ALLOWED
 *      stays NO — this sidesteps the "requires a development team" failures).
 *   2. Auto-discover provisioning profiles: scan
 *      ~/Library/MobileDevice/Provisioning Profiles/ AND embedded
 *      .mobileprovision files inside prior signed builds in DerivedData;
 *      keep only profiles whose application-identifier covers the bundle id,
 *      whose ProvisionedDevices includes this device's UDID, and which are
 *      unexpired.
 *   3. Graft the app profile + one per appex, derive signing entitlements
 *      from each profile, then codesign inner→outer: frameworks → EVERY
 *      nested dylib (deep-verify does NOT catch unsigned appex dylibs) →
 *      appexes → app.
 *   4. codesign --verify --deep --strict, devicectl install, optional launch.
 *
 * Usage:
 *   node scripts/ios-device-deploy.mjs [--device <devicectl-id|udid|name>]
 *     [--skip-build] [--no-launch] [--skip-appexes] [--staging <dir>]
 *     [--identity <sha1>] [--derived-data <dir>] [--bundle-id <id>]
 *     [--configuration Debug|Release]
 *
 * --skip-appexes strips PlugIns/*.appex from the staged app before signing,
 * so the main app can be deployed for on-device testing when only the app's
 * own provisioning profile exists (each appex otherwise requires its own
 * profile, which only an Xcode account session or ASC API key can mint).
 *
 * Device id falls back to ELIZA_IOS_DEVICE_ID. Fails with actionable
 * remediation when no profile matches.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  readDevicectlDeviceList,
  readDevicectlDeviceLockState,
} from "./ios-device-devicectl.mjs";
import {
  assertDeviceUnlocked,
  buildCodesignPlan,
  buildPlistXml,
  DEFAULT_APP_BUNDLE_ID,
  deriveSigningEntitlements,
  findDeviceRecord,
  normalizeProvisioningProfile,
  parseCliArgs,
  parseCodesigningIdentities,
  parsePlist,
  resolveDeviceId,
  selectProvisioningProfile,
  selectSigningIdentity,
} from "./ios-device-lib.mjs";
import {
  appendDeployRecord,
  buildDeployRecord,
  evaluateStagedRendererFreshness,
  resolveDeployLedgerPath,
} from "./lib/ios-deploy-ledger.mjs";
import {
  freshRendererManifestPath,
  readRendererManifest,
  rendererManifestPathFromAppPath,
} from "./lib/ios-renderer-stamp.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(appRoot, "..", "..");

const log = (message) => console.log(`[ios-device-deploy] ${message}`);
const fail = (message) => {
  console.error(`[ios-device-deploy] ERROR: ${message}`);
  process.exit(1);
};

function runCapture(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options });
}

function runInherit(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} exited with ${result.status}`);
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

// ── Device resolution ───────────────────────────────────────────────────

export function resolveDevice(deviceId) {
  const payload = readDevicectlDeviceList();
  const record = findDeviceRecord(payload, deviceId);
  if (!record) {
    const names = (payload?.result?.devices ?? [])
      .map(
        (d) =>
          `  - ${d?.deviceProperties?.name ?? "?"}: identifier ${d?.identifier}, udid ${d?.hardwareProperties?.udid}`,
      )
      .join("\n");
    fail(
      `device "${deviceId}" not found via devicectl. Known devices:\n${names || "  (none — pair the phone: Finder → device → Trust, and enable Developer Mode)"}`,
    );
  }
  return record;
}

// ── Profile discovery ───────────────────────────────────────────────────

function decodeProfile(filePath) {
  try {
    const xml = runCapture("security", ["cms", "-D", "-i", filePath], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    return normalizeProvisioningProfile(parsePlist(xml), filePath);
  } catch {
    return null;
  }
}

export function discoverProfiles() {
  const candidates = [];
  const profileDir = path.join(
    os.homedir(),
    "Library",
    "MobileDevice",
    "Provisioning Profiles",
  );
  if (fs.existsSync(profileDir)) {
    for (const entry of fs.readdirSync(profileDir)) {
      if (entry.endsWith(".mobileprovision")) {
        candidates.push(path.join(profileDir, entry));
      }
    }
  }
  // Also reuse embedded.mobileprovision from prior signed device builds —
  // this is where Xcode-managed "iOS Team Provisioning Profile" copies land
  // even when the profiles dir is empty (the #11030 recipe grafted from
  // DerivedData/App-*/Build/Products/Debug-iphoneos/App.app).
  const derivedDataRoot = path.join(
    os.homedir(),
    "Library",
    "Developer",
    "Xcode",
    "DerivedData",
  );
  if (fs.existsSync(derivedDataRoot)) {
    for (const dd of fs.readdirSync(derivedDataRoot)) {
      const productsDir = path.join(derivedDataRoot, dd, "Build", "Products");
      if (!fs.existsSync(productsDir)) continue;
      for (const config of fs.readdirSync(productsDir)) {
        if (!config.endsWith("-iphoneos")) continue;
        const appDir = path.join(productsDir, config, "App.app");
        const appProfile = path.join(appDir, "embedded.mobileprovision");
        if (fs.existsSync(appProfile)) candidates.push(appProfile);
        const plugIns = path.join(appDir, "PlugIns");
        if (fs.existsSync(plugIns)) {
          for (const appex of fs.readdirSync(plugIns)) {
            const appexProfile = path.join(
              plugIns,
              appex,
              "embedded.mobileprovision",
            );
            if (fs.existsSync(appexProfile)) candidates.push(appexProfile);
          }
        }
      }
    }
  }
  return candidates.map(decodeProfile).filter(Boolean);
}

function noProfileRemediation(bundleId, udid, rejected) {
  const rejectedLines = rejected
    .slice(0, 20)
    .map(
      ({ profile, reasons }) =>
        `  - ${profile.name} (${profile.sourcePath}):\n      ${reasons.join("\n      ")}`,
    )
    .join("\n");
  return [
    `no provisioning profile covers ${bundleId} on device UDID ${udid}.`,
    rejected.length > 0
      ? `Profiles scanned and rejected:\n${rejectedLines}`
      : "No profiles found at all.",
    "Remediation (pick one):",
    "  1. Open packages/app/ios/App/App.xcworkspace in Xcode once with the team account",
    "     signed in and run the App scheme on this device — Xcode mints an",
    "     'iOS Team Provisioning Profile' including this device UDID, which this",
    "     script then discovers automatically (in DerivedData and the profiles dir).",
    "  2. Download a matching development profile into",
    "     ~/Library/MobileDevice/'Provisioning Profiles'/.",
    "  3. If the device is new, register its UDID in the developer portal (or via",
    "     Xcode's device registration) and regenerate the profile.",
  ].join("\n");
}

// ── Signing ─────────────────────────────────────────────────────────────

function listNestedDylibs(root) {
  const dylibs = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith(".framework")) continue; // signed as a unit
        stack.push(full);
      } else if (entry.name.endsWith(".dylib")) {
        dylibs.push(full);
      }
    }
  }
  return dylibs.sort();
}

function signApp({
  stagedApp,
  bundleId,
  deviceUdid,
  identityOverride,
  workDir,
}) {
  const profiles = discoverProfiles();
  log(`scanned ${profiles.length} provisioning profile(s)`);

  const target = { bundleId, deviceUdid };
  const { selected: appProfile, rejected } = selectProvisioningProfile(
    profiles,
    target,
  );
  if (!appProfile) fail(noProfileRemediation(bundleId, deviceUdid, rejected));
  log(
    `app profile: ${appProfile.name} (${appProfile.sourcePath}), expires ${appProfile.expirationDate?.toISOString()}`,
  );

  // Identity: explicit flag/env beats auto-discovery from the profile certs.
  let identity =
    identityOverride?.trim() ||
    process.env.ELIZA_IOS_SIGN_IDENTITY?.trim() ||
    null;
  if (!identity) {
    const identities = parseCodesigningIdentities(
      runCapture("security", ["find-identity", "-v", "-p", "codesigning"]),
    );
    const match = selectSigningIdentity(identities, appProfile);
    if (!match) {
      fail(
        `no codesigning identity in the keychain matches the certificates embedded in profile "${appProfile.name}".\n` +
          `Keychain identities: ${identities.map((i) => `${i.name} (${i.hash})`).join(", ") || "(none)"}\n` +
          "Install the Apple Development certificate + private key for this team, or pass --identity <sha1>.",
      );
    }
    identity = match.hash;
    log(`signing identity: ${match.name} (${match.hash})`);
  } else {
    log(`signing identity (explicit): ${identity}`);
  }

  // Graft the app profile.
  fs.copyFileSync(
    appProfile.sourcePath,
    path.join(stagedApp, "embedded.mobileprovision"),
  );

  // Per-appex profiles + entitlements.
  const appexes = [];
  const plugInsDir = path.join(stagedApp, "PlugIns");
  if (fs.existsSync(plugInsDir)) {
    for (const appexName of fs
      .readdirSync(plugInsDir)
      .filter((n) => n.endsWith(".appex"))) {
      const appexPath = path.join(plugInsDir, appexName);
      const appexBundleId = `${bundleId}.${path.basename(appexName, ".appex")}`;
      const { selected: appexProfile, rejected: appexRejected } =
        selectProvisioningProfile(profiles, {
          bundleId: appexBundleId,
          deviceUdid,
        });
      if (!appexProfile) {
        fail(
          `extension ${appexName}: ${noProfileRemediation(appexBundleId, deviceUdid, appexRejected)}`,
        );
      }
      log(
        `appex profile for ${appexName}: ${appexProfile.name} (${appexProfile.sourcePath})`,
      );
      fs.copyFileSync(
        appexProfile.sourcePath,
        path.join(appexPath, "embedded.mobileprovision"),
      );
      const entitlementsPath = path.join(
        workDir,
        `ent-${path.basename(appexName, ".appex")}.plist`,
      );
      fs.writeFileSync(
        entitlementsPath,
        buildPlistXml(deriveSigningEntitlements(appexProfile, appexBundleId)),
      );
      appexes.push({ path: appexPath, entitlementsPath });
    }
  }

  const appEntitlementsPath = path.join(workDir, "ent-app.plist");
  fs.writeFileSync(
    appEntitlementsPath,
    buildPlistXml(deriveSigningEntitlements(appProfile, bundleId)),
  );

  const frameworksDir = path.join(stagedApp, "Frameworks");
  const frameworks = fs.existsSync(frameworksDir)
    ? fs
        .readdirSync(frameworksDir)
        .filter((n) => n.endsWith(".framework") || n.endsWith(".dylib"))
        .map((n) => path.join(frameworksDir, n))
        .sort()
    : [];
  const dylibs = listNestedDylibs(stagedApp).filter(
    (dylib) => !dylib.startsWith(`${frameworksDir}${path.sep}`),
  );

  const plan = buildCodesignPlan({
    appPath: stagedApp,
    frameworks,
    dylibs,
    appexes,
    appEntitlementsPath,
  });
  log(
    `codesign plan: ${plan.length} step(s) (${frameworks.length} frameworks, ${dylibs.length} nested dylibs, ${appexes.length} appexes, 1 app)`,
  );
  for (const step of plan) {
    const args = ["--force", "--sign", identity, "--timestamp=none"];
    if (step.entitlementsPath)
      args.push("--entitlements", step.entitlementsPath);
    args.push(step.path);
    runInherit("codesign", args);
  }

  runInherit("codesign", ["--verify", "--deep", "--strict", stagedApp]);
  log("codesign --verify --deep --strict: OK");
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  const args = parseCliArgs(process.argv.slice(2), {
    booleans: [
      "skip-build",
      "no-launch",
      "skip-appexes",
      "allow-stale-renderer",
      "help",
    ],
  });
  if (args.help) {
    console.log(
      "Usage: node scripts/ios-device-deploy.mjs [--device <id>] [--skip-build] [--no-launch] [--skip-appexes] [--allow-stale-renderer] [--staging <dir>] [--identity <sha1>] [--derived-data <dir>] [--bundle-id <id>] [--configuration Debug|Release]",
    );
    return;
  }

  if (process.platform !== "darwin") fail("iOS device deploys require macOS.");

  const deviceId = resolveDeviceId({ flagValue: args.device ?? null });
  if (!deviceId) {
    fail(
      "no device given. Pass --device <devicectl-id|udid|name> or set ELIZA_IOS_DEVICE_ID.\n" +
        "List devices with: xcrun devicectl list devices",
    );
  }
  const device = resolveDevice(deviceId);
  log(
    `device: ${device.name} (identifier ${device.identifier}, udid ${device.udid})`,
  );

  const bundleId = args["bundle-id"] || DEFAULT_APP_BUNDLE_ID;
  const configuration = args.configuration || "Debug";
  const derivedData =
    args["derived-data"] ||
    process.env.ELIZA_IOS_DERIVED_DATA_PATH ||
    path.join(appRoot, "ios", "build", "device-deploy-dd");

  // 1. Unsigned device build (reuse the run-mobile-build ios-local lane).
  if (!args["skip-build"]) {
    log("building unsigned device app via run-mobile-build ios-local…");
    const env = {
      ...process.env,
      ELIZA_IOS_FULL_BUN_ENGINE: "1",
      ELIZA_IOS_BUILD_DESTINATION: "generic/platform=iOS",
      ELIZA_IOS_BUILD_SDK: "iphoneos",
      ELIZA_IOS_DERIVED_DATA_PATH: derivedData,
    };
    // Deliberately UNSIGNED: leave ELIZA_IOS_CODE_SIGNING_ALLOWED unset (the
    // lane defaults it to NO) and never pass ELIZA_IOS_DEVELOPMENT_TEAM —
    // signing happens below with the grafted profile.
    delete env.ELIZA_IOS_CODE_SIGNING_ALLOWED;
    delete env.ELIZA_IOS_DEVELOPMENT_TEAM;
    const result = spawnSync(
      "node",
      [
        path.join(
          repoRoot,
          "packages",
          "app-core",
          "scripts",
          "run-mobile-build.mjs",
        ),
        "ios-local",
      ],
      { cwd: appRoot, stdio: "inherit", env },
    );
    if (result.status !== 0)
      fail(`run-mobile-build ios-local exited with ${result.status}`);
  } else {
    log("--skip-build: reusing existing build products");
  }

  const builtApp = path.join(
    derivedData,
    "Build",
    "Products",
    `${configuration}-iphoneos`,
    "App.app",
  );
  if (!fs.existsSync(builtApp)) {
    fail(
      `built app not found at ${builtApp}.\n` +
        "Run without --skip-build, or pass --derived-data pointing at the DerivedData used for the build.",
    );
  }

  // 2. Stage a copy so the DerivedData product stays pristine.
  const stagingRoot =
    args.staging || path.join(appRoot, "ios", "build", "device-deploy-stage");
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });
  const stagedApp = path.join(stagingRoot, "App.app");
  runInherit("ditto", [builtApp, stagedApp]);
  log(`staged ${builtApp} → ${stagedApp}`);

  // Optional: strip app extensions so the main app can deploy with only its
  // own profile. Extension surfaces (widgets, keyboard, …) are absent from
  // the installed build — main-app-only testing, stated loudly in the log.
  if (args["skip-appexes"]) {
    const plugInsDir = path.join(stagedApp, "PlugIns");
    if (fs.existsSync(plugInsDir)) {
      const stripped = fs
        .readdirSync(plugInsDir)
        .filter((n) => n.endsWith(".appex"));
      fs.rmSync(plugInsDir, { recursive: true, force: true });
      log(
        `--skip-appexes: stripped ${stripped.length} extension(s): ${stripped.join(", ")} — widgets/keyboard/device-activity surfaces will be MISSING from this install`,
      );
    } else {
      log("--skip-appexes: no PlugIns directory present");
    }
  }

  // Renderer-freshness assert: the staged bundle carries a renderer build stamp
  // (public/eliza-renderer-build.json). Refuse to install one whose buildId does
  // not match the freshly built dist — a device booting a stale UI is the #9309
  // footgun (a cached dist grafted over a fresh one). --allow-stale-renderer is
  // the explicit escape hatch for an operator staging a deliberately older
  // bundle. Read the staged stamp now (also feeds the deploy-ledger row below).
  const stagedManifestPath = rendererManifestPathFromAppPath(stagedApp);
  const stagedManifest = readRendererManifest(
    stagedManifestPath,
    "staged App.app",
  );
  const freshManifestPath = freshRendererManifestPath({
    repoRoot,
    rendererDist: process.env.ELIZA_SMOKE_RENDERER_DIST,
  });
  if (!args["allow-stale-renderer"]) {
    const freshManifest = readRendererManifest(
      freshManifestPath,
      "freshly built",
    );
    const freshness = evaluateStagedRendererFreshness(
      stagedManifest,
      freshManifest,
    );
    if (!freshness.fresh) {
      fail(
        `renderer-freshness assert failed: ${freshness.reason}\n` +
          "Pass --allow-stale-renderer to deploy an intentionally older bundle.",
      );
    }
    log(`renderer freshness OK: ${freshness.reason}`);
  } else {
    log(
      `--allow-stale-renderer: skipping the renderer-freshness assert (staged buildId ${String(stagedManifest.buildId).slice(0, 12)})`,
    );
  }

  // 3–4. Profile graft + explicit nested signing + verify.
  signApp({
    stagedApp,
    bundleId,
    deviceUdid: device.udid,
    identityOverride: args.identity ?? null,
    workDir: stagingRoot,
  });

  // 5. Install.
  await waitForDeviceUnlocked(device, "preflight");
  log("installing via devicectl…");
  runInherit("xcrun", [
    "devicectl",
    "device",
    "install",
    "app",
    "--device",
    device.identifier,
    stagedApp,
  ]);
  // Record the deploy: one JSONL row keyed by device UDID with the renderer
  // buildId/commit just installed, so `devices:status` (#14338) can report this
  // phone's build without reading its sandboxed container. Written only after a
  // successful install — a failed install must not leave a false FRESH row.
  const ledgerPath = resolveDeployLedgerPath();
  const record = buildDeployRecord({
    udid: device.udid,
    buildId: stagedManifest.buildId,
    name: device.name,
    identifier: device.identifier,
    commit: stagedManifest.commit,
    variant: stagedManifest.variant,
    runtimeMode: stagedManifest.runtimeMode,
    skippedAppexes: Boolean(args["skip-appexes"]),
  });
  appendDeployRecord(ledgerPath, record);
  log(
    `ledger: recorded buildId ${String(record.buildId).slice(0, 12)} (commit ${record.commit ? record.commit.slice(0, 12) : "unknown"}) for ${device.name} → ${ledgerPath}`,
  );

  // 6. Launch (default on; --no-launch to skip). Console capture is
  //    ios-device-logs.mjs's job — this launch does not hold the terminal.
  if (!args["no-launch"]) {
    log("launching…");
    runInherit("xcrun", [
      "devicectl",
      "device",
      "process",
      "launch",
      "--terminate-existing",
      "--device",
      device.identifier,
      bundleId,
    ]);
  }
  log(`done. app=${bundleId} device=${device.name}`);
  log(`next: bun run ios:device:logs -- --device ${device.identifier}`);
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => fail(error?.stack ?? String(error)));
}
