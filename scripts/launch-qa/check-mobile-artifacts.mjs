#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(here, "../..");

const REQUIRED_IOS_PODS = [
  "Capacitor",
  "CapacitorCordova",
  "CapacitorApp",
  "CapacitorPreferences",
  "CapacitorKeyboard",
  "CapacitorBrowser",
  "ElizaosCapacitorAgent",
  "ElizaosCapacitorGateway",
  "ElizaosCapacitorMobileSignals",
  "ElizaosCapacitorWebsiteblocker",
];

const REQUIRED_INFO_PLIST_KEYS = [
  "CFBundleDisplayName",
  "CFBundleIdentifier",
  "CFBundleName",
  "CFBundleShortVersionString",
  "CFBundleVersion",
  "LSRequiresIPhoneOS",
  "NSCameraUsageDescription",
  "NSLocalNetworkUsageDescription",
  "NSLocationWhenInUseUsageDescription",
  "NSMicrophoneUsageDescription",
];

const REQUIRED_ANDROID_PERMISSIONS = [
  "android.permission.INTERNET",
  "android.permission.RECORD_AUDIO",
  "android.permission.CAMERA",
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.POST_NOTIFICATIONS",
];

const REQUIRED_ANDROID_PLUGINS = [
  "@capacitor/app",
  "@capacitor/keyboard",
  "@capacitor/preferences",
  "@elizaos/capacitor-agent",
  "@elizaos/capacitor-gateway",
  "@elizaos/capacitor-mobile-signals",
  "@elizaos/capacitor-system",
  "@elizaos/capacitor-websiteblocker",
];

const REQUIRED_ANDROID_ASSETS = [
  "packages/app-core/platforms/android/app/src/main/assets/capacitor.config.json",
  "packages/app-core/platforms/android/app/src/main/assets/capacitor.plugins.json",
  "packages/app-core/platforms/android/app/src/main/assets/public/index.html",
  "packages/app-core/platforms/android/app/src/main/assets/agent/agent-bundle.js",
  "packages/app-core/platforms/android/app/src/main/assets/agent/launch.sh",
  "packages/app-core/platforms/android/app/src/main/assets/agent/arm64-v8a/bun",
  "packages/app-core/platforms/android/app/src/main/assets/agent/x86_64/bun",
];

function rel(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/") || ".";
}

function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function addError(errors, error) {
  errors.push({
    severity: "error",
    ...error,
  });
}

function extractStringAssignment(source, key) {
  const match = source.match(
    new RegExp(`${key}\\s*:\\s*["']([^"']+)["']`, "m"),
  );
  return match?.[1] ?? null;
}

function extractAppConfig(repoRoot) {
  const filePath = path.join(repoRoot, "packages/app/app.config.ts");
  const source = readText(filePath);
  if (!source) {
    return { file: rel(repoRoot, filePath), appId: null, appName: null };
  }
  return {
    file: rel(repoRoot, filePath),
    appId: extractStringAssignment(source, "appId"),
    appName: extractStringAssignment(source, "appName"),
  };
}

function extractCapacitorConfig(repoRoot) {
  const sourcePath = path.join(repoRoot, "packages/app/capacitor.config.ts");
  const assetPath = path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/assets/capacitor.config.json",
  );
  const source = readText(sourcePath);
  const assetConfig = readJson(assetPath);
  return {
    sourceFile: rel(repoRoot, sourcePath),
    assetFile: rel(repoRoot, assetPath),
    sourceAppId: source?.includes("appId: appConfig.appId")
      ? "appConfig.appId"
      : extractStringAssignment(source ?? "", "appId"),
    sourceAppName: source?.includes("appName: appConfig.appName")
      ? "appConfig.appName"
      : extractStringAssignment(source ?? "", "appName"),
    assetAppId: assetConfig?.appId ?? null,
    assetAppName: assetConfig?.appName ?? null,
  };
}

function packageScripts(repoRoot, packagePath) {
  const filePath = path.join(repoRoot, packagePath);
  const packageJson = readJson(filePath);
  return {
    file: rel(repoRoot, filePath),
    scripts: packageJson?.scripts ?? null,
  };
}

function checkAndroidSystemScripts(repoRoot, errors, checks) {
  for (const packagePath of ["package.json", "packages/app/package.json"]) {
    const { file, scripts } = packageScripts(repoRoot, packagePath);
    const script = scripts?.["build:android:system"];
    const ok =
      typeof script === "string" &&
      script.includes("run-mobile-build.mjs") &&
      script.includes("android-system");
    checks.push({
      id: `scripts:${file}:build:android:system`,
      ok,
      file,
      script: script ?? null,
    });
    if (!ok) {
      addError(errors, {
        type: "missing-script",
        file,
        script: "build:android:system",
        message:
          'missing or invalid "build:android:system" script; expected run-mobile-build.mjs android-system',
      });
    }
  }
}

function podNames(podfile) {
  return new Set(
    [...podfile.matchAll(/pod\s+['"]([^'"]+)['"]/g)].map((match) => match[1]),
  );
}

function checkPodfile(repoRoot, relativePath, errors, checks) {
  const filePath = path.join(repoRoot, relativePath);
  const content = readText(filePath);
  if (!content) {
    checks.push({
      id: `ios-podfile:${relativePath}`,
      ok: false,
      file: relativePath,
    });
    addError(errors, {
      type: "missing-file",
      file: relativePath,
      message: "missing iOS Podfile",
    });
    return;
  }

  const pods = podNames(content);
  const missing = REQUIRED_IOS_PODS.filter((pod) => !pods.has(pod));
  const ok =
    missing.length === 0 &&
    content.includes("platform :ios") &&
    content.includes("use_frameworks!");
  checks.push({
    id: `ios-podfile:${relativePath}`,
    ok,
    file: relativePath,
    podCount: pods.size,
    missing,
  });
  if (missing.length > 0) {
    addError(errors, {
      type: "missing-ios-pod",
      file: relativePath,
      missing,
      message: `missing required iOS pod(s): ${missing.join(", ")}`,
    });
  }
  if (
    !content.includes("platform :ios") ||
    !content.includes("use_frameworks!")
  ) {
    addError(errors, {
      type: "invalid-ios-podfile",
      file: relativePath,
      message: "Podfile must declare an iOS platform and use_frameworks!",
    });
  }
}

function plistHasKey(content, key) {
  return new RegExp(`<key>\\s*${key}\\s*</key>`).test(content);
}

function plistArrayValues(content, key) {
  const match = content.match(
    new RegExp(`<key>\\s*${key}\\s*</key>\\s*<array>([\\s\\S]*?)</array>`),
  );
  if (!match) {
    return [];
  }
  return [...match[1].matchAll(/<string>\s*([^<]+)\s*<\/string>/g)].map(
    (item) => item[1].trim(),
  );
}

function expectedIosAppGroups(appId, relativePath) {
  const groups = [];
  if (appId) {
    groups.push(`group.${appId}`);
  }
  if (relativePath.startsWith("packages/app-core/platforms/ios/")) {
    groups.push("group.ai.elizaos.app");
  }
  return [...new Set(groups)];
}

function checkInfoPlist(repoRoot, relativePath, errors, checks) {
  const filePath = path.join(repoRoot, relativePath);
  const content = readText(filePath);
  if (!content) {
    checks.push({
      id: `ios-info-plist:${relativePath}`,
      ok: false,
      file: relativePath,
    });
    addError(errors, {
      type: "missing-file",
      file: relativePath,
      message: "missing iOS Info.plist",
    });
    return;
  }

  const missing = REQUIRED_INFO_PLIST_KEYS.filter(
    (key) => !plistHasKey(content, key),
  );
  const ok = missing.length === 0;
  checks.push({
    id: `ios-info-plist:${relativePath}`,
    ok,
    file: relativePath,
    missing,
  });
  if (missing.length > 0) {
    addError(errors, {
      type: "missing-ios-plist-key",
      file: relativePath,
      missing,
      message: `missing required Info.plist key(s): ${missing.join(", ")}`,
    });
  }
}

function checkEntitlements(repoRoot, relativePath, appId, errors, checks) {
  const filePath = path.join(repoRoot, relativePath);
  const content = readText(filePath);
  if (!content) {
    checks.push({
      id: `ios-entitlements:${relativePath}`,
      ok: true,
      file: relativePath,
      skipped: true,
    });
    return;
  }

  const groups = plistArrayValues(
    content,
    "com.apple.security.application-groups",
  );
  const expectedGroups = expectedIosAppGroups(appId, relativePath);
  const ok =
    groups.length > 0 &&
    (expectedGroups.length === 0 ||
      expectedGroups.some((group) => groups.includes(group)));
  checks.push({
    id: `ios-entitlements:${relativePath}`,
    ok,
    file: relativePath,
    groups,
    expectedGroups,
  });
  if (!ok) {
    addError(errors, {
      type: "invalid-ios-app-group",
      file: relativePath,
      expected: expectedGroups,
      found: groups,
      message:
        expectedGroups.length > 0
          ? `missing expected iOS app group ${expectedGroups.join(" or ")}`
          : "missing iOS app group entitlement",
    });
  }
}

function extractXmlAttributes(content, tagName) {
  const match = content.match(new RegExp(`<${tagName}\\b([\\s\\S]*?)(?:>|/>)`));
  return match?.[1] ?? "";
}

function attrValue(attributes, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attributes.match(
    new RegExp(`${escaped}\\s*=\\s*["']([^"']+)["']`),
  );
  return match?.[1] ?? null;
}

function androidPermissions(manifest) {
  return new Set(
    [
      ...manifest.matchAll(
        /<uses-permission\b[^>]*android:name=["']([^"']+)["']/g,
      ),
    ].map((match) => match[1]),
  );
}

function checkAndroidManifest(repoRoot, appId, errors, checks) {
  const relativePath =
    "packages/app-core/platforms/android/app/src/main/AndroidManifest.xml";
  const filePath = path.join(repoRoot, relativePath);
  const content = readText(filePath);
  if (!content) {
    checks.push({ id: "android-manifest", ok: false, file: relativePath });
    addError(errors, {
      type: "missing-file",
      file: relativePath,
      message: "missing AndroidManifest.xml",
    });
    return;
  }

  const applicationAttrs = extractXmlAttributes(content, "application");
  const activityAttrs = extractXmlAttributes(content, "activity");
  const permissions = androidPermissions(content);
  const missingPermissions = REQUIRED_ANDROID_PERMISSIONS.filter(
    (permission) => !permissions.has(permission),
  );
  const hasLauncher =
    content.includes("android.intent.action.MAIN") &&
    content.includes("android.intent.category.LAUNCHER");
  const hasMainActivity =
    attrValue(activityAttrs, "android:name") === ".MainActivity";
  const hasService = (serviceName) =>
    content.includes(`android:name=".${serviceName}"`) ||
    content.includes(`android:name="${appId}.${serviceName}"`);
  const hasServices =
    hasService("GatewayConnectionService") && hasService("ElizaAgentService");
  const ok =
    missingPermissions.length === 0 &&
    attrValue(applicationAttrs, "android:label") === "@string/app_name" &&
    attrValue(activityAttrs, "android:exported") === "true" &&
    hasMainActivity &&
    hasLauncher &&
    hasServices;
  checks.push({
    id: "android-manifest",
    ok,
    file: relativePath,
    appId,
    missingPermissions,
    hasLauncher,
    hasServices,
  });
  if (missingPermissions.length > 0) {
    addError(errors, {
      type: "missing-android-permission",
      file: relativePath,
      missing: missingPermissions,
      message: `missing required Android permission(s): ${missingPermissions.join(", ")}`,
    });
  }
  if (
    !hasMainActivity ||
    !hasLauncher ||
    attrValue(activityAttrs, "android:exported") !== "true"
  ) {
    addError(errors, {
      type: "invalid-android-launcher",
      file: relativePath,
      message:
        "Android manifest must expose .MainActivity with MAIN/LAUNCHER intent",
    });
  }
  if (!hasServices) {
    addError(errors, {
      type: "missing-android-service",
      file: relativePath,
      message:
        "Android manifest must declare GatewayConnectionService and ElizaAgentService",
    });
  }
}

function extractGradleString(content, key) {
  const match = content.match(new RegExp(`\\b${key}\\s+["']([^"']+)["']`));
  return match?.[1] ?? null;
}

function checkAndroidIdentity(repoRoot, appConfig, errors, checks) {
  const relativePath = "packages/app-core/platforms/android/app/build.gradle";
  const content = readText(path.join(repoRoot, relativePath));
  if (!content) {
    checks.push({ id: "android-identity", ok: false, file: relativePath });
    addError(errors, {
      type: "missing-file",
      file: relativePath,
      message: "missing Android app build.gradle",
    });
    return;
  }
  const namespace = extractGradleString(content, "namespace");
  const applicationId = extractGradleString(content, "applicationId");
  const ok =
    Boolean(appConfig.appId) &&
    namespace === appConfig.appId &&
    applicationId === appConfig.appId;
  checks.push({
    id: "android-identity",
    ok,
    file: relativePath,
    appId: appConfig.appId,
    namespace,
    applicationId,
  });
  if (!ok) {
    addError(errors, {
      type: "android-identity-mismatch",
      file: relativePath,
      expected: appConfig.appId,
      namespace,
      applicationId,
      message:
        "Android namespace/applicationId must match packages/app/app.config.ts appId",
    });
  }
}

function checkAndroidPluginAssets(
  repoRoot,
  appConfig,
  capacitorConfig,
  errors,
  checks,
) {
  const configOk =
    capacitorConfig.assetAppId === appConfig.appId &&
    capacitorConfig.assetAppName === appConfig.appName;
  checks.push({
    id: "android-capacitor-config-asset",
    ok: configOk,
    file: capacitorConfig.assetFile,
    expectedAppId: appConfig.appId,
    expectedAppName: appConfig.appName,
    appId: capacitorConfig.assetAppId,
    appName: capacitorConfig.assetAppName,
  });
  if (!configOk) {
    addError(errors, {
      type: "android-capacitor-config-mismatch",
      file: capacitorConfig.assetFile,
      message:
        "Android capacitor.config.json must match app.config.ts identity",
    });
  }

  const pluginsPath = path.join(
    repoRoot,
    "packages/app-core/platforms/android/app/src/main/assets/capacitor.plugins.json",
  );
  const plugins = readJson(pluginsPath);
  const pluginNames = new Set(
    Array.isArray(plugins)
      ? plugins.map((plugin) => plugin?.pkg).filter(Boolean)
      : [],
  );
  const missingPlugins = REQUIRED_ANDROID_PLUGINS.filter(
    (plugin) => !pluginNames.has(plugin),
  );
  const pluginsOk = Array.isArray(plugins) && missingPlugins.length === 0;
  checks.push({
    id: "android-capacitor-plugin-asset",
    ok: pluginsOk,
    file: rel(repoRoot, pluginsPath),
    pluginCount: pluginNames.size,
    missing: missingPlugins,
  });
  if (!pluginsOk) {
    addError(errors, {
      type: "missing-android-plugin",
      file: rel(repoRoot, pluginsPath),
      missing: missingPlugins,
      message: `missing required Android Capacitor plugin(s): ${missingPlugins.join(", ")}`,
    });
  }
}

function addSkippedGeneratedChecks(checks) {
  for (const id of [
    "ios-podfile:packages/app/ios/App/Podfile",
    "ios-info-plist:packages/app/ios/App/App/Info.plist",
    "ios-entitlements:packages/app/ios/App/App/App.entitlements",
    "android-manifest",
    "android-identity",
    "android-capacitor-config-asset",
    "android-capacitor-plugin-asset",
    "android-asset",
  ]) {
    checks.push({
      id,
      ok: true,
      skipped: true,
      reason: "generated mobile project artifacts are not committed",
    });
  }
}

function checkRequiredFiles(repoRoot, relativePaths, errors, checks, idPrefix) {
  const missing = [];
  for (const relativePath of relativePaths) {
    if (!exists(path.join(repoRoot, relativePath))) {
      missing.push(relativePath);
    }
  }
  checks.push({
    id: idPrefix,
    ok: missing.length === 0,
    checked: relativePaths.length,
    missing,
  });
  for (const file of missing) {
    addError(errors, {
      type: "missing-file",
      file,
      message: `missing required ${idPrefix} file`,
    });
  }
}

function checkIdentity(appConfig, capacitorConfig, errors, checks) {
  const sourceOk =
    Boolean(appConfig.appId) &&
    Boolean(appConfig.appName) &&
    capacitorConfig.sourceAppId === "appConfig.appId" &&
    capacitorConfig.sourceAppName === "appConfig.appName";
  checks.push({
    id: "capacitor-source-identity",
    ok: sourceOk,
    appConfigFile: appConfig.file,
    capacitorConfigFile: capacitorConfig.sourceFile,
    appId: appConfig.appId,
    appName: appConfig.appName,
  });
  if (!sourceOk) {
    addError(errors, {
      type: "capacitor-identity-mismatch",
      file: capacitorConfig.sourceFile,
      message:
        "Capacitor source config must use app.config.ts appId/appName and app.config.ts must expose concrete identity",
    });
  }
}

export function checkMobileArtifacts(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? defaultRepoRoot);
  const allowMissingGenerated = Boolean(options.allowMissingGenerated);
  const errors = [];
  const checks = [];
  const appConfig = extractAppConfig(repoRoot);
  const capacitorConfig = extractCapacitorConfig(repoRoot);

  checkIdentity(appConfig, capacitorConfig, errors, checks);
  checkAndroidSystemScripts(repoRoot, errors, checks);

  if (allowMissingGenerated) {
    addSkippedGeneratedChecks(checks);
  } else {
    checkPodfile(repoRoot, "packages/app/ios/App/Podfile", errors, checks);
  }
  checkPodfile(
    repoRoot,
    "packages/app-core/platforms/ios/App/Podfile",
    errors,
    checks,
  );

  if (!allowMissingGenerated) {
    checkInfoPlist(
      repoRoot,
      "packages/app/ios/App/App/Info.plist",
      errors,
      checks,
    );
  }
  checkInfoPlist(
    repoRoot,
    "packages/app-core/platforms/ios/App/App/Info.plist",
    errors,
    checks,
  );

  if (!allowMissingGenerated) {
    checkEntitlements(
      repoRoot,
      "packages/app/ios/App/App/App.entitlements",
      appConfig.appId,
      errors,
      checks,
    );
  }
  checkEntitlements(
    repoRoot,
    "packages/app-core/platforms/ios/App/App/App.entitlements",
    appConfig.appId,
    errors,
    checks,
  );

  if (!allowMissingGenerated) {
    checkAndroidManifest(repoRoot, appConfig.appId, errors, checks);
    checkAndroidIdentity(repoRoot, appConfig, errors, checks);

    // The next two blocks validate Android *built artifacts* (capacitor sync
    // output + bundled JS/binaries). They only exist after `bunx cap sync` +
    // `build:mobile` have run. The Launch Docs static-gates workflow runs
    // before any mobile build, so these checks would always fail there.
    // Skip when the assets dir is empty — i.e. no build has run.
    const androidAssetsDir = path.join(
      repoRoot,
      "packages/app-core/platforms/android/app/src/main/assets",
    );
    const hasBuiltAndroidAssets =
      exists(path.join(androidAssetsDir, "capacitor.config.json")) ||
      exists(path.join(androidAssetsDir, "capacitor.plugins.json"));
    if (hasBuiltAndroidAssets) {
      checkAndroidPluginAssets(
        repoRoot,
        appConfig,
        capacitorConfig,
        errors,
        checks,
      );
      checkRequiredFiles(
        repoRoot,
        REQUIRED_ANDROID_ASSETS,
        errors,
        checks,
        "android-asset",
      );
    } else {
      checks.push({
        id: "android-capacitor-built-assets",
        ok: true,
        skipped: true,
        reason: "no Android build present (capacitor sync not run)",
      });
    }
  }

  return {
    ok: errors.length === 0,
    repoRoot,
    checkedAt: new Date().toISOString(),
    summary: {
      checkCount: checks.length,
      errorCount: errors.length,
      iosPodfiles: allowMissingGenerated ? 1 : 2,
      iosInfoPlists: allowMissingGenerated ? 1 : 2,
      androidAssets: allowMissingGenerated ? 0 : REQUIRED_ANDROID_ASSETS.length,
      generatedArtifactsRequired: !allowMissingGenerated,
      nativeBuildsRun: false,
    },
    app: {
      appId: appConfig.appId,
      appName: appConfig.appName,
    },
    checks,
    errors,
  };
}

function printHuman(result) {
  if (result.ok) {
    console.log(
      `[mobile-artifacts-gate] PASS ${result.summary.checkCount} static check(s); nativeBuildsRun=false`,
    );
    console.log(
      `[mobile-artifacts-gate] app=${result.app.appName ?? "unknown"} id=${result.app.appId ?? "unknown"}`,
    );
    return;
  }

  console.error(
    `[mobile-artifacts-gate] FAIL ${result.summary.errorCount} issue(s) across ${result.summary.checkCount} static check(s); nativeBuildsRun=false`,
  );
  for (const error of result.errors) {
    console.error(`- ${error.file ?? "repo"} ${error.message}`);
  }
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    allowMissingGenerated: argv.includes("--allow-missing-generated"),
    repoRoot:
      argv
        .find((arg) => arg.startsWith("--repo-root="))
        ?.slice("--repo-root=".length) ??
      process.env.MOBILE_ARTIFACTS_GATE_REPO_ROOT,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = checkMobileArtifacts({
    repoRoot: args.repoRoot,
    allowMissingGenerated: args.allowMissingGenerated,
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  process.exit(result.ok ? 0 : 1);
}
