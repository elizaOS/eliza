#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");
const defaultRepoRoot = path.resolve(pluginRoot, "..", "..", "..");

export const IOS_SCREEN_TIME_REQUIREMENTS = Object.freeze({
  entitlements: Object.freeze({
    familyControls: "com.apple.developer.family-controls",
  }),
  frameworks: Object.freeze(["FamilyControls", "DeviceActivity"]),
  extensionPoints: Object.freeze({
    deviceActivityMonitor: "com.apple.deviceactivity.monitor-extension",
    deviceActivityReport: "com.apple.deviceactivityui.report-extension",
  }),
  extensionTargets: Object.freeze({
    deviceActivityMonitor: "DeviceActivityMonitorExtension",
    deviceActivityReport: "DeviceActivityReportExtension",
  }),
  appEntitlementsRelativePath: path.join("App", "App.entitlements"),
});

export function defaultIosScreenTimeValidationPaths({
  repoRootValue = defaultRepoRoot,
} = {}) {
  return {
    entitlementsPath: path.join(
      repoRootValue,
      "packages",
      "app-core",
      "platforms",
      "ios",
      "App",
      "App",
      "App.entitlements",
    ),
    projectPath: path.join(
      repoRootValue,
      "packages",
      "app-core",
      "platforms",
      "ios",
      "App",
      "App.xcodeproj",
      "project.pbxproj",
    ),
    appRootPath: path.join(
      repoRootValue,
      "packages",
      "app-core",
      "platforms",
      "ios",
      "App",
      "App",
    ),
    podspecPath: path.join(
      repoRootValue,
      "packages",
      "native-plugins",
      "mobile-signals",
      "ElizaosCapacitorMobileSignals.podspec",
    ),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addCheck(checks, id, ok, message, skipped = false) {
  checks.push({ id, ok, skipped, message });
}

function readRequiredText(filePath, label) {
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(`${label} does not exist at ${filePath ?? "(not set)"}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function findKeyEnd(plist, key) {
  const pattern = new RegExp(`<key>\\s*${escapeRegExp(key)}\\s*</key>`, "m");
  const match = pattern.exec(plist);
  return match ? match.index + match[0].length : -1;
}

function extractNextDict(plist, startIndex) {
  const dictStart = plist.indexOf("<dict>", startIndex);
  if (dictStart === -1) return null;

  const tokenPattern = /<\/?dict>/g;
  tokenPattern.lastIndex = dictStart;
  let depth = 0;
  for (;;) {
    const match = tokenPattern.exec(plist);
    if (!match) return null;
    depth += match[0] === "<dict>" ? 1 : -1;
    if (depth === 0) {
      return plist.slice(dictStart, tokenPattern.lastIndex);
    }
  }
}

function extractDictAfterKey(plist, key) {
  const keyEnd = findKeyEnd(plist, key);
  if (keyEnd === -1) return null;
  return extractNextDict(plist, keyEnd);
}

function plistStringValue(plist, key, { enclosingKey } = {}) {
  const source = enclosingKey
    ? extractDictAfterKey(plist, enclosingKey)
    : plist;
  if (!source) return null;
  const pattern = new RegExp(
    `<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<string>\\s*([^<]+?)\\s*</string>`,
    "m",
  );
  const match = pattern.exec(source);
  return match ? match[1].trim() : null;
}

function plistBooleanIsTrue(plist, key, { enclosingKey } = {}) {
  const source = enclosingKey
    ? extractDictAfterKey(plist, enclosingKey)
    : plist;
  if (!source) return false;
  const pattern = new RegExp(
    `<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<true\\s*/>`,
    "m",
  );
  return pattern.test(source);
}

function missingRequiredEntitlements(plist, { enclosingKey } = {}) {
  return Object.values(IOS_SCREEN_TIME_REQUIREMENTS.entitlements).filter(
    (key) => !plistBooleanIsTrue(plist, key, { enclosingKey }),
  );
}

function decodeProvisioningProfile(profilePath) {
  const raw = fs.readFileSync(profilePath);
  const text = raw.toString("utf8");
  if (text.includes("<plist")) {
    return text;
  }

  if (process.platform !== "darwin") {
    throw new Error(
      "binary provisioning profiles can only be decoded on macOS with the security tool",
    );
  }

  const result = spawnSync("security", ["cms", "-D", "-i", profilePath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `security cms failed with exit code ${result.status ?? 1}`,
    );
  }
  return result.stdout;
}

function walkFiles(rootPath) {
  if (!rootPath || !fs.existsSync(rootPath)) return [];
  const entries = fs.readdirSync(rootPath, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function findDeviceActivityExtensionInfoPlists(appRootPath) {
  const expectedPoints = IOS_SCREEN_TIME_REQUIREMENTS.extensionPoints;
  const matches = {
    deviceActivityMonitor: [],
    deviceActivityReport: [],
  };

  for (const filePath of walkFiles(appRootPath)) {
    if (path.basename(filePath) !== "Info.plist") continue;
    const plist = fs.readFileSync(filePath, "utf8");
    const extensionPoint = plistStringValue(
      plist,
      "NSExtensionPointIdentifier",
      {
        enclosingKey: "NSExtension",
      },
    );
    for (const [key, expected] of Object.entries(expectedPoints)) {
      if (extensionPoint === expected) {
        matches[key].push(filePath);
      }
    }
  }

  return matches;
}

function missingDeviceActivityExtensions(matches) {
  return Object.keys(IOS_SCREEN_TIME_REQUIREMENTS.extensionPoints).filter(
    (key) => !matches[key]?.length,
  );
}

function relativeList(filePaths, basePath) {
  return filePaths.map((filePath) => path.relative(basePath, filePath));
}

export function validateIosScreenTimeBuildWiring(options = {}) {
  const defaults = defaultIosScreenTimeValidationPaths(options);
  const entitlementsPath =
    options.entitlementsPath ?? defaults.entitlementsPath;
  const projectPath = options.projectPath ?? defaults.projectPath;
  const appRootPath = options.appRootPath ?? defaults.appRootPath;
  const podspecPath = options.podspecPath ?? defaults.podspecPath;
  const provisioningProfilePath =
    options.provisioningProfilePath ??
    process.env.MOBILE_SIGNALS_IOS_PROVISIONING_PROFILE;
  const requireProvisioningProfile =
    options.requireProvisioningProfile ??
    process.env.MOBILE_SIGNALS_REQUIRE_IOS_PROVISIONING_PROFILE === "1";
  const checks = [];

  try {
    const entitlements = readRequiredText(entitlementsPath, "iOS entitlements");
    const missing = missingRequiredEntitlements(entitlements);
    addCheck(
      checks,
      "app-entitlements",
      missing.length === 0,
      missing.length === 0
        ? `App entitlements include ${Object.values(
            IOS_SCREEN_TIME_REQUIREMENTS.entitlements,
          ).join(", ")}.`
        : `App entitlements are missing required Screen Time keys: ${missing.join(
            ", ",
          )}.`,
    );
  } catch (error) {
    addCheck(checks, "app-entitlements", false, error.message);
  }

  try {
    const project = readRequiredText(projectPath, "Xcode project");
    const expected = `CODE_SIGN_ENTITLEMENTS = ${IOS_SCREEN_TIME_REQUIREMENTS.appEntitlementsRelativePath};`;
    addCheck(
      checks,
      "xcode-entitlements-build-setting",
      project.includes(expected),
      project.includes(expected)
        ? "Xcode project signs the app target with App/App.entitlements."
        : `Xcode project does not contain ${expected}`,
    );
  } catch (error) {
    addCheck(checks, "xcode-entitlements-build-setting", false, error.message);
  }

  try {
    const extensionPlists = findDeviceActivityExtensionInfoPlists(appRootPath);
    const missing = missingDeviceActivityExtensions(extensionPlists);
    const found = Object.values(extensionPlists).flat();
    addCheck(
      checks,
      "deviceactivity-extension-info-plists",
      missing.length === 0,
      missing.length === 0
        ? `DeviceActivity extension Info.plists found: ${relativeList(
            found,
            appRootPath,
          ).join(", ")}.`
        : `Missing DeviceActivity extension Info.plists for: ${missing.join(
            ", ",
          )}. Expected NSExtensionPointIdentifier values ${Object.values(
            IOS_SCREEN_TIME_REQUIREMENTS.extensionPoints,
          ).join(", ")} under ${appRootPath}.`,
    );
  } catch (error) {
    addCheck(
      checks,
      "deviceactivity-extension-info-plists",
      false,
      error.message,
    );
  }

  try {
    const project = readRequiredText(projectPath, "Xcode project");
    const missingTargets = Object.values(
      IOS_SCREEN_TIME_REQUIREMENTS.extensionTargets,
    ).filter((targetName) => !project.includes(`/* ${targetName} */`));
    addCheck(
      checks,
      "xcode-deviceactivity-extension-targets",
      missingTargets.length === 0,
      missingTargets.length === 0
        ? "Xcode project includes DeviceActivity monitor and report extension targets."
        : `Xcode project is missing DeviceActivity extension targets: ${missingTargets.join(
            ", ",
          )}.`,
    );

    const missingEmbeddedProducts = Object.values(
      IOS_SCREEN_TIME_REQUIREMENTS.extensionTargets,
    ).filter((targetName) => !project.includes(`${targetName}.appex`));
    addCheck(
      checks,
      "xcode-deviceactivity-embedded-products",
      missingEmbeddedProducts.length === 0,
      missingEmbeddedProducts.length === 0
        ? "Xcode project declares DeviceActivity extension products for app embedding."
        : `Xcode project is missing embedded DeviceActivity .appex products: ${missingEmbeddedProducts
            .map((targetName) => `${targetName}.appex`)
            .join(", ")}.`,
    );
  } catch (error) {
    addCheck(
      checks,
      "xcode-deviceactivity-extension-targets",
      false,
      error.message,
    );
    addCheck(
      checks,
      "xcode-deviceactivity-embedded-products",
      false,
      error.message,
    );
  }

  try {
    const podspec = readRequiredText(podspecPath, "mobile-signals podspec");
    const missingFrameworks = IOS_SCREEN_TIME_REQUIREMENTS.frameworks.filter(
      (framework) => !podspec.includes(framework),
    );
    addCheck(
      checks,
      "podspec-frameworks",
      missingFrameworks.length === 0,
      missingFrameworks.length === 0
        ? "mobile-signals podspec links FamilyControls and DeviceActivity."
        : `mobile-signals podspec is missing frameworks: ${missingFrameworks.join(
            ", ",
          )}.`,
    );
  } catch (error) {
    addCheck(checks, "podspec-frameworks", false, error.message);
  }

  if (provisioningProfilePath) {
    try {
      if (!fs.existsSync(provisioningProfilePath)) {
        throw new Error(
          `Provisioning profile does not exist at ${provisioningProfilePath}`,
        );
      }
      const profilePlist = decodeProvisioningProfile(provisioningProfilePath);
      const missing = missingRequiredEntitlements(profilePlist, {
        enclosingKey: "Entitlements",
      });
      addCheck(
        checks,
        "provisioning-entitlements",
        missing.length === 0,
        missing.length === 0
          ? "Provisioning profile includes required Screen Time entitlements."
          : `Provisioning profile is missing required Screen Time keys: ${missing.join(
              ", ",
            )}.`,
      );
    } catch (error) {
      addCheck(checks, "provisioning-entitlements", false, error.message);
    }
  } else if (requireProvisioningProfile) {
    addCheck(
      checks,
      "provisioning-entitlements",
      false,
      "MOBILE_SIGNALS_REQUIRE_IOS_PROVISIONING_PROFILE=1 but no provisioning profile was supplied.",
    );
  } else {
    addCheck(
      checks,
      "provisioning-entitlements",
      true,
      "No provisioning profile supplied; skipping profile entitlement inspection.",
      true,
    );
  }

  const failures = checks.filter((check) => !check.ok);
  return {
    ok: failures.length === 0,
    checks,
    failures,
    requirements: IOS_SCREEN_TIME_REQUIREMENTS,
  };
}

export function assertIosScreenTimeBuildWiring(options = {}) {
  const result = validateIosScreenTimeBuildWiring(options);
  if (!result.ok) {
    throw new Error(
      [
        "iOS Screen Time build wiring is invalid:",
        ...result.failures.map((failure) => `- ${failure.message}`),
      ].join("\n"),
    );
  }
  return result;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--repo-root") {
      options.repoRootValue = path.resolve(next());
    } else if (arg === "--entitlements") {
      options.entitlementsPath = path.resolve(next());
    } else if (arg === "--project") {
      options.projectPath = path.resolve(next());
    } else if (arg === "--app-root") {
      options.appRootPath = path.resolve(next());
    } else if (arg === "--podspec") {
      options.podspecPath = path.resolve(next());
    } else if (arg === "--provisioning-profile") {
      options.provisioningProfilePath = path.resolve(next());
    } else if (arg === "--require-provisioning-profile") {
      options.requireProvisioningProfile = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = validateIosScreenTimeBuildWiring(options);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const check of result.checks) {
        const prefix = check.skipped ? "SKIP" : check.ok ? "OK" : "FAIL";
        console.log(`[${prefix}] ${check.message}`);
      }
    }
    if (!result.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
