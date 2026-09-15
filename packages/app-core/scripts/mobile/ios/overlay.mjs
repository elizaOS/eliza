/** Owns ios overlay using the shared build context and existing platform contracts. */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  resolveNativePluginPackagePath,
  resolvePackagePath,
  syncPlatformTemplateFiles,
} from "../build-tools.mjs";
import { APP, appDir, platformsDir } from "../context.mjs";
import { isTruthyEnv } from "../environment.mjs";
import { assertIosHealthKitBuildAuthority } from "../ios-healthkit-authority.mjs";
import {
  mergeIosInfoPlist,
  readIosApnsBuildFlag,
  readIosHealthKitBuildFlag,
  replaceIosAppGroupPlaceholders,
} from "../ios-plist.mjs";
import {
  IOS_COCOAPODS_OWNED_SPM_PLUGINS,
  IOS_INCOMPATIBLE_SPM_PLUGINS,
  IOS_OFFICIAL_PODS,
  resolveIosCustomPods,
} from "../ios-pods.mjs";
import { applyIosAppIdentity } from "./identity.mjs";
import {
  isIosAppStoreBuild,
  isIosSimulatorBuildTarget,
  resolveIosDeploymentTarget,
  shouldDisableIosPrivilegedCapabilities,
  shouldIncludeIosFullBunEngine,
  shouldIncludeIosLlama,
} from "./policy.mjs";
import { IOS_PERSONAL_TEAM_ENTITLEMENTS } from "./runtime-assets.mjs";

// ── Phase 4: iOS native overlay ─────────────────────────────────────────

export function overlayIos() {
  const targetAppDir = path.join(appDir, "ios", "App", "App");

  // Merge Info.plist permission strings
  const plistPath = path.join(targetAppDir, "Info.plist");
  if (fs.existsSync(plistPath)) {
    let plist = fs.readFileSync(plistPath, "utf8");
    let dirty = false;
    const healthKitEnabled = readIosHealthKitBuildFlag(
      process.env.ELIZA_IOS_HEALTHKIT_ENABLED,
    );
    assertIosHealthKitBuildAuthority({
      enabled: healthKitEnabled,
      appId: APP.appId,
      provisioningProfilePath:
        process.env.MOBILE_SIGNALS_IOS_PROVISIONING_PROFILE,
    });
    // UIBackgroundModes and BGTaskSchedulerPermittedIdentifiers are MERGED,
    // not force-set: the template Info.plist already declares the modes the
    // ElizaTasks plugin needs (`processing`, `remote-notification`) and the
    // BGTaskScheduler identifiers (`ai.eliza.tasks.refresh`,
    // `ai.eliza.tasks.processing`). The overlay only guarantees the baseline
    // `fetch` mode is present and that the ElizaTasks identifiers survive a
    // regeneration where a downstream embedder forgot to copy them.
    const nextPlist = mergeIosInfoPlist(plist, {
      appName: APP.appName,
      urlScheme: APP.urlScheme,
      apnsEnabled: readIosApnsBuildFlag(process.env.VITE_ELIZA_APNS_ENABLED),
      healthKitEnabled,
    });
    if (nextPlist.changed) {
      plist = nextPlist.content;
      dirty = true;
    }
    if (dirty) {
      fs.writeFileSync(plistPath, plist, "utf8");
      console.log("[mobile-build] Merged iOS permission strings.");
    }
  }

  // Copy entitlements with app group derived from appId
  const srcEnt = path.join(
    platformsDir,
    "ios",
    "App",
    "App",
    "App.entitlements",
  );
  if (fs.existsSync(srcEnt)) {
    let ent = fs.readFileSync(srcEnt, "utf8");
    if (shouldDisableIosPrivilegedCapabilities()) {
      ent = IOS_PERSONAL_TEAM_ENTITLEMENTS;
    } else {
      ent = replaceIosAppGroupPlaceholders(ent, `group.${APP.appId}`);
    }
    fs.writeFileSync(path.join(targetAppDir, "App.entitlements"), ent, "utf8");
    if (shouldDisableIosPrivilegedCapabilities()) {
      console.log("[mobile-build] Copied minimal iOS entitlements.");
    } else {
      console.log(
        `[mobile-build] Copied iOS entitlements (app group: group.${APP.appId}).`,
      );
    }
  }

  // Patch xcconfigs to include CocoaPods settings
  for (const cfg of ["debug", "release"]) {
    const xcPath = path.join(appDir, "ios", `${cfg}.xcconfig`);
    if (fs.existsSync(xcPath)) {
      const xc = fs.readFileSync(xcPath, "utf8");
      const inc = `#include "App/Pods/Target Support Files/Pods-App/Pods-App.${cfg}.xcconfig"`;
      if (!xc.includes(inc)) {
        fs.writeFileSync(xcPath, `${inc}\n${xc}`, "utf8");
      }
    }
  }

  // Generate Podfile
  generatePodfile();
  applyIosAppIdentity();
}

export function ensureIosCapacitorPluginClass(pluginClass) {
  const configPath = path.join(
    appDir,
    "ios",
    "App",
    "App",
    "capacitor.config.json",
  );
  if (!fs.existsSync(configPath)) return;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `[mobile-build] Failed to parse iOS capacitor.config.json: ${error.message}`,
    );
  }

  const classList = Array.isArray(parsed.packageClassList)
    ? parsed.packageClassList
    : [];
  if (classList.includes(pluginClass)) return;

  parsed.packageClassList = [...classList, pluginClass];
  fs.writeFileSync(configPath, `${JSON.stringify(parsed, null, "\t")}\n`);
  console.log(`[mobile-build] Registered iOS Capacitor plugin ${pluginClass}.`);
}

export function prepareIosOverlay({ buildTarget = null } = {}) {
  const syncedFiles = syncPlatformTemplateFiles("ios");
  overlayIos();
  if (
    shouldIncludeIosFullBunEngine() ||
    process.env.ELIZA_IOS_RUNTIME_MODE === "local"
  ) {
    ensureIosCapacitorPluginClass("ElizaBunRuntimePlugin");
  }
  stripSpmIncompatiblePlugins();
  const includeLlama = shouldIncludeIosLlama();
  if (isIosSimulatorBuildTarget(buildTarget) || !includeLlama) {
    // Strip the SPM LlamaCppCapacitor entry whenever we're not bundling the
    // pod — either because the simulator build replaces it with a CocoaPod
    // (existing behavior) or because the build deliberately omits llama
    // (cloud-only / App Store thin client).
    stripSpmPlugins(IOS_COCOAPODS_OWNED_SPM_PLUGINS, {
      reason: includeLlama ? "CocoaPods-owned" : "llama excluded",
    });
  }
  return syncedFiles;
}

export function generatePodfile() {
  const podfileDir = path.join(appDir, "ios", "App");
  const iosPath = resolvePackagePath("@capacitor/ios", podfileDir);
  if (!iosPath) {
    console.warn(
      "[mobile-build] Could not resolve @capacitor/ios — skipping Podfile.",
    );
    return;
  }

  // LlamaCppCapacitor ships an on-device llama.cpp xcframework. The App Store
  // target ships the no-JIT Bun runtime by default, but still omits llama.cpp
  // unless explicitly requested because it is a separate native model backend.
  const includeLlama = shouldIncludeIosLlama();
  const appStoreBuild = isIosAppStoreBuild();
  const includeFullBunEngine = shouldIncludeIosFullBunEngine();
  const includeCompatBunRuntime =
    !includeFullBunEngine && process.env.ELIZA_IOS_RUNTIME_MODE === "local";
  const includeMobileAgentBridge =
    !appStoreBuild &&
    isTruthyEnv(process.env.ELIZA_IOS_INCLUDE_MOBILE_AGENT_BRIDGE);
  const customPods = resolveIosCustomPods({
    includeLlama,
    includeCompatBunRuntime,
    includeFullBunEngine,
    appStoreBuild,
    includeMobileAgentBridge,
  });
  if (!includeLlama) {
    console.log(
      "[mobile-build] iOS Podfile: omitting llama.cpp pod (ELIZA_IOS_INCLUDE_LLAMA not set)",
    );
  }
  if (includeCompatBunRuntime && !includeFullBunEngine) {
    console.log(
      "[mobile-build] iOS Podfile: including JSContext compatibility runtime pod",
    );
  } else if (includeFullBunEngine) {
    console.log("[mobile-build] iOS Podfile: requiring no-JIT Bun engine pod");
  }
  if (appStoreBuild) {
    console.log(
      "[mobile-build] iOS Podfile: App Store build keeps local Bun runtime and omits mobile-agent tunnel bridge",
    );
  }
  const deploymentTarget = resolveIosDeploymentTarget();
  if (includeFullBunEngine) {
    console.log(
      `[mobile-build] iOS full Bun deployment target: ${deploymentTarget}`,
    );
  }
  const useFrameworksLine = includeLlama
    ? "use_frameworks! :linkage => :static"
    : "use_frameworks!";

  const lines = [
    `  pod 'Capacitor', :path => node_package_path('@capacitor/ios')`,
    `  pod 'CapacitorCordova', :path => node_package_path('@capacitor/ios')`,
  ];

  for (const [name, pkg] of IOS_OFFICIAL_PODS) {
    const p = resolvePackagePath(pkg, podfileDir);
    if (p) lines.push(`  pod '${name}', :path => node_package_path('${pkg}')`);
  }

  for (const [name, pkg] of customPods) {
    const p = resolveNativePluginPackagePath(pkg, podfileDir);
    if (p) {
      lines.push(`  pod '${name}', :path => '${p}'`);
    }
  }

  fs.writeFileSync(
    path.join(podfileDir, "Podfile"),
    // No backslash-newline continuation here: it is the file's only
    // line-ending-sensitive token, and a CRLF checkout (Windows runners,
    // core.autocrlf) turns it into \<CR><LF>, which the Windows test lane
    // rejects at parse ("Invalid or unexpected token" importing this module).
    `def node_package_path(package_name)
  package_json = \`node --print "require.resolve('#{package_name}/package.json')"\`.strip
  if package_json.empty?
    raise "Unable to resolve #{package_name}; run bun install before pod install"
  end
  File.dirname(package_json)
end

capacitor_ios_path = node_package_path('@capacitor/ios')

require_relative File.join(capacitor_ios_path, 'scripts/pods_helpers')

platform :ios, '${deploymentTarget}'
${useFrameworksLine}

install! 'cocoapods', :disable_input_output_paths => true

def capacitor_pods
${lines.join("\n")}
end

target 'App' do
  capacitor_pods
end

post_install do |installer|
  assertDeploymentTarget(installer)
end
`,
    "utf8",
  );
  console.log("[mobile-build] Generated Podfile.");
}

// ── Phase 5: Platform patches ───────────────────────────────────────────

export function stripSpmPlugins(
  pluginNames,
  { reason = "incompatible SPM plugin" } = {},
) {
  const pkgPath = path.join(
    appDir,
    "ios",
    "App",
    "CapApp-SPM",
    "Package.swift",
  );
  if (!fs.existsSync(pkgPath)) return;

  let content = fs.readFileSync(pkgPath, "utf8");
  const lines = content.split("\n");
  const filtered = lines.filter((line) => {
    for (const name of pluginNames) {
      if (line.includes(`"${name}"`)) return false;
    }
    return true;
  });
  const changed = filtered.length !== lines.length;
  content = filtered.join("\n");

  if (changed) {
    content = content.replace(/,(\s*[\])])/g, "$1").replace(/\n{3,}/g, "\n\n");
    fs.writeFileSync(pkgPath, content, "utf8");
    console.log(
      `[mobile-build] Stripped ${reason} SPM plugins: ${Array.from(
        pluginNames,
      ).join(", ")}`,
    );
  }
}

/** Strip incompatible official plugins from SPM Package.swift. */
export function stripSpmIncompatiblePlugins() {
  stripSpmPlugins(IOS_INCOMPATIBLE_SPM_PLUGINS, {
    reason: "incompatible",
  });
}
