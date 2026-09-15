/** Owns android strip using the shared build context and existing platform contracts. */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  applyAndroidCleartextPolicy,
  ensureAndroidPermissionRemovalMarkers,
  ensureManifestApplicationClosedBeforeTopLevelEntries,
  removeAndroidPermissionRequests,
  removeApplicationComponentBlock,
  removeApplicationComponentClassBlock,
  removeXmlCommentsContaining,
} from "../android-manifest.mjs";
import { rmRecursive, walkFiles } from "../build-tools.mjs";
import { APP, androidDir } from "../context.mjs";
import { escapeRegExp } from "../escape.mjs";
import {
  ANDROID_CLOUD_MANIFEST_MERGER_REMOVED_PERMISSIONS,
  ANDROID_CLOUD_STRIPPED_ASSET_DIRECTORIES,
  ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS,
  ANDROID_CLOUD_STRIPPED_RESOURCE_FILES,
  ANDROID_CLOUD_STRIPPED_RESOURCE_VALUES,
  ANDROID_PLAY_DATA_EXTRACTION_RULES,
  ANDROID_SMS_GATEWAY_STRIPPED_COMPONENTS,
  ANDROID_SMS_GATEWAY_STRIPPED_JAVA_FILES,
  ANDROID_SMS_GATEWAY_STRIPPED_NATIVE_PLUGINS,
  ANDROID_SMS_GATEWAY_STRIPPED_PERMISSIONS,
  applyAndroidPlayManifestHardening,
  isCloudBannedAsset,
  isCloudBannedNativeLibrary,
  resolveAndroidCloudCapacitorConfigPolicy,
  resolveAndroidCloudStripPolicy,
  sanitizeAndroidCloudCapacitorConfig,
} from "./cloud-policy.mjs";
import { packageNameToPath } from "./shared-tree.mjs";
import { cloudSafeAgentPluginJava } from "./templates/agent.mjs";
import { cloudSafeMainActivityJava } from "./templates/main-activity.mjs";
import { cloudSafePlayExportPluginJava } from "./templates/play-export.mjs";
import { cloudSafePlaySettingsPluginJava } from "./templates/play-settings.mjs";
import { cloudSafePlayVoicePluginJava } from "./templates/play-voice.mjs";
import { cloudSafeSecureCredentialsPluginJava } from "./templates/secure-credentials.mjs";
import { cloudSafeTasksWorkerJava } from "./templates/tasks-worker.mjs";

export function sanitizeAndroidCloudPackagedConfig(env = process.env) {
  const configPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "assets",
    "capacitor.config.json",
  );
  if (!fs.existsSync(configPath)) {
    throw new Error(
      "[mobile-build] android-cloud capacitor.config.json is missing",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(
      `[mobile-build] Could not parse android-cloud capacitor.config.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const sanitized = sanitizeAndroidCloudCapacitorConfig(
    parsed,
    resolveAndroidCloudCapacitorConfigPolicy(env),
  );
  fs.writeFileSync(configPath, `${JSON.stringify(sanitized, null, "\t")}\n`);
  console.log(
    "[mobile-build] Rewrote capacitor.config.json to the restricted Play runtime contract.",
  );
}

export function rewriteCloudJavaSources(
  javaRoots,
  androidPackage,
  {
    launcherKiosk = false,
    immersiveNavigation = false,
    safePushNotifications = true,
  } = {},
) {
  let touched = 0;
  for (const root of javaRoots) {
    if (!fs.existsSync(root)) continue;
    const mainActivity = path.join(root, "MainActivity.java");
    if (fs.existsSync(mainActivity)) {
      fs.writeFileSync(
        mainActivity,
        cloudSafeMainActivityJava(androidPackage, {
          launcherKiosk,
          immersiveNavigation,
          safePushNotifications,
        }),
        "utf8",
      );
      touched += 1;
    }
    const agentPlugin = path.join(root, "AgentPlugin.java");
    if (fs.existsSync(mainActivity) || fs.existsSync(agentPlugin)) {
      fs.writeFileSync(
        agentPlugin,
        cloudSafeAgentPluginJava(androidPackage),
        "utf8",
      );
      touched += 1;
    }
    fs.writeFileSync(
      path.join(root, "ElizaSecureCredentialsPlugin.java"),
      cloudSafeSecureCredentialsPluginJava(androidPackage),
      "utf8",
    );
    touched += 1;
    fs.writeFileSync(
      path.join(root, "ElizaPlayExportPlugin.java"),
      cloudSafePlayExportPluginJava(androidPackage),
      "utf8",
    );
    touched += 1;
    fs.writeFileSync(
      path.join(root, "ElizaPlayVoicePlugin.java"),
      cloudSafePlayVoicePluginJava(androidPackage),
      "utf8",
    );
    touched += 1;
    fs.writeFileSync(
      path.join(root, "ElizaPlaySettingsPlugin.java"),
      cloudSafePlaySettingsPluginJava(androidPackage),
      "utf8",
    );
    touched += 1;
    const tasksWorker = path.join(root, "ElizaTasksWorker.java");
    if (fs.existsSync(tasksWorker)) {
      fs.writeFileSync(
        tasksWorker,
        cloudSafeTasksWorkerJava(androidPackage),
        "utf8",
      );
      touched += 1;
    }
    const nativeBridge = path.join(root, "ElizaNativeBridge.java");
    if (fs.existsSync(nativeBridge)) {
      fs.rmSync(nativeBridge);
      touched += 1;
    }
  }
  if (touched > 0) {
    console.log(
      `[mobile-build] Rewrote ${touched} local-agent Java source(s) for android-cloud.`,
    );
  }
}

export function removeInactiveAndroidJavaSourceRoots(javaRoots, activeRoot) {
  const active = path.resolve(activeRoot);
  const seen = new Set();
  let removed = 0;

  const removeExceptActivePath = (root) => {
    for (const entry of fs.readdirSync(root)) {
      const candidate = path.resolve(root, entry);
      if (candidate === active) continue;
      if (active.startsWith(`${candidate}${path.sep}`)) {
        removeExceptActivePath(candidate);
        continue;
      }
      rmRecursive(candidate);
    }
  };

  for (const root of javaRoots) {
    const resolved = path.resolve(root);
    if (resolved === active || seen.has(resolved)) continue;
    seen.add(resolved);
    if (!fs.existsSync(root)) continue;
    if (active.startsWith(`${resolved}${path.sep}`)) {
      removeExceptActivePath(resolved);
    } else {
      rmRecursive(root);
    }
    removed += 1;
  }
  return removed;
}

export function removeCloudNativeArtifacts() {
  const assetsRoot = path.join(androidDir, "app", "src", "main", "assets");
  for (const directory of ANDROID_CLOUD_STRIPPED_ASSET_DIRECTORIES) {
    const target = path.join(assetsRoot, directory);
    if (!fs.existsSync(target)) continue;
    rmRecursive(target);
    console.log(
      `[mobile-build] Removed cloud-disallowed assets/${directory}/.`,
    );
  }

  let removedAssetCount = 0;
  walkFiles(assetsRoot, (filePath) => {
    if (isCloudBannedAsset(filePath)) {
      fs.rmSync(filePath, { force: true });
      removedAssetCount += 1;
    }
  });
  if (removedAssetCount > 0) {
    console.log(
      `[mobile-build] Removed ${removedAssetCount} native inference/runtime asset(s) from android-cloud source tree.`,
    );
  }

  const stagedJniLibs = path.join(androidDir, "app", "src", "main", "jniLibs");
  let removedLibCount = 0;
  walkFiles(stagedJniLibs, (filePath) => {
    if (isCloudBannedNativeLibrary(path.basename(filePath))) {
      fs.rmSync(filePath, { force: true });
      removedLibCount += 1;
    }
  });
  if (removedLibCount > 0) {
    console.log(
      `[mobile-build] Removed ${removedLibCount} native runtime/inference library(s) from jniLibs/.`,
    );
  }
}

export function stripAndroidNativePlugins(strippedPlugins, label) {
  const strippedPkgs = new Set(strippedPlugins.map(([pkg]) => pkg));
  const settingsPath = path.join(androidDir, "capacitor.settings.gradle");
  if (fs.existsSync(settingsPath)) {
    let patched = fs.readFileSync(settingsPath, "utf8");
    const current = patched;
    for (const [, gradleProject] of strippedPlugins) {
      const escaped = escapeRegExp(gradleProject);
      patched = patched
        .replace(new RegExp(`\\ninclude ':${escaped}'\\s*`, "g"), "\n")
        .replace(
          new RegExp(
            `\\nproject\\(':${escaped}'\\)\\.projectDir = new File\\([^\\n]+\\)\\s*`,
            "g",
          ),
          "\n",
        );
    }
    if (patched !== current) {
      fs.writeFileSync(settingsPath, patched, "utf8");
      console.log(
        `[mobile-build] Stripped ${label} native plugins from capacitor.settings.gradle.`,
      );
    }
  }

  const capacitorBuildPath = path.join(
    androidDir,
    "app",
    "capacitor.build.gradle",
  );
  if (fs.existsSync(capacitorBuildPath)) {
    let patched = fs.readFileSync(capacitorBuildPath, "utf8");
    const current = patched;
    for (const [, gradleProject] of strippedPlugins) {
      const escaped = escapeRegExp(gradleProject);
      patched = patched.replace(
        new RegExp(`\\n\\s*implementation project\\(':${escaped}'\\)\\s*`, "g"),
        "\n",
      );
    }
    if (patched !== current) {
      fs.writeFileSync(capacitorBuildPath, patched, "utf8");
      console.log(
        `[mobile-build] Stripped ${label} native plugins from capacitor.build.gradle.`,
      );
    }
  }

  const pluginManifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "assets",
    "capacitor.plugins.json",
  );
  if (fs.existsSync(pluginManifestPath)) {
    try {
      const plugins = JSON.parse(fs.readFileSync(pluginManifestPath, "utf8"));
      if (Array.isArray(plugins)) {
        const filtered = plugins.filter(
          (plugin) => !strippedPkgs.has(plugin?.pkg),
        );
        if (filtered.length !== plugins.length) {
          fs.writeFileSync(
            pluginManifestPath,
            `${JSON.stringify(filtered, null, "\t")}\n`,
            "utf8",
          );
          console.log(
            `[mobile-build] Stripped ${label} native plugins from capacitor.plugins.json.`,
          );
        }
      }
    } catch (error) {
      throw new Error(
        `[mobile-build] Could not parse capacitor.plugins.json while stripping android-cloud native plugins: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

export function stripAndroidCloudNativePlugins() {
  stripAndroidNativePlugins(
    ANDROID_CLOUD_STRIPPED_NATIVE_PLUGINS,
    "cloud-disallowed",
  );
}

/**
 * Strip the Play-Store-noncompliant manifest components, permissions, and
 * Java sources, plus any previously-staged on-device agent runtime
 * artifacts (assets/agent + jniLibs/libeliza_*.so), from a freshly
 * overlaid Android project.
 *
 * Idempotent: safe to re-run on an already-stripped tree.
 */
export function stripAndroidCloudResourceValues(resRoot) {
  let removed = 0;
  for (const [relPath, names] of Object.entries(
    ANDROID_CLOUD_STRIPPED_RESOURCE_VALUES,
  )) {
    const target = path.join(resRoot, relPath);
    if (!fs.existsSync(target)) continue;
    let xml = fs.readFileSync(target, "utf8");
    const original = xml;
    for (const name of names) {
      const resource = new RegExp(
        `\\s*<string\\s+name=["']${escapeRegExp(name)}["'][^>]*>[\\s\\S]*?<\\/string>`,
        "g",
      );
      xml = xml.replace(resource, () => {
        removed += 1;
        return "";
      });
    }
    if (xml !== original) {
      fs.writeFileSync(target, xml, "utf8");
    }
  }
  return removed;
}

export function stripAndroidForCloud({ env = process.env } = {}) {
  const androidPackage = APP.appId;
  const stripPolicy = resolveAndroidCloudStripPolicy(env);

  // 1. Strip manifest components, permissions, and BootReceiver/SMS/etc.
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (fs.existsSync(manifestPath)) {
    let xml = fs.readFileSync(manifestPath, "utf8");
    const original = xml;

    for (const component of stripPolicy.components) {
      xml = removeApplicationComponentBlock(
        xml,
        `${androidPackage}.${component}`,
      );
      xml = removeApplicationComponentClassBlock(xml, component);
    }
    xml = removeXmlCommentsContaining(xml, stripPolicy.components);
    xml = ensureManifestApplicationClosedBeforeTopLevelEntries(xml);

    xml = removeAndroidPermissionRequests(xml, stripPolicy.permissions);
    xml = ensureAndroidPermissionRemovalMarkers(
      xml,
      stripPolicy.mergerRemovedPermissions,
    );
    xml = applyAndroidCleartextPolicy(xml, { allowCleartext: false });
    xml = xml
      .replace(
        /\s*<package\s+android:name="com\.google\.android\.apps\.healthdata"\s*\/>/g,
        "",
      )
      .replace(
        /\s*<uses-feature\b(?=[^>]*android:name="android\.hardware\.(?:telephony|bluetooth_le)")[^>]*\/>/g,
        "",
      )
      .replace(/android:allowBackup="[^"]*"/, 'android:allowBackup="false"');
    xml = xml
      .replace(/(<\/provider>)\n[ \t]*(<activity\b)/g, "$1\n\n        $2")
      .replace(/\n[ \t]*<\/(application)>/g, "\n    </$1>");
    xml = applyAndroidPlayManifestHardening(xml);

    if (xml !== original) {
      fs.writeFileSync(manifestPath, xml, "utf8");
      console.log(
        "[mobile-build] Stripped Play-Store-noncompliant components and permissions from AndroidManifest.xml.",
      );
    }
  }
  const dataExtractionRulesPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "res",
    "xml",
    "data_extraction_rules.xml",
  );
  fs.mkdirSync(path.dirname(dataExtractionRulesPath), { recursive: true });
  if (
    !fs.existsSync(dataExtractionRulesPath) ||
    fs.readFileSync(dataExtractionRulesPath, "utf8") !==
      ANDROID_PLAY_DATA_EXTRACTION_RULES
  ) {
    fs.writeFileSync(
      dataExtractionRulesPath,
      ANDROID_PLAY_DATA_EXTRACTION_RULES,
      "utf8",
    );
  }

  // 2. Remove the matching Java sources so the build doesn't reference
  //    manifest-stripped classes. The merged sources live under
  //    app/src/main/java/<package-path>/, and overlayAndroid() may also
  //    have left a legacy ai/elizaos/app copy if the Java rename ran on a
  //    fresh tree — wipe both.
  const activeJavaRoot = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    packageNameToPath(androidPackage),
  );
  const javaRoots = [
    activeJavaRoot,
    path.join(androidDir, "app", "src", "main", "java", "ai", "elizaos", "app"),
  ];
  let removedJavaCount = 0;
  for (const root of javaRoots) {
    if (!fs.existsSync(root)) continue;
    for (const file of stripPolicy.javaFiles) {
      const target = path.join(root, file);
      if (fs.existsSync(target)) {
        fs.rmSync(target);
        removedJavaCount += 1;
      }
    }
  }
  if (removedJavaCount > 0) {
    console.log(
      `[mobile-build] Removed ${removedJavaCount} Play-Store-noncompliant Java source(s).`,
    );
  }
  const removedJavaRootCount = removeInactiveAndroidJavaSourceRoots(
    javaRoots,
    activeJavaRoot,
  );
  if (removedJavaRootCount > 0) {
    console.log(
      `[mobile-build] Removed ${removedJavaRootCount} inactive Android Java source root(s).`,
    );
  }
  rewriteCloudJavaSources([activeJavaRoot], androidPackage, {
    launcherKiosk: env.ELIZA_ANDROID_LAUNCHER_BUILD === "1",
    immersiveNavigation: env.ELIZA_ANDROID_LAUNCHER_BUILD === "1",
    safePushNotifications: stripPolicy.safePushNotifications,
  });

  const testJavaRoots = [
    path.join(
      androidDir,
      "app",
      "src",
      "test",
      "java",
      packageNameToPath(androidPackage),
    ),
    path.join(androidDir, "app", "src", "test", "java", "ai", "elizaos", "app"),
  ];
  let removedTestJavaCount = 0;
  for (const root of testJavaRoots) {
    if (!fs.existsSync(root)) continue;
    for (const file of stripPolicy.testJavaFiles) {
      const target = path.join(root, file);
      if (fs.existsSync(target)) {
        fs.rmSync(target);
        removedTestJavaCount += 1;
      }
    }
  }
  if (removedTestJavaCount > 0) {
    console.log(
      `[mobile-build] Removed ${removedTestJavaCount} JVM test source(s) for source-stripped Android runtime code.`,
    );
  }

  const resRoot = path.join(androidDir, "app", "src", "main", "res");
  let removedResourceCount = 0;
  for (const relPath of ANDROID_CLOUD_STRIPPED_RESOURCE_FILES) {
    const target = path.join(resRoot, relPath);
    if (fs.existsSync(target)) {
      fs.rmSync(target);
      removedResourceCount += 1;
    }
  }
  removedResourceCount += stripAndroidCloudResourceValues(resRoot);
  if (removedResourceCount > 0) {
    console.log(
      `[mobile-build] Removed ${removedResourceCount} Play-Store-noncompliant Android resource(s).`,
    );
  }

  // 3. Wipe any previously-staged on-device agent runtime. These are
  //    build artifacts (.gitignore covers them) — the cloud APK must not
  //    embed bun, musl, libstdc++, libgcc, llama-server, or the
  //    libeliza_*.so jniLibs disguise.
  removeCloudNativeArtifacts();
  stripAndroidCloudNativePlugins();
  sanitizeAndroidCloudPackagedConfig(env);
}

export function stripAndroidForSmsGateway() {
  const androidPackage = APP.appId;
  const manifestPath = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "AndroidManifest.xml",
  );
  if (fs.existsSync(manifestPath)) {
    let xml = fs.readFileSync(manifestPath, "utf8");
    const original = xml;

    for (const component of ANDROID_SMS_GATEWAY_STRIPPED_COMPONENTS) {
      xml = removeApplicationComponentBlock(
        xml,
        `${androidPackage}.${component}`,
      );
      xml = removeApplicationComponentClassBlock(xml, component);
    }

    xml = removeAndroidPermissionRequests(
      xml,
      ANDROID_SMS_GATEWAY_STRIPPED_PERMISSIONS,
    );
    xml = ensureAndroidPermissionRemovalMarkers(
      xml,
      ANDROID_CLOUD_MANIFEST_MERGER_REMOVED_PERMISSIONS.filter((permission) =>
        ANDROID_SMS_GATEWAY_STRIPPED_PERMISSIONS.includes(permission),
      ),
    );
    xml = applyAndroidCleartextPolicy(xml, { allowCleartext: false });

    if (xml !== original) {
      fs.writeFileSync(manifestPath, xml, "utf8");
      console.log(
        "[mobile-build] Stripped non-SMS local components and permissions from AndroidManifest.xml.",
      );
    }
  }

  const activeJavaRoot = path.join(
    androidDir,
    "app",
    "src",
    "main",
    "java",
    packageNameToPath(androidPackage),
  );
  const javaRoots = [
    activeJavaRoot,
    path.join(androidDir, "app", "src", "main", "java", "ai", "elizaos", "app"),
  ];
  let removedJavaCount = 0;
  for (const root of javaRoots) {
    if (!fs.existsSync(root)) continue;
    for (const file of ANDROID_SMS_GATEWAY_STRIPPED_JAVA_FILES) {
      const target = path.join(root, file);
      if (fs.existsSync(target)) {
        fs.rmSync(target);
        removedJavaCount += 1;
      }
    }
  }
  if (removedJavaCount > 0) {
    console.log(
      `[mobile-build] Removed ${removedJavaCount} non-SMS Java source(s).`,
    );
  }
  const removedJavaRootCount = removeInactiveAndroidJavaSourceRoots(
    javaRoots,
    activeJavaRoot,
  );
  if (removedJavaRootCount > 0) {
    console.log(
      `[mobile-build] Removed ${removedJavaRootCount} inactive Android Java source root(s).`,
    );
  }
  rewriteCloudJavaSources(javaRoots, androidPackage, {
    safePushNotifications: false,
  });

  const resRoot = path.join(androidDir, "app", "src", "main", "res");
  for (const relPath of ANDROID_CLOUD_STRIPPED_RESOURCE_FILES) {
    const target = path.join(resRoot, relPath);
    if (fs.existsSync(target)) {
      fs.rmSync(target);
    }
  }

  removeCloudNativeArtifacts();
  stripAndroidNativePlugins(
    ANDROID_SMS_GATEWAY_STRIPPED_NATIVE_PLUGINS,
    "sms-gateway-disallowed",
  );
}
