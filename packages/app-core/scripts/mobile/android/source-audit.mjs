/** Owns android source audit using the shared build context and existing platform contracts. */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  hasAndroidPermissionRequest,
  stripXmlComments,
  validateAndroidAppActionsXmlResource,
} from "../android-manifest.mjs";
import { walkFiles } from "../build-tools.mjs";
import {
  APP,
  androidDir,
  platformsDir,
  repoRoot,
  systemApkStaging,
} from "../context.mjs";
import { escapeRegExp } from "../escape.mjs";
import {
  ANDROID_CLOUD_SPLASH_MARK_RESOURCE,
  ANDROID_CLOUD_STRIPPED_ASSET_DIRECTORIES,
  ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS,
  ANDROID_CLOUD_STRIPPED_RESOURCE_FILES,
  ANDROID_CLOUD_STRIPPED_RESOURCE_VALUES,
  ANDROID_LP3_COLOR_POLICY_COMPONENTS,
  ANDROID_LP3_COLOR_POLICY_JAVA_FILES,
  ANDROID_LP3_COLOR_POLICY_REQUIRED_PERMISSIONS,
  ANDROID_PLAY_DATA_EXTRACTION_RULES,
  ANDROID_SMS_GATEWAY_COMPONENTS,
  ANDROID_SMS_GATEWAY_PERMISSIONS,
  ANDROID_SMS_GATEWAY_STRIPPED_COMPONENTS,
  assertAndroidLauncherManifest,
  isAndroidLp3ColorPolicyEnabled,
  isCloudBannedAsset,
  isCloudBannedNativeLibrary,
  resolveAndroidCloudAllowedNativePluginPackages,
  resolveAndroidCloudCapacitorConfigPolicy,
  resolveAndroidCloudStripPolicy,
  sanitizeAndroidCloudCapacitorConfig,
} from "./cloud-policy.mjs";
import { packageNameToPath } from "./shared-tree.mjs";

export function auditAndroidCloudSource(
  phase,
  { allowHomeRole = false, env = process.env } = {},
) {
  const failures = [];
  const lp3ColorPolicyEnabled = isAndroidLp3ColorPolicyEnabled(env);
  const stripPolicy = resolveAndroidCloudStripPolicy(env);
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (fs.existsSync(manifestPath)) {
    const xml = stripXmlComments(fs.readFileSync(manifestPath, "utf8"));
    if (xml.includes("ElizaAgentService")) {
      failures.push("AndroidManifest.xml still references ElizaAgentService");
    }
    for (const component of stripPolicy.components) {
      if (xml.includes(component)) {
        failures.push(`AndroidManifest.xml still references ${component}`);
      }
    }
    for (const perm of stripPolicy.permissions) {
      const full = `android.permission.${perm}`;
      if (hasAndroidPermissionRequest(xml, full)) {
        failures.push(`AndroidManifest.xml still requests ${full}`);
      }
    }
    for (const forbidden of [
      "android.intent.action.ASSIST",
      "android.intent.action.VOICE_COMMAND",
      "android.app.role.ASSISTANT",
      "android.permission.BIND_VOICE_INTERACTION",
    ]) {
      if (xml.includes(forbidden)) {
        failures.push(`AndroidManifest.xml still contains ${forbidden}`);
      }
    }
    if (/usesCleartextTraffic="true"/.test(xml)) {
      failures.push(
        "AndroidManifest.xml still allows global cleartext traffic",
      );
    }
    if (!/android:allowBackup="false"/.test(xml)) {
      failures.push("AndroidManifest.xml does not disable application backup");
    }
    if (
      !/android:dataExtractionRules="@xml\/data_extraction_rules"/.test(xml) ||
      !/android:fullBackupContent="false"/.test(xml)
    ) {
      failures.push(
        "AndroidManifest.xml does not disable Android 12+ cloud backup and device transfer",
      );
    }
    for (const forbidden of [
      ...(allowHomeRole ? [] : ["android.intent.category.HOME"]),
      "com.google.android.apps.healthdata",
      "android.hardware.telephony",
      "android.hardware.bluetooth_le",
    ]) {
      if (xml.includes(forbidden)) {
        failures.push(`AndroidManifest.xml still contains ${forbidden}`);
      }
    }
    if (!xml.includes('android:name="android.app.shortcuts"')) {
      failures.push("AndroidManifest.xml does not register @xml/shortcuts");
    }
  }

  const lp3DebugRoot = path.join(
    platformsDir,
    "android",
    "lp3-color-policy",
    "src",
    "debug",
  );
  if (lp3ColorPolicyEnabled) {
    const lp3ManifestPath = path.join(lp3DebugRoot, "AndroidManifest.xml");
    if (!fs.existsSync(lp3ManifestPath)) {
      failures.push("LP3 direct-debug manifest overlay is missing");
    } else {
      const lp3Manifest = stripXmlComments(
        fs.readFileSync(lp3ManifestPath, "utf8"),
      );
      for (const component of ANDROID_LP3_COLOR_POLICY_COMPONENTS) {
        if (!lp3Manifest.includes(component)) {
          failures.push(
            `LP3 direct-debug manifest is missing component ${component}`,
          );
        }
      }
      for (const permission of ANDROID_LP3_COLOR_POLICY_REQUIRED_PERMISSIONS) {
        const full = `android.permission.${permission}`;
        if (!hasAndroidPermissionRequest(lp3Manifest, full)) {
          failures.push(
            `LP3 direct-debug manifest is missing permission ${full}`,
          );
        }
      }
      if (!lp3Manifest.includes('android:screenOrientation="portrait"')) {
        failures.push(
          "LP3 direct-debug manifest does not lock MainActivity to portrait",
        );
      }
    }
    const lp3JavaRoot = path.join(lp3DebugRoot, "java", "ai", "elizaos", "app");
    for (const file of ANDROID_LP3_COLOR_POLICY_JAVA_FILES) {
      if (!fs.existsSync(path.join(lp3JavaRoot, file))) {
        failures.push(`LP3 direct-debug Java source is missing: ${file}`);
      }
    }
  }

  const shortcutsPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "res",
    "xml",
    "shortcuts.xml",
  );
  if (!fs.existsSync(shortcutsPath)) {
    failures.push("app/src/main/res/xml/shortcuts.xml is missing");
  } else {
    const shortcuts = fs.readFileSync(shortcutsPath, "utf8");
    failures.push(
      ...validateAndroidAppActionsXmlResource(shortcuts, {
        androidPackage: APP.appId,
        urlScheme: APP.urlScheme,
      }),
    );
  }

  const resRoot = path.join(androidDir, "app", "src", "main", "res");
  const cloudSplashStylesPath = path.join(resRoot, "values", "styles.xml");
  const cloudSplashMarkPath = path.join(
    resRoot,
    "drawable-nodpi",
    `${ANDROID_CLOUD_SPLASH_MARK_RESOURCE}.png`,
  );
  if (!fs.existsSync(cloudSplashStylesPath)) {
    failures.push("app/src/main/res/values/styles.xml is missing");
  } else {
    const styles = fs.readFileSync(cloudSplashStylesPath, "utf8");
    if (
      !styles.includes(
        `<item name="windowSplashScreenAnimatedIcon">@drawable/${ANDROID_CLOUD_SPLASH_MARK_RESOURCE}</item>`,
      )
    ) {
      failures.push(
        "AppTheme.NoActionBarLaunch does not use the transparent Cloud splash mark",
      );
    }
    if (
      !styles.includes(
        '<item name="windowSplashScreenBackground">@color/splash_background</item>',
      )
    ) {
      failures.push(
        "AppTheme.NoActionBarLaunch does not use splash_background",
      );
    }
  }
  if (!fs.existsSync(cloudSplashMarkPath)) {
    failures.push(
      `app/src/main/res/drawable-nodpi/${ANDROID_CLOUD_SPLASH_MARK_RESOURCE}.png is missing`,
    );
  }
  const dataExtractionRulesPath = path.join(
    resRoot,
    "xml",
    "data_extraction_rules.xml",
  );
  if (
    !fs.existsSync(dataExtractionRulesPath) ||
    fs.readFileSync(dataExtractionRulesPath, "utf8") !==
      ANDROID_PLAY_DATA_EXTRACTION_RULES
  ) {
    failures.push(
      "app/src/main/res/xml/data_extraction_rules.xml is missing or differs from the Play no-backup policy",
    );
  }
  for (const relPath of ANDROID_CLOUD_STRIPPED_RESOURCE_FILES) {
    if (fs.existsSync(path.join(resRoot, relPath))) {
      failures.push(`app/src/main/res/${relPath} still exists`);
    }
  }
  for (const [relPath, names] of Object.entries(
    ANDROID_CLOUD_STRIPPED_RESOURCE_VALUES,
  )) {
    const target = path.join(resRoot, relPath);
    if (!fs.existsSync(target)) continue;
    const xml = fs.readFileSync(target, "utf8");
    for (const name of names) {
      if (
        new RegExp(`<string\\s+name=["']${escapeRegExp(name)}["']`).test(xml)
      ) {
        failures.push(`app/src/main/res/${relPath} still defines ${name}`);
      }
    }
  }

  const javaRoot = path.join(androidDir, "app", "src", "main", "java");
  const forbiddenJavaFiles = new Set(stripPolicy.javaFiles);
  walkFiles(javaRoot, (filePath) => {
    const base = path.basename(filePath);
    if (forbiddenJavaFiles.has(base)) {
      failures.push(path.relative(androidDir, filePath));
      return;
    }
    if (base === "ElizaAgentService.java") {
      failures.push(path.relative(androidDir, filePath));
      return;
    }
    if (!base.endsWith(".java")) return;
    const source = fs.readFileSync(filePath, "utf8");
    if (source.includes("ElizaAgentService")) {
      failures.push(
        `${path.relative(androidDir, filePath)} still references ElizaAgentService`,
      );
    }
    if (source.includes("new ElizaNativeBridge(")) {
      failures.push(
        `${path.relative(androidDir, filePath)} still installs ElizaNativeBridge`,
      );
    }
  });

  const assetsRoot = path.join(androidDir, "app", "src", "main", "assets");
  for (const directory of ANDROID_CLOUD_STRIPPED_ASSET_DIRECTORIES) {
    if (fs.existsSync(path.join(assetsRoot, directory))) {
      failures.push(`app/src/main/assets/${directory} still exists`);
    }
  }
  walkFiles(assetsRoot, (filePath) => {
    if (isCloudBannedAsset(filePath)) {
      failures.push(path.relative(androidDir, filePath));
    }
  });

  const jniRoot = path.join(androidDir, "app", "src", "main", "jniLibs");
  walkFiles(jniRoot, (filePath) => {
    if (isCloudBannedNativeLibrary(path.basename(filePath))) {
      failures.push(path.relative(androidDir, filePath));
    }
  });

  for (const relPath of [
    "capacitor.settings.gradle",
    path.join("app", "capacitor.build.gradle"),
    path.join("app", "src", "main", "assets", "capacitor.plugins.json"),
  ]) {
    const filePath = path.join(androidDir, relPath);
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    for (const [pkg, gradleProject] of ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS) {
      if (source.includes(pkg) || source.includes(gradleProject)) {
        failures.push(`${relPath} still references ${pkg}/${gradleProject}`);
      }
    }
  }

  const capacitorPluginManifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "assets",
    "capacitor.plugins.json",
  );
  if (!fs.existsSync(capacitorPluginManifestPath)) {
    failures.push("app/src/main/assets/capacitor.plugins.json is missing");
  } else {
    try {
      const plugins = JSON.parse(
        fs.readFileSync(capacitorPluginManifestPath, "utf8"),
      );
      const actualPackages = Array.isArray(plugins)
        ? plugins
            .map((plugin) => plugin?.pkg)
            .filter(Boolean)
            .sort()
        : [];
      const allowedPackages =
        resolveAndroidCloudAllowedNativePluginPackages(env).sort();
      if (JSON.stringify(actualPackages) !== JSON.stringify(allowedPackages)) {
        failures.push(
          `capacitor.plugins.json packages differ from the Play allowlist: ${JSON.stringify(actualPackages)}`,
        );
      }
    } catch (error) {
      failures.push(
        `capacitor.plugins.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const capacitorConfigPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "assets",
    "capacitor.config.json",
  );
  if (!fs.existsSync(capacitorConfigPath)) {
    failures.push("app/src/main/assets/capacitor.config.json is missing");
  } else {
    try {
      const config = JSON.parse(fs.readFileSync(capacitorConfigPath, "utf8"));
      const expected = sanitizeAndroidCloudCapacitorConfig(
        config,
        resolveAndroidCloudCapacitorConfigPolicy(env),
      );
      if (JSON.stringify(config) !== JSON.stringify(expected)) {
        failures.push(
          "capacitor.config.json differs from the restricted Play runtime contract",
        );
      }
    } catch (error) {
      failures.push(
        `capacitor.config.json is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `[mobile-build] android-cloud ${phase} audit failed:\n` +
        failures.map((failure) => `  - ${failure}`).join("\n"),
    );
  }
  console.log(`[mobile-build] android-cloud ${phase} audit passed.`);
}

export function auditAndroidLauncherSource(phase, options = {}) {
  auditAndroidCloudSource(phase, { ...options, allowHomeRole: true });
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  const manifest = fs.existsSync(manifestPath)
    ? fs.readFileSync(manifestPath, "utf8")
    : "";
  assertAndroidLauncherManifest(manifest, {
    label: `android-launcher ${phase} source`,
  });
  const mainActivityPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    packageNameToPath(APP.appId),
    "MainActivity.java",
  );
  const mainActivity = fs.existsSync(mainActivityPath)
    ? fs.readFileSync(mainActivityPath, "utf8")
    : "";
  if (
    !mainActivity.includes("isCloudAuthCallback(Intent intent)") ||
    !mainActivity.includes('"elizaos".equalsIgnoreCase(data.getScheme())') ||
    !mainActivity.includes('"auth".equalsIgnoreCase(data.getHost())') ||
    !mainActivity.includes('"/callback".equals(data.getPath())') ||
    !mainActivity.includes("getBridge().getLocalUrl()") ||
    !mainActivity.includes("webView.loadUrl(localUrl)")
  ) {
    throw new Error(
      `[mobile-build] android-launcher ${phase} source audit failed: MainActivity does not restore the bundled renderer after the exact in-app auth callback.`,
    );
  }
  console.log(`[mobile-build] android-launcher ${phase} audit passed.`);
}

export function auditAndroidSmsGatewaySource(phase) {
  const failures = [];
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  failures.push(...auditAndroidSmsGatewayManifest(manifestPath));
  failures.push(...missingAndroidSmsGatewayJavaFiles());
  failures.push(...androidCloudNativePluginReferenceFailures());

  if (failures.length > 0) {
    throw new Error(
      `[mobile-build] android-sms-gateway ${phase} audit failed:\n` +
        failures.map((failure) => `  - ${failure}`).join("\n"),
    );
  }
  console.log(`[mobile-build] android-sms-gateway ${phase} audit passed.`);
}

export function auditAndroidSmsGatewayManifest(manifestPath) {
  const failures = [];
  if (!fs.existsSync(manifestPath)) {
    failures.push("AndroidManifest.xml is missing");
    return failures;
  }
  const xml = stripXmlComments(fs.readFileSync(manifestPath, "utf8"));
  for (const component of ANDROID_SMS_GATEWAY_COMPONENTS) {
    if (!xml.includes(component)) {
      failures.push(`AndroidManifest.xml is missing ${component}`);
    }
  }
  for (const perm of ANDROID_SMS_GATEWAY_PERMISSIONS) {
    const full = `android.permission.${perm}`;
    if (!xml.includes(full)) {
      failures.push(`AndroidManifest.xml is missing ${full}`);
    }
  }
  for (const component of ANDROID_SMS_GATEWAY_STRIPPED_COMPONENTS) {
    if (xml.includes(component)) {
      failures.push(`AndroidManifest.xml still references ${component}`);
    }
  }
  if (/usesCleartextTraffic="true"/.test(xml)) {
    failures.push("AndroidManifest.xml still allows global cleartext traffic");
  }
  return failures;
}

export function missingAndroidSmsGatewayJavaFiles() {
  const missing = [];
  const javaRoot = path.join(androidDir, "app", "src", "main", "java");
  for (const file of ["ElizaSmsGatewayService.java", "ElizaSmsReceiver.java"]) {
    let found = false;
    walkFiles(javaRoot, (filePath) => {
      if (path.basename(filePath) === file) found = true;
    });
    if (!found) missing.push(`app/src/main/java is missing ${file}`);
  }
  return missing;
}

export function androidCloudNativePluginReferenceFailures() {
  const failures = [];
  for (const relPath of [
    "capacitor.settings.gradle",
    path.join("app", "capacitor.build.gradle"),
    path.join("app", "src", "main", "assets", "capacitor.plugins.json"),
  ]) {
    const filePath = path.join(androidDir, relPath);
    if (!fs.existsSync(filePath)) continue;
    const source = fs.readFileSync(filePath, "utf8");
    for (const [pkg, gradleProject] of ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS) {
      if (source.includes(pkg) || source.includes(gradleProject)) {
        failures.push(`${relPath} still references ${pkg}/${gradleProject}`);
      }
    }
  }
  return failures;
}

export function auditAndroidSystemSource(
  phase,
  { requireCapabilityManifest = true } = {},
) {
  const failures = [];
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (!fs.existsSync(manifestPath)) {
    failures.push("AndroidManifest.xml is missing");
  } else {
    const xml = fs.readFileSync(manifestPath, "utf8");
    for (const marker of [
      "ElizaAssistActivity",
      "android.intent.action.ASSIST",
      "android.intent.action.VOICE_COMMAND",
      "ElizaVoiceInteractionService",
      "ElizaVoiceInteractionSessionService",
      "ElizaRecognitionService",
      "android.permission.BIND_VOICE_INTERACTION",
      "android.service.voice.VoiceInteractionService",
      "@xml/eliza_voice_interaction_service",
      "android.speech.RecognitionService",
      "android.speech",
      "@xml/eliza_recognition_service",
      "ElizaVoiceInputMethodService",
      "android.permission.BIND_INPUT_METHOD",
      "android.view.InputMethod",
      "@xml/method",
      "ElizaAccessibilityService",
      "android.permission.BIND_ACCESSIBILITY_SERVICE",
      "android.accessibilityservice.AccessibilityService",
      "@xml/eliza_accessibility_service",
      "ElizaNotificationListenerService",
      "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE",
      "android.service.notification.NotificationListenerService",
      "ElizaAgentService",
      "ElizaBootReceiver",
      'android:directBootAware="true"',
      "ElizaVoiceCaptureService",
      "android.permission.PACKAGE_USAGE_STATS",
      "android.permission.MANAGE_APP_OPS_MODES",
      "android.permission.MANAGE_VIRTUAL_MACHINE",
      "android.permission.READ_FRAME_BUFFER",
      "android.permission.INJECT_EVENTS",
      "android.permission.REAL_GET_TASKS",
      "android.permission.FOREGROUND_SERVICE_MEDIA_PROJECTION",
      "android.permission.FOREGROUND_SERVICE_SPECIAL_USE",
      "android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE",
    ]) {
      if (!xml.includes(marker)) {
        failures.push(`AndroidManifest.xml is missing ${marker}`);
      }
    }
  }

  const capabilityManifestPath = path.join(
    systemApkStaging.vendorDir,
    "manifests",
    "aosp-assistant-full-control.json",
  );
  if (requireCapabilityManifest && !fs.existsSync(capabilityManifestPath)) {
    failures.push(
      `${path.relative(repoRoot, capabilityManifestPath)} is missing`,
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `[mobile-build] android-system ${phase} audit failed:\n` +
        failures.map((failure) => `  - ${failure}`).join("\n"),
    );
  }
  console.log(`[mobile-build] android-system ${phase} audit passed.`);
}
