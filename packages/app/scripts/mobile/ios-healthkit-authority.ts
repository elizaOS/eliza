/**
 * Validates the provisioning authority required before an iOS build may
 * publish an enabled HealthKit marker into its native Info.plist.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const REQUIRED_HEALTHKIT_ENTITLEMENTS = Object.freeze([
  "com.apple.developer.healthkit",
  "com.apple.developer.healthkit.background-delivery",
]);

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dictAfterKey(plist, key) {
  const keyMatch = new RegExp(
    `<key>\\s*${escapeRegExp(key)}\\s*</key>`,
    "m",
  ).exec(plist);
  if (!keyMatch) return null;
  const dictStart = plist.indexOf(
    "<dict>",
    keyMatch.index + keyMatch[0].length,
  );
  if (dictStart === -1) return null;
  const tokenPattern = /<\/?dict>/g;
  tokenPattern.lastIndex = dictStart;
  let depth = 0;
  for (
    let match = tokenPattern.exec(plist);
    match;
    match = tokenPattern.exec(plist)
  ) {
    depth += match[0] === "<dict>" ? 1 : -1;
    if (depth === 0) return plist.slice(dictStart, tokenPattern.lastIndex);
  }
  return null;
}

function plistBooleanIsTrue(plist, key) {
  return new RegExp(
    `<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<true\\s*/>`,
    "m",
  ).test(plist);
}

function plistString(plist, key) {
  const match = new RegExp(
    `<key>\\s*${escapeRegExp(key)}\\s*</key>\\s*<string>\\s*([^<]+?)\\s*</string>`,
    "m",
  ).exec(plist);
  return match?.[1]?.trim() ?? null;
}

function decodeProvisioningProfile(profilePath, run = spawnSync) {
  if (!profilePath || !fs.existsSync(profilePath)) {
    throw new Error(
      `HealthKit provisioning profile does not exist: ${profilePath ?? "(not set)"}`,
    );
  }
  const raw = fs.readFileSync(profilePath);
  const text = raw.toString("utf8");
  if (text.includes("<plist")) return text;
  if (process.platform !== "darwin") {
    throw new Error(
      "Binary HealthKit provisioning profiles require macOS security cms decoding",
    );
  }
  const result = run("security", ["cms", "-D", "-i", profilePath], {
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout?.includes("<plist")) {
    throw new Error(
      result.stderr?.trim() ||
        `security cms could not decode HealthKit provisioning profile ${profilePath}`,
    );
  }
  return result.stdout;
}

/**
 * An enabled marker is trustworthy only when an explicit profile proves that
 * the current bundle receives both HealthKit entitlements. Disabled builds do
 * not need signing material and remain the safe default.
 */
export function assertIosHealthKitBuildAuthority({
  enabled,
  appId,
  provisioningProfilePath,
  run,
}) {
  if (!enabled) return;
  if (typeof appId !== "string" || appId.trim().length === 0) {
    throw new Error("HealthKit build authority requires the iOS app id");
  }
  if (!provisioningProfilePath) {
    throw new Error(
      "ELIZA_IOS_HEALTHKIT_ENABLED=1 requires MOBILE_SIGNALS_IOS_PROVISIONING_PROFILE so signed HealthKit authority can be verified",
    );
  }
  const profile = decodeProvisioningProfile(provisioningProfilePath, run);
  const entitlements = dictAfterKey(profile, "Entitlements");
  if (!entitlements) {
    throw new Error(
      "HealthKit provisioning profile has no Entitlements dictionary",
    );
  }
  const missing = REQUIRED_HEALTHKIT_ENTITLEMENTS.filter(
    (key) => !plistBooleanIsTrue(entitlements, key),
  );
  if (missing.length > 0) {
    throw new Error(
      `HealthKit provisioning profile is missing required entitlements: ${missing.join(", ")}`,
    );
  }
  const applicationIdentifier = plistString(
    entitlements,
    "application-identifier",
  );
  if (
    !applicationIdentifier ||
    (applicationIdentifier !== appId &&
      !applicationIdentifier.endsWith(`.${appId}`))
  ) {
    throw new Error(
      `HealthKit provisioning profile application-identifier ${JSON.stringify(applicationIdentifier)} does not match ${appId}`,
    );
  }
}
