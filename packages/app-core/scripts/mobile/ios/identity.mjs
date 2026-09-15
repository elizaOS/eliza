/** Owns ios identity using the shared build context and existing platform contracts. */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { escapeXcodeBuildSetting, replaceInFile } from "../build-tools.mjs";
import { APP, appDir } from "../context.mjs";
import { escapeRegExp } from "../escape.mjs";
import {
  removePbxListEntries,
  replaceIosAppGroupPlaceholders,
} from "../ios-plist.mjs";
import { shouldDisableIosPrivilegedCapabilities } from "./policy.mjs";
import {
  IOS_PERSONAL_TEAM_ENTITLEMENTS,
  IOS_PRIVILEGED_EXTENSION_LIST_ENTRY_IDS,
} from "./runtime-assets.mjs";

export function replaceIosAppGroupPlaceholdersInFile(filePath, appGroup) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, "utf8");
  const next = replaceIosAppGroupPlaceholders(content, appGroup);
  if (next === content) return false;
  fs.writeFileSync(filePath, next, "utf8");
  return true;
}

export function writeIosPersonalTeamEntitlements(filePath) {
  if (
    fs.existsSync(filePath) &&
    fs.readFileSync(filePath, "utf8") === IOS_PERSONAL_TEAM_ENTITLEMENTS
  ) {
    return false;
  }
  fs.writeFileSync(filePath, IOS_PERSONAL_TEAM_ENTITLEMENTS, "utf8");
  return true;
}

export function stripIosPrivilegedExtensionTargets({
  appDirValue = appDir,
  log = console.log,
} = {}) {
  const projectPath = path.join(
    appDirValue,
    "ios",
    "App",
    "App.xcodeproj",
    "project.pbxproj",
  );
  if (!fs.existsSync(projectPath)) return false;
  const project = fs.readFileSync(projectPath, "utf8");
  const next = removePbxListEntries(
    project,
    IOS_PRIVILEGED_EXTENSION_LIST_ENTRY_IDS,
  );
  if (next === project) return false;
  fs.writeFileSync(projectPath, next, "utf8");
  log("[mobile-build] Disabled privileged iOS extension targets.");
  return true;
}

export function applyIosAppIdentity({
  appDirValue = appDir,
  appId = APP.appId,
  appName = APP.appName,
  appGroup = `group.${appId}`,
  developmentTeam = process.env.ELIZA_IOS_DEVELOPMENT_TEAM ?? null,
  versionName = process.env.ELIZAOS_VERSION_NAME?.trim() || null,
  versionCode = process.env.ELIZAOS_VERSION_CODE?.trim() || null,
  log = console.log,
} = {}) {
  const iosAppRoot = path.join(appDirValue, "ios", "App");
  const changed = [];
  const privilegedCapabilitiesDisabled =
    shouldDisableIosPrivilegedCapabilities();
  const projectPath = path.join(iosAppRoot, "App.xcodeproj", "project.pbxproj");
  if (fs.existsSync(projectPath)) {
    let project = fs.readFileSync(projectPath, "utf8");
    const original = project;
    const extensionBundleSuffixes = [
      "WebsiteBlockerContentExtension",
      "DeviceActivityMonitorExtension",
      "DeviceActivityReportExtension",
      "ElizaWidgets",
      "ElizaKeyboard",
    ];
    for (const suffix of extensionBundleSuffixes) {
      project = project.replace(
        new RegExp(
          `PRODUCT_BUNDLE_IDENTIFIER = [A-Za-z0-9_.-]+\\.${escapeRegExp(suffix)};`,
          "g",
        ),
        `PRODUCT_BUNDLE_IDENTIFIER = ${appId}.${suffix};`,
      );
    }
    const extensionSuffixAlternation = extensionBundleSuffixes
      .map(escapeRegExp)
      .join("|");
    project = project.replace(
      new RegExp(
        `PRODUCT_BUNDLE_IDENTIFIER = (?![A-Za-z0-9_.-]+\\.(?:${extensionSuffixAlternation});)[A-Za-z0-9_.-]+;`,
        "g",
      ),
      `PRODUCT_BUNDLE_IDENTIFIER = ${appId};`,
    );
    const displayNameSetting = `ELIZA_DISPLAY_NAME = ${escapeXcodeBuildSetting(appName)};`;
    if (project.includes("ELIZA_DISPLAY_NAME = ")) {
      project = project.replace(
        /ELIZA_DISPLAY_NAME = .*?;/g,
        displayNameSetting,
      );
    } else {
      project = project.replace(
        new RegExp(
          `(^[ \\t]*MARKETING_VERSION = 1\\.0;\\n)([ \\t]*)PRODUCT_BUNDLE_IDENTIFIER = ${escapeRegExp(appId)};`,
          "m",
        ),
        `$1$2${displayNameSetting}\n$2PRODUCT_BUNDLE_IDENTIFIER = ${appId};`,
      );
    }
    // Thread the real release version into every target (app + all extension
    // targets) so the PR-evidence "confirm the running build is yours
    // (versionName)" check is possible on iOS. Mirrors the Android contract
    // (ELIZAOS_VERSION_CODE/ELIZAOS_VERSION_NAME in
    // platforms/android/app/build.gradle). Must run after the
    // ELIZA_DISPLAY_NAME insertion above, which anchors on the template's
    // literal `MARKETING_VERSION = 1.0;` line.
    if (versionName) {
      if (!/^\d+(\.\d+){0,2}$/.test(versionName)) {
        throw new Error(
          `ELIZAOS_VERSION_NAME must be 1-3 dot-separated integers (CFBundleShortVersionString), got ${versionName}`,
        );
      }
      project = project.replace(
        /MARKETING_VERSION = [^;]+;/g,
        `MARKETING_VERSION = ${versionName};`,
      );
    }
    if (versionCode) {
      if (!/^\d+(\.\d+){0,2}$/.test(versionCode)) {
        throw new Error(
          `ELIZAOS_VERSION_CODE must be 1-3 dot-separated integers (CFBundleVersion), got ${versionCode}`,
        );
      }
      project = project.replace(
        /CURRENT_PROJECT_VERSION = [^;]+;/g,
        `CURRENT_PROJECT_VERSION = ${versionCode};`,
      );
    }
    if (developmentTeam) {
      project = project.replace(
        /DEVELOPMENT_TEAM = [A-Z0-9]+;/g,
        `DEVELOPMENT_TEAM = ${developmentTeam};`,
      );
    }
    if (project !== original) {
      fs.writeFileSync(projectPath, project, "utf8");
      changed.push(path.relative(iosAppRoot, projectPath));
    }
  }

  if (privilegedCapabilitiesDisabled) {
    const entitlementPath = path.join(iosAppRoot, "App", "App.entitlements");
    if (writeIosPersonalTeamEntitlements(entitlementPath)) {
      changed.push(path.join("App", "App.entitlements"));
    }
    if (stripIosPrivilegedExtensionTargets({ appDirValue, log })) {
      changed.push(path.relative(iosAppRoot, projectPath));
    }
  }
  for (const relPath of [
    path.join("App", "App.entitlements"),
    path.join("App", "ScreenTimeSupport.swift"),
    path.join("App", "ComputerUseBridge.swift"),
    path.join(
      "App",
      "WebsiteBlockerContentExtension",
      "WebsiteBlockerContentExtension.entitlements",
    ),
    path.join(
      "App",
      "WebsiteBlockerContentExtension",
      "ActionRequestHandler.swift",
    ),
    // The DeviceActivity extensions hardcode group.ai.elizaos.app in their
    // template entitlements; without rewriting them to the app's group, a
    // non-eliza branded full-team device build fails codesign with
    // "provisioning profile doesn't support the group.ai.elizaos.app App Group".
    path.join(
      "App",
      "DeviceActivityMonitorExtension",
      "DeviceActivityMonitorExtension.entitlements",
    ),
    path.join(
      "App",
      "DeviceActivityReportExtension",
      "DeviceActivityReportExtension.entitlements",
    ),
    path.join("App", "ElizaWidgets", "ElizaWidgets.entitlements"),
    path.join("App", "ElizaKeyboard", "ElizaKeyboard.entitlements"),
  ]) {
    const filePath = path.join(iosAppRoot, relPath);
    if (
      !privilegedCapabilitiesDisabled &&
      replaceIosAppGroupPlaceholdersInFile(filePath, appGroup)
    ) {
      changed.push(relPath);
    }
  }

  const extensionId = [
    `${appId}.WebsiteBlockerContentExtension`,
    `${appId}.DeviceActivityMonitorExtension`,
    `${appId}.DeviceActivityReportExtension`,
    `${appId}.ElizaWidgets`,
    `${appId}.ElizaKeyboard`,
  ].join(",");
  const fastlaneReplacements = [
    [
      'ENV["APP_IDENTIFIER"] || "ai.elizaos.app"',
      `ENV["APP_IDENTIFIER"] || "${appId}"`,
    ],
    [
      'ENV["APP_IDENTIFIER_EXTRA"] || ""',
      `ENV["APP_IDENTIFIER_EXTRA"] || "${extensionId}"`,
    ],
  ];
  for (const relPath of [
    path.join("fastlane", "Appfile"),
    path.join("fastlane", "Fastfile"),
    path.join("fastlane", "Matchfile"),
  ]) {
    const filePath = path.join(path.dirname(iosAppRoot), relPath);
    if (replaceInFile(filePath, fastlaneReplacements)) {
      changed.push(relPath);
    }
  }
  if (changed.length > 0) {
    log(`[mobile-build] Applied iOS identity ${appId}.`);
  }
  return changed;
}
