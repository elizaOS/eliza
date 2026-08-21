/**
 * Applies deterministic, fail-closed Safari converter patches for the native
 * enrollment handler, entitlements, bundle versions, and signing profiles.
 */
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_APP_GROUP = "group.ai.elizaos.browserbridge";
const DEFAULT_SOCKET_NAME = "b.sock";

function requiredTrimmed(value) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseReleaseFlag(value) {
  if (
    value === undefined ||
    value === "" ||
    value === "0" ||
    value === "false"
  ) {
    return false;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  throw new Error("ELIZA_SAFARI_RELEASE must be 1, true, 0, or false.");
}

function assertIdentifier(name, value, pattern) {
  if (!pattern.test(value)) {
    throw new Error(`${name} has an invalid value.`);
  }
}

export function resolveSafariNativeConfiguration(env = process.env) {
  const signingTeam = requiredTrimmed(env.ELIZA_SAFARI_SIGNING_TEAM);
  const signingIdentity = requiredTrimmed(env.ELIZA_SAFARI_SIGNING_IDENTITY);
  const appProvisioningProfile = requiredTrimmed(
    env.ELIZA_SAFARI_APP_PROVISIONING_PROFILE_SPECIFIER,
  );
  const extensionProvisioningProfile = requiredTrimmed(
    env.ELIZA_SAFARI_EXTENSION_PROVISIONING_PROFILE_SPECIFIER,
  );
  const appGroup =
    requiredTrimmed(env.ELIZA_SAFARI_APP_GROUP) ?? DEFAULT_APP_GROUP;
  const socketName =
    requiredTrimmed(env.ELIZA_SAFARI_BROKER_SOCKET_NAME) ?? DEFAULT_SOCKET_NAME;
  const release = parseReleaseFlag(env.ELIZA_SAFARI_RELEASE);

  if (Boolean(signingTeam) !== Boolean(signingIdentity)) {
    throw new Error(
      "ELIZA_SAFARI_SIGNING_TEAM and ELIZA_SAFARI_SIGNING_IDENTITY must be supplied together.",
    );
  }
  if (
    Boolean(appProvisioningProfile) !== Boolean(extensionProvisioningProfile)
  ) {
    throw new Error(
      "ELIZA_SAFARI_APP_PROVISIONING_PROFILE_SPECIFIER and ELIZA_SAFARI_EXTENSION_PROVISIONING_PROFILE_SPECIFIER must be supplied together.",
    );
  }
  assertIdentifier(
    "ELIZA_SAFARI_APP_GROUP",
    appGroup,
    /^group\.[A-Za-z0-9.-]{3,200}$/,
  );
  if (appGroup !== DEFAULT_APP_GROUP) {
    throw new Error(
      `ELIZA_SAFARI_APP_GROUP must match the desktop broker App Group ${DEFAULT_APP_GROUP}.`,
    );
  }
  assertIdentifier(
    "ELIZA_SAFARI_BROKER_SOCKET_NAME",
    socketName,
    /^[A-Za-z0-9._-]{1,80}$/,
  );
  if (signingTeam && !/^[A-Z0-9]{10}$/.test(signingTeam)) {
    throw new Error(
      "ELIZA_SAFARI_SIGNING_TEAM must be a 10-character Apple team ID.",
    );
  }
  if (release) {
    const missing = [
      ["ELIZA_SAFARI_SIGNING_TEAM", signingTeam],
      ["ELIZA_SAFARI_SIGNING_IDENTITY", signingIdentity],
      ["ELIZA_SAFARI_APP_GROUP", requiredTrimmed(env.ELIZA_SAFARI_APP_GROUP)],
      [
        "ELIZA_SAFARI_APP_PROVISIONING_PROFILE_SPECIFIER",
        appProvisioningProfile,
      ],
      [
        "ELIZA_SAFARI_EXTENSION_PROVISIONING_PROFILE_SPECIFIER",
        extensionProvisioningProfile,
      ],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(
        `Safari release packaging requires explicit signed configuration: ${missing.join(", ")}.`,
      );
    }
  }

  return {
    release,
    signingTeam,
    signingIdentity,
    appProvisioningProfile,
    extensionProvisioningProfile,
    appGroup,
    socketName,
  };
}

function assertProvisionedCodeItem({
  label,
  entitlements,
  profile,
  bundleIdentifier,
  profileSpecifier,
  configuration,
  now,
}) {
  const expectedApplicationIdentifier = `${configuration.signingTeam}.${bundleIdentifier}`;
  const signedGroups = entitlements["com.apple.security.application-groups"];
  const profileEntitlements = profile.Entitlements;
  const profileGroups =
    profileEntitlements?.["com.apple.security.application-groups"];
  const expiresAt = Date.parse(String(profile.ExpirationDate ?? ""));
  if (
    entitlements["com.apple.application-identifier"] !==
      expectedApplicationIdentifier &&
    entitlements["application-identifier"] !== expectedApplicationIdentifier
  ) {
    throw new Error(`${label} signed identity does not match its bundle ID.`);
  }
  if (
    !Array.isArray(signedGroups) ||
    signedGroups.length !== 1 ||
    signedGroups[0] !== configuration.appGroup
  ) {
    throw new Error(
      `${label} signature does not authorize the exact App Group.`,
    );
  }
  if (
    !Array.isArray(profile.TeamIdentifier) ||
    profile.TeamIdentifier.length !== 1 ||
    profile.TeamIdentifier[0] !== configuration.signingTeam ||
    (profile.Name !== profileSpecifier && profile.UUID !== profileSpecifier) ||
    profileEntitlements?.["application-identifier"] !==
      expectedApplicationIdentifier ||
    !Array.isArray(profileGroups) ||
    !profileGroups.includes(configuration.appGroup) ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= now
  ) {
    throw new Error(
      `${label} embedded provisioning profile does not authorize the exact identity and App Group.`,
    );
  }
}

export function validateSafariSignedBundleContracts({
  configuration,
  appEntitlements,
  extensionEntitlements,
  appProfile,
  extensionProfile,
  bundleIdentifier,
  now = Date.now(),
}) {
  if (
    !configuration.release ||
    !configuration.signingTeam ||
    !configuration.appProvisioningProfile ||
    !configuration.extensionProvisioningProfile
  ) {
    throw new Error(
      "Safari signed-bundle validation requires complete release provisioning configuration.",
    );
  }
  assertProvisionedCodeItem({
    label: "Safari containing app",
    entitlements: appEntitlements,
    profile: appProfile,
    bundleIdentifier,
    profileSpecifier: configuration.appProvisioningProfile,
    configuration,
    now,
  });
  assertProvisionedCodeItem({
    label: "Safari extension",
    entitlements: extensionEntitlements,
    profile: extensionProfile,
    bundleIdentifier: `${bundleIdentifier}.Extension`,
    profileSpecifier: configuration.extensionProvisioningProfile,
    configuration,
    now,
  });
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function entitlementPlist(configuration) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.security.application-groups</key>
\t<array>
\t\t<string>${escapeXml(configuration.appGroup)}</string>
\t</array>
</dict>
</plist>
`;
}

function replaceCount(source, pattern, replacement, expected, label) {
  const matches = source.match(pattern) ?? [];
  if (matches.length !== expected) {
    throw new Error(
      `Safari converter layout drifted: expected ${expected} ${label} entries, found ${matches.length}.`,
    );
  }
  return source.replace(pattern, replacement);
}

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function injectRootPlistStrings(source, entries) {
  const closingIndex = source.lastIndexOf("</dict>");
  if (closingIndex < 0) {
    throw new Error("Safari extension Info.plist has no root dictionary.");
  }
  for (const [key] of entries) {
    if (source.includes(`<key>${key}</key>`)) {
      throw new Error(`Safari extension Info.plist already contains ${key}.`);
    }
  }
  const fragment = entries
    .map(
      ([key, value]) =>
        `\t<key>${escapeXml(key)}</key>\n\t<string>${escapeXml(value)}</string>\n`,
    )
    .join("");
  return `${source.slice(0, closingIndex)}${fragment}${source.slice(closingIndex)}`;
}

export async function patchGeneratedSafariProject({
  projectPath,
  appName,
  bundleIdentifier,
  marketingVersion,
  buildVersion,
  deploymentTarget,
  configuration,
  handlerTemplatePath,
}) {
  const projectDirectory = path.dirname(projectPath);
  const extensionDirectory = path.join(
    projectDirectory,
    `${appName} Extension`,
  );
  const appDirectory = path.join(projectDirectory, appName);
  const projectFile = path.join(projectPath, "project.pbxproj");
  const extensionInfoPlist = path.join(extensionDirectory, "Info.plist");
  const generatedHandler = path.join(
    extensionDirectory,
    "SafariWebExtensionHandler.swift",
  );
  const appEntitlements = path.join(appDirectory, `${appName}.entitlements`);
  const extensionEntitlements = path.join(
    extensionDirectory,
    `${appName} Extension.entitlements`,
  );

  await fs.copyFile(handlerTemplatePath, generatedHandler);
  await fs.writeFile(appEntitlements, entitlementPlist(configuration));
  await fs.writeFile(extensionEntitlements, entitlementPlist(configuration));

  let infoSource = await fs.readFile(extensionInfoPlist, "utf8");
  infoSource = injectRootPlistStrings(infoSource, [
    ["BrowserBridgeAppGroup", configuration.appGroup],
    ["BrowserBridgeBrokerSocketName", configuration.socketName],
  ]);
  await fs.writeFile(extensionInfoPlist, infoSource);

  let source = await fs.readFile(projectFile, "utf8");
  source = replaceCount(
    source,
    /MARKETING_VERSION = [^;]+;/g,
    `MARKETING_VERSION = ${marketingVersion};`,
    4,
    "marketing-version",
  );
  source = replaceCount(
    source,
    /CURRENT_PROJECT_VERSION = [^;]+;/g,
    `CURRENT_PROJECT_VERSION = ${buildVersion};`,
    4,
    "build-version",
  );
  source = replaceCount(
    source,
    /MACOSX_DEPLOYMENT_TARGET = [^;]+;/g,
    `MACOSX_DEPLOYMENT_TARGET = ${deploymentTarget};`,
    4,
    "macOS deployment-target",
  );
  source = replaceCount(
    source,
    /PRODUCT_BUNDLE_IDENTIFIER = [^;]+\.Extension;/g,
    `PRODUCT_BUNDLE_IDENTIFIER = ${bundleIdentifier}.Extension;`,
    2,
    "extension bundle-identifier",
  );
  source = replaceCount(
    source,
    /PRODUCT_BUNDLE_IDENTIFIER = (?![^;]+\.Extension;)[^;]+;/g,
    `PRODUCT_BUNDLE_IDENTIFIER = ${bundleIdentifier};`,
    2,
    "app bundle-identifier",
  );
  source = replaceCount(
    source,
    new RegExp(
      `(INFOPLIST_FILE = "${escapeRegularExpression(appName)}/Info\\.plist";)`,
      "g",
    ),
    `$1\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = "${appName}/${appName}.entitlements";${
      configuration.appProvisioningProfile
        ? `\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "${configuration.appProvisioningProfile}";`
        : ""
    }`,
    2,
    "app Info.plist",
  );
  source = replaceCount(
    source,
    new RegExp(
      `(INFOPLIST_FILE = "${escapeRegularExpression(appName)} Extension/Info\\.plist";)`,
      "g",
    ),
    `$1\n\t\t\t\tCODE_SIGN_ENTITLEMENTS = "${appName} Extension/${appName} Extension.entitlements";${
      configuration.extensionProvisioningProfile
        ? `\n\t\t\t\tPROVISIONING_PROFILE_SPECIFIER = "${configuration.extensionProvisioningProfile}";`
        : ""
    }`,
    2,
    "extension Info.plist",
  );

  const projectIds = [...new Set(source.match(/\b[A-F0-9]{24}\b/g) ?? [])];
  if (projectIds.length < 8) {
    throw new Error(
      "Safari converter project did not contain the expected Xcode identifiers.",
    );
  }
  for (const [index, projectId] of projectIds.entries()) {
    const deterministicId = (index + 1)
      .toString(16)
      .toUpperCase()
      .padStart(24, "0");
    source = source.replaceAll(projectId, deterministicId);
  }
  await fs.writeFile(projectFile, source);

  return {
    projectFile,
    generatedHandler,
    appEntitlements,
    extensionEntitlements,
    extensionInfoPlist,
  };
}

export const safariNativeDefaults = Object.freeze({
  appGroup: DEFAULT_APP_GROUP,
  socketName: DEFAULT_SOCKET_NAME,
});
