/**
 * Manages UserDefaults state shared by iOS simulator smoke harnesses and the
 * Capacitor renderer. Pre-launch seeding uses the simulator defaults service;
 * post-launch polling prefers the app-written plist because cfprefsd can retain
 * a stale compatibility alias after Capacitor updates its prefixed key.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveSmokeCommand } from "./smoke-command-proxy.mjs";

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

/**
 * Writes a string through the booted simulator's defaults service. Writing a
 * host filesystem plist does not reliably update the simulator's cfprefsd
 * domain, even when the path points inside the app data container.
 */
export function writeIosDefaultsString(
  { udid, bundleId, key, value },
  execute = execText,
) {
  for (const nativeKey of preferenceNativeKeys(key)) {
    execute("xcrun", [
      "simctl",
      "spawn",
      udid,
      "defaults",
      "write",
      bundleId,
      nativeKey,
      "-string",
      value,
    ]);
  }
}

/** Returns the first Capacitor-compatible string stored in the simulator domain. */
export function readIosDefaultsString(
  { udid, bundleId, key },
  execute = execText,
) {
  for (const nativeKey of preferenceNativeKeys(key)) {
    const value = execute(
      "xcrun",
      ["simctl", "spawn", udid, "defaults", "read", bundleId, nativeKey],
      { optional: true },
    );
    if (value !== null) return value;
  }
  return null;
}

/**
 * Reads the app-owned preference plist before consulting cfprefsd. Capacitor
 * writes the prefixed key from inside the running app, so this is the freshest
 * post-launch observation when the raw alias seeded by the host is still cached.
 */
export function readIosPreferenceString(
  { udid, bundleId, key },
  { execute = execText, fileExists = fs.existsSync } = {},
) {
  const domainPath = prefsDomainPath(udid, bundleId, execute);
  const plist = domainPath ? `${domainPath}.plist` : null;
  if (plist && fileExists(plist)) {
    const json = execute("plutil", ["-convert", "json", "-o", "-", plist], {
      optional: true,
    });
    if (json) {
      try {
        const values = JSON.parse(json);
        if (values && typeof values === "object" && !Array.isArray(values)) {
          for (const nativeKey of preferenceNativeKeys(key)) {
            const value = values[nativeKey];
            if (typeof value === "string") return value;
          }
        }
      } catch {
        // error-policy:J3 a concurrently replaced plist is explicitly unreadable;
        // the simulator defaults fallback below remains an independent source.
      }
    }
  }
  return readIosDefaultsString({ udid, bundleId, key }, execute);
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
    const invocation = resolveSmokeCommand(command, args);
    return execFileSync(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: process.env,
      encoding: "utf8",
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      input: options.input,
    }).trim();
  } catch (error) {
    if (options.optional) return null;
    throw error;
  }
}

function appDataContainer(udid, bundleId, execute = execText) {
  return execute(
    "xcrun",
    ["simctl", "get_app_container", udid, bundleId, "data"],
    { optional: true },
  );
}

function prefsDomainPath(udid, bundleId, execute = execText) {
  const container = appDataContainer(udid, bundleId, execute);
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
