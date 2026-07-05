import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXACT_SMOKE_KEYS = new Set([
  "elizaos:active-server",
  "eliza:first-run-complete",
  "eliza:setup:step",
  "eliza:onboarding-complete",
  "eliza:mobile-runtime-mode",
  "eliza.background.config",
  "elizaos:first-run:force-fresh",
]);

const SMOKE_KEY_PATTERNS = [
  /^eliza:.*smoke(?::|$)/,
  /^elizaos:.*smoke(?::|$)/,
  /^eliza:auth-callback-smoke(?::|$)/,
  /^eliza:ios-.*(?:smoke|harness)(?::|$)/,
  /^eliza:ios-full-bun-(?:smoke|prewarm)(?::|$)/,
  /^eliza:ios-background(?::|$)/,
];

function stripCapacitorPrefix(key) {
  return key.startsWith("CapacitorStorage.")
    ? key.slice("CapacitorStorage.".length)
    : key;
}

export function preferenceNativeKeys(key) {
  return [`CapacitorStorage.${key}`, key];
}

export function shouldClearIosSmokePreferenceKey(key, options = {}) {
  const normalized = stripCapacitorPrefix(String(key));
  if (EXACT_SMOKE_KEYS.has(normalized)) return true;
  if (SMOKE_KEY_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (options.includeAppState === true) {
    return (
      normalized.startsWith("eliza:first-run") ||
      normalized.startsWith("eliza:onboarding") ||
      normalized.startsWith("eliza:mobile-runtime") ||
      normalized.startsWith("elizaos:active-server")
    );
  }
  return false;
}

export function selectIosSmokePreferenceKeys(entries, options = {}) {
  return Array.from(
    new Set(
      entries
        .map((entry) => stripCapacitorPrefix(String(entry)))
        .filter((key) => shouldClearIosSmokePreferenceKey(key, options)),
    ),
  ).sort();
}

function execText(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: options.cwd,
      encoding: "utf8",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      input: options.input,
    }).trim();
  } catch (error) {
    if (options.optional) return null;
    throw error;
  }
}

function appDataContainer(udid, bundleId) {
  return execText(
    "xcrun",
    ["simctl", "get_app_container", udid, bundleId, "data"],
    { optional: true },
  );
}

function prefsDomainPath(udid, bundleId) {
  const container = appDataContainer(udid, bundleId);
  if (!container) return null;
  return path.join(container, "Library", "Preferences", bundleId);
}

export function readIosDefaultsDomain({ udid, bundleId }) {
  const keys = new Set();
  const domainPath = prefsDomainPath(udid, bundleId);
  const plist = domainPath ? `${domainPath}.plist` : null;
  if (plist && fs.existsSync(plist)) {
    const json = execText("plutil", ["-convert", "json", "-o", "-", plist], {
      optional: true,
    });
    if (json) {
      try {
        for (const key of Object.keys(JSON.parse(json))) keys.add(key);
      } catch {
        // Fall through to defaults export.
      }
    }
  }

  const exported = execText(
    "xcrun",
    ["simctl", "spawn", udid, "defaults", "export", bundleId, "-"],
    { optional: true },
  );
  if (exported) {
    const json = execText("plutil", ["-convert", "json", "-o", "-", "-"], {
      optional: true,
      input: exported,
    });
    if (json) {
      try {
        for (const key of Object.keys(JSON.parse(json))) keys.add(key);
      } catch {
        // Ignore malformed exports.
      }
    }
  }
  return Array.from(keys).sort();
}

export function deleteIosDefaultsKey({ udid, bundleId, key }) {
  for (const nativeKey of preferenceNativeKeys(key)) {
    execText(
      "xcrun",
      ["simctl", "spawn", udid, "defaults", "delete", bundleId, nativeKey],
      { optional: true },
    );
  }

  const domainPath = prefsDomainPath(udid, bundleId);
  if (domainPath) {
    for (const nativeKey of preferenceNativeKeys(key)) {
      execText("defaults", ["delete", domainPath, nativeKey], {
        optional: true,
      });
    }
  }
}

export function flushIosPreferencesCache(udid) {
  execText("xcrun", ["simctl", "spawn", udid, "killall", "cfprefsd"], {
    optional: true,
  });
}

export function clearIosSmokeDefaults({
  udid,
  bundleId,
  includeAppState = true,
  extraKeys = [],
  log = () => {},
}) {
  const domainKeys = readIosDefaultsDomain({ udid, bundleId });
  const selected = selectIosSmokePreferenceKeys([...domainKeys, ...extraKeys], {
    includeAppState,
  });
  for (const key of selected) {
    deleteIosDefaultsKey({ udid, bundleId, key });
  }
  flushIosPreferencesCache(udid);
  if (selected.length > 0) {
    log(
      `cleared ${selected.length} iOS simulator smoke/default key(s): ${selected.join(", ")}`,
    );
  }
  return selected;
}
