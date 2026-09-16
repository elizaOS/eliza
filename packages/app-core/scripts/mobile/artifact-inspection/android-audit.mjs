/** Owns artifact inspection android audit using the shared build context and existing platform contracts. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  ANDROID_LP3_POLICY_CLASSES,
  ANDROID_LP3_POLICY_MARKERS,
  ANDROID_LP3_PRIVATE_ACTIONS,
  assertAndroidPlayManifestPolicyEvidence,
  inspectAndroidAppBundle,
  resolveAndroidArtifactKind,
} from "../../lib/android-cloud-artifact-audit.mjs";
import {
  ANDROID_CLOUD_SPLASH_MARK_RESOURCE,
  ANDROID_LAUNCHER_IN_APP_AUTH_HOSTS,
  ANDROID_LP3_COLOR_POLICY_COMPONENTS,
  ANDROID_LP3_COLOR_POLICY_JAVA_FILES,
  ANDROID_LP3_COLOR_POLICY_REQUIRED_PERMISSIONS,
  assertAndroidArtifactOmitsLp3ManifestMarkers,
  assertAndroidCloudNativeLibraryAllowlist,
  assertAndroidLauncherManifest,
  assertAndroidLp3ColorPolicyManifest,
  assertAndroidSmsGatewayArtifactManifest,
  assertAndroidSmsGatewayBadging,
  createAndroidPlayManifestPolicy,
  findAndroidCloudPackagedRuntimeOffenders,
  findAndroidPlayIndexHtmlFindings,
  findAndroidPlayTextAssetFindings,
  isAndroidFirebaseIndependentRemoteBuild,
  isAndroidLp3ColorPolicyEnabled,
  resolveAndroidCloudStripPolicy,
} from "../android/cloud-policy.mjs";
import { mobileBuildError } from "../build-error.mjs";
import { APP, androidDir } from "../context.mjs";
import { firstExisting, resolveAndroidSdkRoot } from "../toolchain.mjs";
import {
  androidPlayManifestEvidenceFromAapt,
  dumpAndroidArtifactBadging,
  dumpAndroidArtifactManifest,
  resolveAndroidBuildTool,
} from "./android-tools.mjs";
import {
  assertAndroidArtifactRetainsBackgroundRunnerJniBridge,
  assertAndroidArtifactShipsWebPayload,
  assertAndroidArtifactSnapshotUnchanged,
  listAndroidArtifactEntries,
  readAndroidArtifactEntryBuffers,
  snapshotAndroidArtifact,
} from "./archive.mjs";
import { findAndroidSystemApk } from "./provenance.mjs";

/**
 * Audit the sideload (`android`) debug APK. The sideload target ships both the
 * web renderer and the on-device agent payload, so assert both are packaged —
 * a web-less sideload APK is the exact regression of elizaOS/eliza#8387
 * (ERR_CONNECTION_REFUSED on device).
 */
export function auditAndroidSideloadArtifact({ javaHome } = {}) {
  const artifact = findAndroidCloudDebugApk();
  if (!artifact) {
    throw new Error(
      "[mobile-build] android sideload debug APK was not found under app/build/outputs/.",
    );
  }
  const entries = listAndroidArtifactEntries(artifact, javaHome);
  assertAndroidArtifactRetainsBackgroundRunnerJniBridge(
    artifact,
    entries,
    javaHome,
    { label: "android sideload" },
  );
  assertAndroidArtifactShipsWebPayload(artifact, entries, {
    requireAgent: true,
    label: "android",
  });
  const fusedEntry = entries.find((entry) =>
    /(?:^|\/)lib\/arm64-v8a\/libelizainference\.so$/i.test(
      entry.replaceAll("\\", "/"),
    ),
  );
  if (fusedEntry) {
    const [fusedBytes] = readAndroidArtifactEntryBuffers(
      artifact,
      [fusedEntry],
      javaHome,
      {
        label: "Android bionic fused inference audit",
        maxEntryBytes: 128 * 1024 * 1024,
        maxTotalBytes: 128 * 1024 * 1024,
      },
    );
    const offenders = findAndroidBionicInferenceOffenders(fusedBytes);
    if (offenders.length > 0) {
      throw mobileBuildError(
        `[mobile-build] android sideload artifact contains a Linux/musl fused inference library that Android's bionic loader cannot load: ${offenders.join(", ")}. Rebuild and stage it with \`node packages/app-core/scripts/stage-elizavoice-lib.mjs --abi arm64-v8a --variant cpu\` (or the Vulkan variant with its required host tooling).`,
        {
          code: "ANDROID_BIONIC_INFERENCE_INCOMPATIBLE",
          context: { artifact, fusedEntry, offenders },
        },
      );
    }
  }
  console.log(
    `[mobile-build] android sideload artifact audit passed: ${artifact}`,
  );
  return artifact;
}

/**
 * Detect libc ABI markers that are valid for Linux/musl builds but unresolved
 * on Android. The bionic host dlopens this library inside the app process, so
 * accepting one of these symbols would defer a deterministic packaging defect
 * until device startup.
 */
export function findAndroidBionicInferenceOffenders(bytes) {
  const binary = Buffer.from(bytes);
  return ["__errno_location"].filter((symbol) =>
    binary.includes(Buffer.from(symbol, "utf8")),
  );
}

/** Audit the hosted-emulator debug APK without requiring a local agent payload. */
export function auditAndroidHostE2eArtifact({ javaHome } = {}) {
  const artifact = findAndroidCloudDebugApk();
  if (!artifact) {
    throw new Error(
      "[mobile-build] android host-e2e debug APK was not found under app/build/outputs/.",
    );
  }
  const entries = listAndroidArtifactEntries(artifact, javaHome);
  assertAndroidArtifactRetainsBackgroundRunnerJniBridge(
    artifact,
    entries,
    javaHome,
    { label: "android host-e2e" },
  );
  assertAndroidArtifactShipsWebPayload(artifact, entries, {
    requireAgent: false,
    label: "android-host-e2e",
  });
  const packagedAgent = entries.find((entry) =>
    /(^|\/)assets\/agent\//i.test(entry.replaceAll("\\", "/")),
  );
  if (packagedAgent) {
    throw mobileBuildError(
      `[mobile-build] android-host-e2e artifact unexpectedly contains the embedded agent payload: ${packagedAgent}`,
      {
        code: "ANDROID_HOST_E2E_AGENT_PAYLOAD_PRESENT",
        context: { artifact, packagedAgent },
      },
    );
  }
  console.log(
    `[mobile-build] android host-e2e artifact audit passed: ${artifact}`,
  );
  return artifact;
}

export function auditAndroidSystemArtifact({ androidSdkRoot, javaHome } = {}) {
  // The AOSP/system target gets the web-payload mirror like the other three
  // sync targets, but the privileged release APK still needs the same positive
  // artifact audit or it could ship web-less (ERR_CONNECTION_REFUSED) silently —
  // the exact regression class #8387 closes. `-PelizaAospBuild=true` preserves
  // assets/agent, so requireAgent stays true here like the sideload path.
  const artifact = findAndroidSystemApk();
  if (!artifact) {
    throw new Error(
      "[mobile-build] android-system release APK was not found under app/build/outputs/apk/release/.",
    );
  }
  const entries = listAndroidArtifactEntries(artifact, javaHome);
  assertAndroidArtifactRetainsBackgroundRunnerJniBridge(
    artifact,
    entries,
    javaHome,
    { label: "android-system" },
  );
  const aapt = resolveAndroidBuildTool(androidSdkRoot, "aapt");
  if (!aapt) {
    throw mobileBuildError(
      "[mobile-build] Could not find aapt under Android SDK build-tools for android-system artifact audit.",
    );
  }
  // RECEIVE_BOOT_COMPLETED and FOREGROUND_SERVICE_SPECIAL_USE are also used by
  // non-LP3 AOSP services. WRITE_SECURE_SETTINGS is the LP3-only manifest
  // delta; the remaining private boundary is enforced by component/action/DEX
  // markers below.
  assertAndroidArtifactOmitsLp3ManifestMarkers(
    dumpAndroidArtifactManifest(aapt, artifact),
    {
      appId: APP.appId,
      label: "ordinary AOSP",
      permissions: ["WRITE_SECURE_SETTINGS"],
    },
  );
  auditAndroidArtifactDexLp3Policy(artifact, entries, javaHome, {
    debug: false,
    expectedPresent: false,
    label: "ordinary AOSP",
  });
  assertAndroidArtifactShipsWebPayload(artifact, entries, {
    requireAgent: true,
    label: "android-system",
  });
  console.log(
    `[mobile-build] android-system artifact audit passed: ${artifact}`,
  );
  return artifact;
}

export function findAndroidCloudAab(
  releaseBundleDir = path.join(
    androidDir,
    "app",
    "build",
    "outputs",
    "bundle",
    "release",
  ),
) {
  return firstExisting([path.join(releaseBundleDir, "app-release.aab")]);
}

export function findAndroidCloudDebugApk() {
  return firstExisting([
    path.join(
      androidDir,
      "app",
      "build",
      "outputs",
      "apk",
      "debug",
      "app-debug.apk",
    ),
  ]);
}

export function auditAndroidArtifactDexLp3Policy(
  artifact,
  entries,
  javaHome,
  { debug, expectedPresent, label = "normal Cloud" },
  { readEntryBuffers = readAndroidArtifactEntryBuffers } = {},
) {
  const dexEntries = entries.filter((entry) =>
    /(^|\/)classes\d*\.dex$/.test(entry),
  );
  if (dexEntries.length === 0) {
    throw mobileBuildError(
      `[mobile-build] Android artifact has no classes*.dex entries: ${artifact}`,
    );
  }

  const dexBuffers = readEntryBuffers(artifact, dexEntries, javaHome, {
    label: "LP3 policy DEX audit",
  });
  const packagePath = APP.appId.replaceAll(".", "/");
  const classNames =
    expectedPresent && !debug
      ? ANDROID_LP3_COLOR_POLICY_COMPONENTS
      : ANDROID_LP3_COLOR_POLICY_JAVA_FILES.map((file) =>
          file.replace(/\.java$/, ""),
        );
  const findings = classNames.filter((className) => {
    const marker = Buffer.from(`${packagePath}/${className}`, "utf8");
    return dexBuffers.some((dex) => dex.includes(marker));
  });
  if (expectedPresent && findings.length !== classNames.length) {
    const missing = classNames.filter((name) => !findings.includes(name));
    throw mobileBuildError(
      "[mobile-build] opted-in LP3 artifact DEX is missing policy classes:\n" +
        missing.map((name) => `  - ${APP.appId}.${name}`).join("\n"),
    );
  }
  if (!expectedPresent) {
    const forbiddenMarkers = [
      ...ANDROID_LP3_POLICY_CLASSES.map(
        (className) => `${packagePath}/${className}`,
      ),
      ...ANDROID_LP3_PRIVATE_ACTIONS,
      ...ANDROID_LP3_POLICY_MARKERS,
    ];
    const markerFindings = forbiddenMarkers.filter((marker) => {
      const bytes = Buffer.from(marker, "utf8");
      return dexBuffers.some((dex) => dex.includes(bytes));
    });
    if (markerFindings.length === 0) return;
    throw mobileBuildError(
      `[mobile-build] ${label} artifact DEX still contains LP3 policy markers:\n` +
        markerFindings.map((marker) => `  - ${marker}`).join("\n"),
    );
  }
}

export function auditAndroidCloudArtifact(
  {
    artifact: requestedArtifact,
    debug = false,
    env = process.env,
    javaHome,
  } = {},
  {
    inspectAndroidAppBundleImpl = inspectAndroidAppBundle,
    log = console.log,
  } = {},
) {
  const lp3ColorPolicyEnabled = isAndroidLp3ColorPolicyEnabled(env);
  const stripPolicy = resolveAndroidCloudStripPolicy(env);
  const artifact =
    typeof requestedArtifact === "string" && requestedArtifact.trim() !== ""
      ? path.resolve(requestedArtifact.trim())
      : debug
        ? findAndroidCloudDebugApk()
        : findAndroidCloudAab();
  if (artifact && !fs.existsSync(artifact)) {
    throw mobileBuildError(
      `[mobile-build] requested android-cloud artifact does not exist: ${artifact}`,
    );
  }
  if (!artifact) {
    throw mobileBuildError(
      `[mobile-build] android-cloud ${debug ? "debug APK" : "release AAB"} was not found under app/build/outputs/.`,
    );
  }
  const expectedArtifactKind = debug ? "apk" : "aab";
  const artifactKind = resolveAndroidArtifactKind(artifact);
  if (artifactKind !== expectedArtifactKind) {
    throw mobileBuildError(
      `[mobile-build] android-cloud ${debug ? "debug" : "release"} audit expected ${expectedArtifactKind.toUpperCase()} but received ${artifactKind.toUpperCase()}: ${artifact}`,
    );
  }
  const initialSnapshot = snapshotAndroidArtifact(artifact);
  const entries = listAndroidArtifactEntries(artifact, javaHome, {
    artifactBytes: initialSnapshot.bytes,
  });
  const offenders = findAndroidCloudPackagedRuntimeOffenders(entries);
  if (offenders.length > 0) {
    throw mobileBuildError(
      `[mobile-build] android-cloud artifact contains local runtime payloads:\n` +
        offenders.map((entry) => `  - ${entry}`).join("\n"),
      {
        code: "ANDROID_CLOUD_RUNTIME_PAYLOAD_PRESENT",
        context: { artifact, offenders },
      },
    );
  }
  if (
    !entries.some((entry) =>
      new RegExp(
        `(?:^|/)res/drawable-nodpi(?:-v4)?/${ANDROID_CLOUD_SPLASH_MARK_RESOURCE}\\.png$`,
      ).test(entry),
    )
  ) {
    throw mobileBuildError(
      "[mobile-build] android-cloud artifact is missing its transparent white system-splash mark",
      {
        code: "ANDROID_CLOUD_SPLASH_MARK_MISSING",
        context: { artifact },
      },
    );
  }
  if (!lp3ColorPolicyEnabled) {
    assertAndroidCloudNativeLibraryAllowlist({ artifact, entries, env });
    const textAssetEntries = entries.filter(
      (entry) =>
        /(?:^|\/)assets\//.test(entry) &&
        /\.(?:css|html|js|json|svg|txt|webmanifest|xml)$/i.test(entry),
    );
    const textAssetBuffers = readAndroidArtifactEntryBuffers(
      artifact,
      textAssetEntries,
      javaHome,
      {
        artifactBytes: initialSnapshot.bytes,
        label: "android-cloud Play text asset audit",
      },
    );
    const textAssetFindings = findAndroidPlayTextAssetFindings(
      textAssetEntries,
      textAssetBuffers,
    );
    const indexHtmlFindings = findAndroidPlayIndexHtmlFindings(
      textAssetEntries,
      textAssetBuffers,
    );
    const playTextFindings = [
      ...textAssetFindings,
      ...indexHtmlFindings,
    ].sort();
    if (playTextFindings.length > 0) {
      throw mobileBuildError(
        `[mobile-build] android-cloud text asset policy failed:\n${playTextFindings
          .map((finding) => `  - ${finding}`)
          .join("\n")}`,
        {
          code: "ANDROID_PLAY_TEXT_ASSET_POLICY_FAILED",
          context: { artifact, findings: playTextFindings },
        },
      );
    }
  }
  const integrityEntries = entries.filter((entry) =>
    artifactKind === "aab"
      ? /^[^/]+\/manifest\/AndroidManifest\.xml$/.test(entry) ||
        entry === "base/assets/public/index.html" ||
        entry === "base/assets/capacitor.config.json"
      : entry === "AndroidManifest.xml" ||
        entry === "assets/public/index.html" ||
        entry === "assets/capacitor.config.json",
  );
  if (integrityEntries.length > 0) {
    readAndroidArtifactEntryBuffers(artifact, integrityEntries, javaHome, {
      artifactBytes: initialSnapshot.bytes,
      label: "android-cloud policy evidence",
    });
  }
  const snapshotDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "eliza-android-artifact-snapshot-"),
  );
  const inspectedArtifact = path.join(snapshotDir, `artifact.${artifactKind}`);
  try {
    fs.writeFileSync(inspectedArtifact, initialSnapshot.bytes);
  } catch (cause) {
    // error-policy:J2 preserve snapshot provenance around materialization failures
    fs.rmSync(snapshotDir, { force: true, recursive: true });
    throw mobileBuildError(
      `[mobile-build] Could not materialize immutable Android artifact snapshot: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
        code: "ANDROID_ARTIFACT_SNAPSHOT_FAILED",
        context: { artifact, inspectedArtifact },
      },
    );
  }
  let evidence;
  try {
    // The Play client deliberately strips Background Runner and every
    // background execution surface. Its artifact must therefore stay native
    // library free; JNI bridge retention is enforced only by the sideload,
    // host-E2E, and system artifact audits that compile the plugin.
    if (artifactKind === "apk") {
      // APK inspection deliberately retains the existing AAPT badging/xmltree
      // behavior. bundletool is only valid for the release App Bundle path.
      const aapt = resolveAndroidBuildTool(resolveAndroidSdkRoot(env), "aapt");
      if (!aapt) {
        throw mobileBuildError(
          "[mobile-build] Could not find aapt under Android SDK build-tools for android-cloud artifact audit.",
        );
      }
      const badging = dumpAndroidArtifactBadging(aapt, inspectedArtifact);
      const permissionOffenders = stripPolicy.permissions.filter((perm) =>
        badging.includes(`uses-permission: name='android.permission.${perm}'`),
      );
      if (permissionOffenders.length > 0) {
        throw mobileBuildError(
          "[mobile-build] android-cloud artifact still requests stripped permissions:\n" +
            permissionOffenders
              .map((perm) => `  - android.permission.${perm}`)
              .join("\n"),
        );
      }
      const manifestText = dumpAndroidArtifactManifest(aapt, inspectedArtifact);
      for (const component of stripPolicy.components) {
        if (manifestText.includes(`${APP.appId}.${component}`)) {
          throw mobileBuildError(
            `[mobile-build] android-cloud artifact still declares stripped component ${component}`,
          );
        }
      }
      if (lp3ColorPolicyEnabled) {
        const missingPermissions =
          ANDROID_LP3_COLOR_POLICY_REQUIRED_PERMISSIONS.filter(
            (permission) =>
              !badging.includes(
                `uses-permission: name='android.permission.${permission}'`,
              ),
          );
        if (missingPermissions.length > 0) {
          throw mobileBuildError(
            "[mobile-build] opted-in LP3 artifact is missing required permissions:\n" +
              missingPermissions
                .map((permission) => `  - android.permission.${permission}`)
                .join("\n"),
          );
        }
        assertAndroidLp3ColorPolicyManifest(manifestText);
      } else {
        assertAndroidArtifactOmitsLp3ManifestMarkers(manifestText, {
          appId: APP.appId,
          label: "normal Cloud",
        });
        assertAndroidPlayManifestPolicyEvidence(
          androidPlayManifestEvidenceFromAapt(manifestText),
          createAndroidPlayManifestPolicy({
            debug: true,
            firebaseIndependent: isAndroidFirebaseIndependentRemoteBuild(env),
          }),
        );
      }
      auditAndroidArtifactDexLp3Policy(
        inspectedArtifact,
        entries,
        javaHome,
        {
          debug,
          expectedPresent: lp3ColorPolicyEnabled,
        },
        {
          readEntryBuffers: (
            selectedArtifact,
            selectedEntries,
            selectedJavaHome,
            options,
          ) =>
            readAndroidArtifactEntryBuffers(
              selectedArtifact,
              selectedEntries,
              selectedJavaHome,
              {
                ...options,
                artifactBytes: initialSnapshot.bytes,
              },
            ),
        },
      );
    } else {
      evidence = inspectAndroidAppBundleImpl({
        appId: APP.appId,
        artifact: inspectedArtifact,
        entries,
        env,
        javaHome,
        playPolicy: createAndroidPlayManifestPolicy({ debug: false }),
        readDexEntries: (dexEntries) =>
          readAndroidArtifactEntryBuffers(
            inspectedArtifact,
            dexEntries,
            javaHome,
            {
              artifactBytes: initialSnapshot.bytes,
              label: "android-cloud AAB DEX audit",
            },
          ),
        strippedComponents: stripPolicy.components,
        strippedPermissions: stripPolicy.permissions,
      });
    }
    // Cloud is a thin client (no on-device agent), but it must still ship the
    // renderer — a web-less cloud APK is just as broken as a web-less sideload.
    assertAndroidArtifactShipsWebPayload(artifact, entries, {
      requireAgent: false,
      label: "android-cloud",
    });
  } finally {
    fs.rmSync(snapshotDir, { force: true, recursive: true });
  }
  const finalSnapshot = snapshotAndroidArtifact(artifact);
  assertAndroidArtifactSnapshotUnchanged(
    artifact,
    initialSnapshot,
    finalSnapshot,
  );
  if (evidence) {
    log(
      `[mobile-build] android-cloud AAB manifests inspected: ${evidence.modules.join(", ")}`,
    );
    log(
      `[mobile-build] android-cloud AAB DEX inspected:\n${evidence.dexEntries.map((entry) => `  - ${entry}`).join("\n")}`,
    );
    log(
      `[mobile-build] android-cloud AAB attestation ${JSON.stringify({
        ...evidence,
        artifact: {
          path: artifact,
          sha256: initialSnapshot.sha256,
          sizeBytes: initialSnapshot.sizeBytes,
        },
      })}`,
    );
  }
  log(
    `[mobile-build] android-cloud${lp3ColorPolicyEnabled ? " LP3 direct" : ""} artifact audit passed: ${artifact}`,
  );
  return artifact;
}

export function auditAndroidLauncherArtifact({
  androidSdkRoot,
  env = process.env,
  javaHome,
} = {}) {
  const artifact = auditAndroidCloudArtifact({
    debug: true,
    env,
    javaHome,
  });
  const aapt = resolveAndroidBuildTool(androidSdkRoot, "aapt");
  if (!aapt) {
    throw mobileBuildError(
      "[mobile-build] Could not find aapt under Android SDK build-tools for android-launcher artifact audit.",
    );
  }
  assertAndroidLauncherManifest(dumpAndroidArtifactManifest(aapt, artifact));
  const [runtimeConfigBytes] = readAndroidArtifactEntryBuffers(
    artifact,
    ["assets/capacitor.config.json"],
    javaHome,
    { label: "android-launcher Capacitor runtime config" },
  );
  let runtimeConfig;
  try {
    runtimeConfig = JSON.parse(runtimeConfigBytes.toString("utf8"));
  } catch (cause) {
    throw mobileBuildError(
      `[mobile-build] android-launcher capacitor.config.json is invalid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      {
        cause,
        code: "ANDROID_LAUNCHER_RUNTIME_CONFIG_INVALID",
        context: { artifact },
      },
    );
  }
  if (runtimeConfig.loggingBehavior !== "none") {
    throw mobileBuildError(
      "[mobile-build] android-launcher must package Capacitor loggingBehavior=none so native bridge results never reach logcat.",
      {
        code: "ANDROID_LAUNCHER_RUNTIME_LOGGING_ENABLED",
        context: {
          artifact,
          loggingBehavior: runtimeConfig.loggingBehavior ?? null,
        },
      },
    );
  }
  if (
    JSON.stringify(runtimeConfig.server?.allowNavigation) !==
    JSON.stringify(ANDROID_LAUNCHER_IN_APP_AUTH_HOSTS)
  ) {
    throw mobileBuildError(
      "[mobile-build] android-launcher must keep WebView navigation pinned to the canonical Eliza hosted-auth origins.",
      {
        code: "ANDROID_LAUNCHER_AUTH_NAVIGATION_INVALID",
        context: {
          allowNavigation: runtimeConfig.server?.allowNavigation ?? null,
          artifact,
        },
      },
    );
  }
  console.log(
    `[mobile-build] android-launcher HOME-role artifact audit passed: ${artifact}`,
  );
  return artifact;
}

export function auditAndroidSmsGatewayArtifact({
  androidSdkRoot,
  javaHome,
} = {}) {
  const artifact = findAndroidCloudDebugApk();
  if (!artifact) {
    throw new Error(
      "[mobile-build] android-sms-gateway debug APK was not found under app/build/outputs/.",
    );
  }

  assertNoAndroidSmsGatewayPackagedOffenders(artifact, javaHome);
  assertAndroidArtifactShipsWebPayload(
    artifact,
    listAndroidArtifactEntries(artifact, javaHome),
    { requireAgent: false, label: "android-sms-gateway" },
  );

  const aapt = resolveAndroidBuildTool(androidSdkRoot, "aapt");
  if (!aapt) {
    throw new Error(
      "[mobile-build] Could not find aapt under Android SDK build-tools for android-sms-gateway artifact audit.",
    );
  }
  const badging = dumpAndroidArtifactBadging(aapt, artifact);
  assertAndroidSmsGatewayBadging(badging);
  const manifestText = dumpAndroidArtifactManifest(aapt, artifact);
  assertAndroidSmsGatewayArtifactManifest(manifestText);

  console.log(
    `[mobile-build] android-sms-gateway artifact audit passed: ${artifact}`,
  );
  return artifact;
}

export function assertNoAndroidSmsGatewayPackagedOffenders(artifact, javaHome) {
  const packagedOffenders = findAndroidCloudPackagedRuntimeOffenders(
    listAndroidArtifactEntries(artifact, javaHome),
  );
  if (packagedOffenders.length > 0) {
    throw mobileBuildError(
      `[mobile-build] android-sms-gateway artifact contains local runtime payloads:\n` +
        packagedOffenders.map((entry) => `  - ${entry}`).join("\n"),
      {
        code: "ANDROID_CLOUD_RUNTIME_PAYLOAD_PRESENT",
        context: { artifact, offenders: packagedOffenders },
      },
    );
  }
}
