/** Owns iOS build orchestration and signing target selection using the shared build context and existing platform contracts. */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  auditIosCloudArtifact,
  resolveIosAppFromBuildSettingsJson,
} from "../../lib/ios-cloud-artifact-audit.mjs";
import { buildMobileAgentBundle } from "../agent-bundle.mjs";
import { generateIosBrandAssets } from "../assets.mjs";
import { run, runCapacitor, runCaptureSync } from "../build-tools.mjs";
import { appCoreRoot, appDir, iosDir, repoRoot } from "../context.mjs";
import { isTruthyEnv } from "../environment.mjs";
import {
  ensurePlatform,
  mirrorCapacitorWebPayloadIntoIosDir,
} from "../platform-sync.mjs";
import { withCocoaPodsEnv } from "../toolchain.mjs";
import {
  buildWeb,
  ensureRendererDistMatchesLane,
  resolveMobileBuildPolicy,
} from "../web-build.mjs";
import {
  resolveIosBuildTarget,
  shouldRunIosPodInstall,
} from "./build-policy.mjs";
import {
  ensureIosFullBunEngineArtifact,
  ensureIosLlamaCppVendoredFramework,
} from "./engine.mjs";
import { prepareIosOverlay } from "./overlay.mjs";
import {
  isFullIosBunEngineRequested,
  isIosAppStoreBuild,
  isIosSimulatorBuildTarget,
  resolveIosBuildConfiguration,
  resolveIosCapacitorSyncEnv,
  resolveIosDeploymentTarget,
  shouldCleanIosBuildProducts,
  shouldIncludeIosFullBunEngine,
  shouldSkipIosCapacitorSync,
  shouldSkipIosPodInstall,
} from "./policy.mjs";
import {
  removeIosLocalExecutionAssets,
  stageIosAgentRuntime,
} from "./runtime-assets.mjs";

export function setDefaultProcessEnv(key, value) {
  if (process.env[key] == null || process.env[key] === "") {
    process.env[key] = value;
  }
}

export function configureIosLocalBuildDefaults() {
  setDefaultProcessEnv("ELIZA_IOS_RUNTIME_MODE", "local");
  setDefaultProcessEnv("VITE_ELIZA_IOS_RUNTIME_MODE", "local");
  setDefaultProcessEnv("ELIZA_RUNTIME_MODE", "local-safe");
  setDefaultProcessEnv("RUNTIME_MODE", "local-safe");
  setDefaultProcessEnv("LOCAL_RUNTIME_MODE", "local-safe");
  setDefaultProcessEnv("VITE_ELIZA_RUNTIME_MODE", "local-safe");
  if (isIosAppStoreBuild()) {
    process.env.ELIZA_IOS_INCLUDE_LLAMA = "0";
  } else {
    setDefaultProcessEnv("ELIZA_IOS_INCLUDE_LLAMA", "1");
  }
  setDefaultProcessEnv(
    "ELIZA_IOS_BUILD_DESTINATION",
    "generic/platform=iOS Simulator",
  );
  setDefaultProcessEnv("ELIZA_IOS_BUILD_SDK", "iphonesimulator");
}

export function configureIosAppStoreBuildDefaults() {
  setDefaultProcessEnv("ELIZA_BUILD_VARIANT", "store");
  setDefaultProcessEnv("ELIZA_RELEASE_AUTHORITY", "apple-app-store");
  setDefaultProcessEnv("ELIZA_IOS_RUNTIME_MODE", "cloud-hybrid");
  setDefaultProcessEnv("VITE_ELIZA_IOS_RUNTIME_MODE", "cloud-hybrid");
  setDefaultProcessEnv("ELIZA_RUNTIME_MODE", "local-safe");
  setDefaultProcessEnv("RUNTIME_MODE", "local-safe");
  setDefaultProcessEnv("LOCAL_RUNTIME_MODE", "local-safe");
  setDefaultProcessEnv("VITE_ELIZA_RUNTIME_MODE", "local-safe");
  process.env.ELIZA_IOS_INCLUDE_LLAMA = "0";
}

export async function buildIos({ local = false } = {}) {
  if (process.platform !== "darwin")
    throw new Error("iOS builds require macOS and Xcode.");

  if (local) {
    configureIosLocalBuildDefaults();
  } else {
    configureIosAppStoreBuildDefaults();
  }

  const iosBuildPolicy = resolveMobileBuildPolicy(local ? "ios-local" : "ios");
  setDefaultProcessEnv(
    "ELIZA_CAPACITOR_BUILD_TARGET",
    iosBuildPolicy.capacitorTarget,
  );
  setDefaultProcessEnv("ELIZA_BUILD_VARIANT", iosBuildPolicy.buildVariant);
  setDefaultProcessEnv(
    "ELIZA_RELEASE_AUTHORITY",
    iosBuildPolicy.releaseAuthority,
  );

  const buildTarget = resolveIosBuildTarget();
  const includesFullBunRuntime = shouldIncludeIosFullBunEngine();
  const includesLocalAgentPayload = local || includesFullBunRuntime;
  if (includesFullBunRuntime) {
    setDefaultProcessEnv("VITE_ELIZA_IOS_FULL_BUN_AVAILABLE", "1");
  }
  if (local && isFullIosBunEngineRequested(process.env)) {
    setDefaultProcessEnv("VITE_ELIZA_IOS_FULL_BUN_STRICT", "1");
  }
  if (includesFullBunRuntime) {
    ensureIosFullBunEngineArtifact({ buildTarget });
  }
  if (includesLocalAgentPayload) {
    await buildMobileAgentBundle({ target: "ios" });
  }

  const cocoapodsScript = path.join(
    appCoreRoot,
    "scripts",
    "prepare-ios-cocoapods.sh",
  );

  await buildWeb(local ? "ios-local" : "ios");
  await ensurePlatform("ios");
  if (includesLocalAgentPayload) {
    // Stage once before CocoaPods/Capacitor native dependency work so a
    // missing local toolchain still leaves the iOS app bundle resources in an
    // inspectable state. Capacitor sync may rewrite app resources, so we stage
    // again immediately after sync.
    stageIosAgentRuntime({
      appStoreBuild: isIosAppStoreBuild() && !local,
      includeFullBunEngine: includesFullBunRuntime,
    });
  } else if (isIosAppStoreBuild()) {
    removeIosLocalExecutionAssets();
  }
  if (fs.existsSync(cocoapodsScript)) {
    await run("bash", [cocoapodsScript], { cwd: repoRoot });
  }
  // Whether sync runs or is skipped, dist is about to be staged into
  // ios/App/App/public (cap sync webDir copy and/or the mirror overlay just
  // below) — verify it matches this lane first (#11030).
  await ensureRendererDistMatchesLane(local ? "ios-local" : "ios");
  if (shouldSkipIosCapacitorSync()) {
    console.log("[mobile-build] Skipping Capacitor iOS sync.");
  } else {
    await runCapacitor(["sync", "ios"], {
      env: resolveIosCapacitorSyncEnv(),
    });
  }
  // Overlay the freshly built renderer onto ios/App/App/public and assert it
  // matches the build — never ship a stale UI whether sync ran, was skipped, or
  // left old hashed assets behind (issue #9309). Runs before the post-sync agent
  // re-stage so the agent payload remains the final authority on public/agent.
  mirrorCapacitorWebPayloadIntoIosDir();
  if (includesLocalAgentPayload) {
    stageIosAgentRuntime({
      appStoreBuild: isIosAppStoreBuild() && !local,
      includeFullBunEngine: includesFullBunRuntime,
    });
  } else if (isIosAppStoreBuild()) {
    removeIosLocalExecutionAssets();
  }

  console.log(
    `[mobile-build] iOS build target: ${buildTarget.destination} (${buildTarget.sdk}; ${buildTarget.reason})`,
  );
  const syncedFiles = prepareIosOverlay({ buildTarget });
  await generateIosBrandAssets();
  await ensureIosLlamaCppVendoredFramework({ buildTarget });

  // CocoaPods compiles Capacitor from source, avoiding SPM binary API issues.
  // CocoaPods 1.16.x crashes with `Pod::Config#installation_root` when the
  // terminal locale is not UTF-8 (it warns "CocoaPods requires your terminal
  // to be using UTF-8 encoding"). Force the spawned `pod` process to a UTF-8
  // locale regardless of the host shell so builds don't fail under tmux,
  // CI runners, or background launchers that ship without LANG set.
  if (shouldSkipIosPodInstall()) {
    console.log("[mobile-build] Skipping CocoaPods install.");
  } else if (
    fs.existsSync(path.join(iosDir, "Podfile")) ||
    shouldRunIosPodInstall(syncedFiles)
  ) {
    await run("pod", ["install"], {
      cwd: iosDir,
      env: withCocoaPodsEnv({
        ...process.env,
        LANG: process.env.LANG?.includes("UTF-8")
          ? process.env.LANG
          : "en_US.UTF-8",
        LC_ALL: process.env.LC_ALL?.includes("UTF-8")
          ? process.env.LC_ALL
          : "en_US.UTF-8",
      }),
    });
  }

  const wsPath = path.join(iosDir, "App.xcworkspace");
  const projectArgs = fs.existsSync(wsPath)
    ? ["-workspace", "App.xcworkspace"]
    : ["-project", "App.xcodeproj"];
  const developmentTeam = process.env.ELIZA_IOS_DEVELOPMENT_TEAM?.trim();
  const derivedDataPath = process.env.ELIZA_IOS_DERIVED_DATA_PATH?.trim();
  const provisioningArgs = isTruthyEnv(
    process.env.ELIZA_IOS_ALLOW_PROVISIONING_UPDATES,
  )
    ? ["-allowProvisioningUpdates", "-allowProvisioningDeviceRegistration"]
    : [];
  const buildSelectionArgs = [
    ...projectArgs,
    "-scheme",
    "App",
    ...(derivedDataPath ? ["-derivedDataPath", derivedDataPath] : []),
    "-configuration",
    resolveIosBuildConfiguration(),
    "-destination",
    buildTarget.destination,
    "-sdk",
    buildTarget.sdk,
  ];
  await run(
    "xcodebuild",
    [
      ...buildSelectionArgs,
      ...provisioningArgs,
      `IPHONEOS_DEPLOYMENT_TARGET=${resolveIosDeploymentTarget()}`,
      `CODE_SIGNING_ALLOWED=${process.env.ELIZA_IOS_CODE_SIGNING_ALLOWED ?? "NO"}`,
      ...(developmentTeam ? [`DEVELOPMENT_TEAM=${developmentTeam}`] : []),
      ...(isIosSimulatorBuildTarget(buildTarget)
        ? ["ARCHS=arm64", "ONLY_ACTIVE_ARCH=YES", "EXCLUDED_ARCHS=x86_64"]
        : []),
      ...(shouldCleanIosBuildProducts() ? ["clean"] : []),
      "build",
    ],
    { cwd: iosDir },
  );

  // A source/native-graph policy cannot prove what Xcode actually linked and
  // copied. Thin iOS builds therefore inspect the final app product before it
  // can be treated as release evidence. Local-runtime lanes intentionally do
  // not use this prohibition audit.
  if (!includesLocalAgentPayload) {
    const settings = runCaptureSync(
      "xcodebuild",
      [...buildSelectionArgs, "-showBuildSettings", "-json"],
      { cwd: iosDir, maxBuffer: 32 * 1024 * 1024 },
    );
    if (settings.error || settings.status !== 0) {
      throw new Error(
        `[mobile-build] Could not resolve final iOS app for cloud artifact audit: ${
          settings.stderr?.trim() ||
          settings.stdout?.trim() ||
          settings.error?.message ||
          `xcodebuild exited ${String(settings.status)}`
        }`,
      );
    }
    const artifactPath = resolveIosAppFromBuildSettingsJson(settings.stdout);
    const attestation = auditIosCloudArtifact({
      artifactPath,
      freshDistDir: path.join(appDir, "dist"),
      expectedRuntimeMode: process.env.VITE_ELIZA_IOS_RUNTIME_MODE ?? null,
      requireCodesign:
        !isIosSimulatorBuildTarget(buildTarget) &&
        isTruthyEnv(process.env.ELIZA_IOS_CODE_SIGNING_ALLOWED),
      ...(process.env.ELIZA_IOS_ARTIFACT_ATTESTATION_PATH?.trim()
        ? {
            attestationPath:
              process.env.ELIZA_IOS_ARTIFACT_ATTESTATION_PATH.trim(),
          }
        : {}),
    });
    console.log(
      `[mobile-build] iOS cloud artifact audit passed: ${artifactPath} ` +
        `(renderer=${attestation.renderer.buildId.slice(0, 12)}, ` +
        `Mach-O=${attestation.machOBinaries.length}, signature=${attestation.signature.status}); ` +
        `attestation=${attestation.attestationFile}`,
    );
  }
}
