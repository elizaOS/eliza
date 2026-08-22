#!/usr/bin/env bun
/**
 * Assembles the store-listing bundle — screenshots, descriptions, and
 * release-metadata JSON — for the Chrome, Firefox, and Safari store submissions.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBrowserBridgeReleaseMetadata,
  buildGitHubReleasePageUrl,
  resolveBrowserBridgeReleaseRepository,
  resolveBrowserBridgeReleaseVersion,
  resolveBrowserBridgeStoreUrls,
  resolveSourceDateIso,
  versionedArtifactName,
} from "./release-version.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const artifactsDir = path.join(extensionRoot, "dist", "artifacts");
const release = resolveBrowserBridgeReleaseVersion();
const repository = resolveBrowserBridgeReleaseRepository();
const metadata = buildBrowserBridgeReleaseMetadata(release);
const storeUrls = resolveBrowserBridgeStoreUrls();

function envValue(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const marketingUrl =
  envValue("ELIZA_BROWSER_BRIDGE_MARKETING_URL") ??
  (repository ? `https://github.com/${repository}` : null);
const supportUrl =
  envValue("ELIZA_BROWSER_BRIDGE_SUPPORT_URL") ??
  (repository ? `https://github.com/${repository}/issues` : null);
const privacyPolicyUrl =
  envValue("ELIZA_BROWSER_BRIDGE_PRIVACY_POLICY_URL") ?? null;

const chromePackageFile = versionedArtifactName(
  "browser-bridge-chrome",
  "zip",
  release,
);
const firefoxPackageFile = versionedArtifactName(
  "browser-bridge-firefox",
  "xpi",
  release,
);
const safariPackageFile = versionedArtifactName(
  "browser-bridge-safari",
  "zip",
  release,
);
const safariProjectFile = versionedArtifactName(
  "browser-bridge-safari-project",
  "zip",
  release,
);

const sharedSubmissionData = {
  schema: "browser_bridge_store_submission_v1",
  releaseTag: release.tag,
  releaseVersion: release.raw,
  releasePageUrl: buildGitHubReleasePageUrl(repository, release),
  repository,
  marketingUrl,
  supportUrl,
  privacyPolicyUrl,
  generatedAt: resolveSourceDateIso(),
};

const chromeSubmission = {
  ...sharedSubmissionData,
  browser: "chrome",
  title: "Agent Browser Bridge",
  category: "Productivity",
  shortDescription:
    "Connect your real browser to your Eliza agent so it can read the page you are on and carry out owner-approved actions.",
  description:
    "Agent Browser Bridge securely enrolls your Chrome profile through the authenticated native Eliza app. It keeps the current page available to the agent and can execute owner-approved browser actions such as opening tabs, navigating, clicking, typing, and reading page content. Pairing JSON import remains available only as an explicit recovery path.",
  packageFileName: chromePackageFile,
  version: metadata.chromeVersion,
  versionName: metadata.chromeVersionName,
  storeListingUrl: storeUrls.chromeWebStoreUrl,
  permissions: [
    {
      name: "tabs",
      justification:
        "The agent needs tab URLs, titles, focus state, and window information so it can reflect the active browser context back to the user.",
    },
    {
      name: "storage",
      justification:
        "The extension stores the companion pairing, sync status, and local settings between browser restarts.",
    },
    {
      name: "scripting",
      justification:
        "The extension performs DOM reads and owner-approved DOM actions on the active page when the user explicitly enables browser control.",
    },
    {
      name: "alarms",
      justification:
        "The extension uses periodic alarms to keep browser state synced even when the popup is closed.",
    },
    {
      name: "activeTab",
      justification:
        "The agent uses active-tab access to inspect or act on the page the user is currently focused on.",
    },
    {
      name: "declarativeNetRequestWithHostAccess",
      justification:
        "After the user grants website access, the extension uses host-level redirect rules for sites selected by the LifeOps website blocker.",
    },
    {
      name: "<all_urls>",
      justification:
        "This is optional at install and requested only from the popup's Grant Website Access button. It enables cross-site control and website blocking while the app still applies its own site-access settings.",
    },
  ],
  reviewerNotes: [
    "With the signed Eliza desktop app running and authenticated, the extension enrolls automatically through the browser native-messaging channel; pairing JSON import is a recovery-only fallback.",
    "Browser control is disabled by default unless the user enables it in agent settings.",
    "The retired zero-config auto-pair endpoint returns 410 and never mints credentials from loopback reachability or an extension Origin.",
  ],
};

const safariSubmission = {
  ...sharedSubmissionData,
  browser: "safari",
  appName: "Agent Browser Bridge",
  bundleIdentifier: "ai.elizaos.browserbridge.app",
  category: "Productivity",
  subtitle: "Owner-approved browser relay for Eliza agents",
  description:
    "Agent Browser Bridge pairs your Safari profile with an Eliza agent so the agent can reflect the page you are on and, when you explicitly allow it, carry out owner-approved browser actions. The packaged Safari release includes both the signed app bundle target and the generated Xcode project archive required for App Store submission.",
  packageFileName: safariPackageFile,
  xcodeProjectArchiveFileName: safariProjectFile,
  marketingVersion: metadata.safariMarketingVersion,
  buildVersion: metadata.safariBuildVersion,
  storeListingUrl: storeUrls.safariAppStoreUrl,
  capabilities: [
    "Safari Web Extension",
    "Automatic enrollment through the authenticated containing Eliza app",
    "Authenticated pairing JSON import as an explicit recovery path",
    "Optional browser control for owner-approved sessions",
  ],
  reviewerNotes: [
    "The app bundle is generated from the same extension source as Chrome and is intended for App Store signing/export downstream.",
    "Privacy policy URL is required before submission if it is still null in this artifact.",
    "Reviewers should launch and authenticate the signed Eliza containing app; the Safari extension then enrolls automatically through the App Group broker. Pairing JSON import is available only for recovery.",
  ],
};

const firefoxSubmission = {
  ...sharedSubmissionData,
  browser: "firefox",
  title: "Agent Browser Bridge",
  category: "productivity",
  summary:
    "Connect Firefox to an Eliza agent for owner-approved page reading and browser actions.",
  description:
    "Agent Browser Bridge pairs a Firefox profile with an Eliza agent. It syncs the current browser context and can run owner-approved actions including navigation, clicking, typing, and structured page extraction. Broad site access remains optional and is requested at runtime.",
  packageFileName: firefoxPackageFile,
  version: metadata.chromeVersion,
  storeListingUrl: storeUrls.firefoxAddonsUrl,
  permissions: chromeSubmission.permissions,
  dataCollectionPermissions: { required: ["none"] },
  reviewerNotes: [
    "The package declares a stable Gecko extension ID and supports Firefox 142 or later.",
    "With the authenticated Eliza desktop app running, Firefox enrolls automatically through native messaging. Pairing JSON import is retained only as a recovery path.",
    "The package passes web-ext lint in self-hosted mode with no errors, warnings, or notices.",
  ],
};

const checklistLines = [
  "# Agent Browser Bridge Store Submission Checklist",
  "",
  `Release: ${release.tag}`,
  "",
  "## Chrome Web Store",
  "",
  `- Upload package: \`${chromePackageFile}\``,
  `- Version: \`${metadata.chromeVersion}\` (\`${metadata.chromeVersionName}\`)`,
  `- Support URL: ${supportUrl ?? "REQUIRED: set ELIZA_BROWSER_BRIDGE_SUPPORT_URL"}`,
  `- Privacy policy URL: ${privacyPolicyUrl ?? "REQUIRED: set ELIZA_BROWSER_BRIDGE_PRIVACY_POLICY_URL"}`,
  `- Marketing URL: ${marketingUrl ?? "Optional"}`,
  `- Store listing URL: ${storeUrls.chromeWebStoreUrl ?? "Not configured yet"}`,
  "",
  "## Safari App Store",
  "",
  `- Upload signed app derived from: \`${safariPackageFile}\``,
  `- Generated Xcode project archive: \`${safariProjectFile}\``,
  `- Marketing version: \`${metadata.safariMarketingVersion}\``,
  `- Build version: \`${metadata.safariBuildVersion}\``,
  `- Bundle identifier: \`ai.elizaos.browserbridge.app\``,
  `- Support URL: ${supportUrl ?? "REQUIRED: set ELIZA_BROWSER_BRIDGE_SUPPORT_URL"}`,
  `- Privacy policy URL: ${privacyPolicyUrl ?? "REQUIRED: set ELIZA_BROWSER_BRIDGE_PRIVACY_POLICY_URL"}`,
  `- App Store URL: ${storeUrls.safariAppStoreUrl ?? "Not configured yet"}`,
  "",
  "## Firefox Add-ons",
  "",
  `- Upload package: \`${firefoxPackageFile}\``,
  `- Version: \`${metadata.chromeVersion}\` (\`${release.raw}\`)`,
  `- Support URL: ${supportUrl ?? "REQUIRED: set ELIZA_BROWSER_BRIDGE_SUPPORT_URL"}`,
  `- Privacy policy URL: ${privacyPolicyUrl ?? "REQUIRED: set ELIZA_BROWSER_BRIDGE_PRIVACY_POLICY_URL"}`,
  `- Add-ons listing URL: ${storeUrls.firefoxAddonsUrl ?? "Not configured yet"}`,
  "",
  "## Notes",
  "",
  "- Authenticated native enrollment through the signed Eliza desktop app is the primary credential setup flow; pairing JSON import is recovery-only.",
  "- The retired unauthenticated HTTP loopback auto-pair endpoint remains disabled and cannot mint credentials.",
  "- Re-sign the Safari app bundle and export through App Store Connect before submission.",
  "- Review the JSON metadata files in this artifacts directory for permission text and reviewer notes.",
  "",
];

await fs.mkdir(artifactsDir, { recursive: true });

const outputs = [
  {
    fileName: "browser-bridge-chrome-store-metadata.json",
    contents: `${JSON.stringify(chromeSubmission, null, 2)}\n`,
  },
  {
    fileName: versionedArtifactName(
      "browser-bridge-chrome-store-metadata",
      "json",
      release,
    ),
    contents: `${JSON.stringify(chromeSubmission, null, 2)}\n`,
  },
  {
    fileName: "browser-bridge-firefox-store-metadata.json",
    contents: `${JSON.stringify(firefoxSubmission, null, 2)}\n`,
  },
  {
    fileName: versionedArtifactName(
      "browser-bridge-firefox-store-metadata",
      "json",
      release,
    ),
    contents: `${JSON.stringify(firefoxSubmission, null, 2)}\n`,
  },
  {
    fileName: "browser-bridge-safari-store-metadata.json",
    contents: `${JSON.stringify(safariSubmission, null, 2)}\n`,
  },
  {
    fileName: versionedArtifactName(
      "browser-bridge-safari-store-metadata",
      "json",
      release,
    ),
    contents: `${JSON.stringify(safariSubmission, null, 2)}\n`,
  },
  {
    fileName: "browser-bridge-store-checklist.md",
    contents: checklistLines.join("\n"),
  },
  {
    fileName: versionedArtifactName(
      "browser-bridge-store-checklist",
      "md",
      release,
    ),
    contents: checklistLines.join("\n"),
  },
];

for (const output of outputs) {
  await fs.writeFile(path.join(artifactsDir, output.fileName), output.contents);
}

console.log(
  `Wrote Agent Browser Bridge store metadata and checklist artifacts to ${artifactsDir}`,
);
