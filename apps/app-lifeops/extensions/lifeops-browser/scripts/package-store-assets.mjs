#!/usr/bin/env bun
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildGitHubReleasePageUrl,
  buildLifeOpsBrowserReleaseMetadata,
  resolveLifeOpsBrowserReleaseRepository,
  resolveLifeOpsBrowserReleaseVersion,
  resolveLifeOpsBrowserStoreUrls,
  versionedArtifactName,
} from "./release-version.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(scriptDir, "..");
const artifactsDir = path.join(extensionRoot, "dist", "artifacts");
const release = resolveLifeOpsBrowserReleaseVersion();
const repository = resolveLifeOpsBrowserReleaseRepository();
const metadata = buildLifeOpsBrowserReleaseMetadata(release);
const storeUrls = resolveLifeOpsBrowserStoreUrls();

function envValue(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const marketingUrl =
  envValue("ELIZA_LIFEOPS_BROWSER_MARKETING_URL") ??
  (repository ? `https://github.com/${repository}` : null);
const supportUrl =
  envValue("ELIZA_LIFEOPS_BROWSER_SUPPORT_URL") ??
  (repository ? `https://github.com/${repository}/issues` : null);
const privacyPolicyUrl =
  envValue("ELIZA_LIFEOPS_BROWSER_PRIVACY_POLICY_URL") ?? null;

const chromePackageFile = versionedArtifactName(
  "lifeops-browser-chrome",
  "zip",
  release,
);
const safariPackageFile = versionedArtifactName(
  "lifeops-browser-safari",
  "zip",
  release,
);
const safariProjectFile = versionedArtifactName(
  "lifeops-browser-safari-project",
  "zip",
  release,
);

const sharedSubmissionData = {
  schema: "lifeops_browser_store_submission_v1",
  releaseTag: release.tag,
  releaseVersion: release.raw,
  releasePageUrl: buildGitHubReleasePageUrl(repository, release),
  repository,
  marketingUrl,
  supportUrl,
  privacyPolicyUrl,
  generatedAt: new Date().toISOString(),
};

const chromeSubmission = {
  ...sharedSubmissionData,
  browser: "chrome",
  title: "LifeOps Browser",
  category: "Productivity",
  shortDescription:
    "Connect your real browser to LifeOps so it can read the page you are on and carry out owner-approved actions.",
  description:
    "LifeOps Browser pairs your personal Chrome profile with LifeOps. It keeps the current page available to the app and can execute owner-approved browser actions such as opening tabs, navigating, clicking, typing, and reading page content. Automatic pairing is built in for local and cloud-hosted LifeOps apps.",
  packageFileName: chromePackageFile,
  version: metadata.chromeVersion,
  versionName: metadata.chromeVersionName,
  storeListingUrl: storeUrls.chromeWebStoreUrl,
  permissions: [
    {
      name: "tabs",
      justification:
        "LifeOps needs tab URLs, titles, focus state, and window information so it can reflect the active browser context back to the user.",
    },
    {
      name: "storage",
      justification:
        "The extension stores the companion pairing, sync status, and local settings between browser restarts.",
    },
    {
      name: "scripting",
      justification:
        "LifeOps performs DOM reads and owner-approved DOM actions on the active page when the user explicitly enables browser control.",
    },
    {
      name: "alarms",
      justification:
        "LifeOps uses periodic alarms to keep browser state synced even when the popup is closed.",
    },
    {
      name: "activeTab",
      justification:
        "LifeOps uses active-tab access to inspect or act on the page the user is currently focused on.",
    },
    {
      name: "declarativeNetRequest",
      justification:
        "LifeOps uses dynamic blocking rules for the website blocker feature.",
    },
    {
      name: "declarativeNetRequestWithHostAccess",
      justification:
        "LifeOps needs host-level redirect rules so website blocking can work on the sites the user chooses to block.",
    },
    {
      name: "<all_urls>",
      justification:
        "LifeOps must be able to see whichever page the user is currently working in, not a fixed site list. The app still filters and respects its own site-access settings.",
    },
  ],
  reviewerNotes: [
    "Automatic pairing only binds the extension to a LifeOps app the user can already reach in this browser profile.",
    "Browser control is disabled by default unless the user enables it in LifeOps settings.",
    "Manual pairing JSON remains available as a fallback but is no longer required for normal setup.",
  ],
};

const safariSubmission = {
  ...sharedSubmissionData,
  browser: "safari",
  appName: "LifeOps Browser",
  bundleIdentifier: "ai.lifeops.browser",
  category: "Productivity",
  subtitle: "Owner-approved browser relay for LifeOps",
  description:
    "LifeOps Browser pairs your Safari profile with LifeOps so the app can reflect the page you are on and, when you explicitly allow it, carry out owner-approved browser actions. The packaged Safari release includes both the signed app bundle target and the generated Xcode project archive required for App Store submission.",
  packageFileName: safariPackageFile,
  xcodeProjectArchiveFileName: safariProjectFile,
  marketingVersion: metadata.safariMarketingVersion,
  buildVersion: metadata.safariBuildVersion,
  storeListingUrl: storeUrls.safariAppStoreUrl,
  capabilities: [
    "Safari Web Extension",
    "Automatic pairing with local or logged-in cloud LifeOps apps",
    "Optional browser control for owner-approved sessions",
  ],
  reviewerNotes: [
    "The app bundle is generated from the same extension source as Chrome and is intended for App Store signing/export downstream.",
    "Privacy policy URL is required before submission if it is still null in this artifact.",
    "Reviewers should exercise the automatic pairing flow by opening the LifeOps app in Safari and then opening the extension popup.",
  ],
};

const checklistLines = [
  "# LifeOps Browser Store Submission Checklist",
  "",
  `Release: ${release.tag}`,
  "",
  "## Chrome Web Store",
  "",
  `- Upload package: \`${chromePackageFile}\``,
  `- Version: \`${metadata.chromeVersion}\` (\`${metadata.chromeVersionName}\`)`,
  `- Support URL: ${supportUrl ?? "REQUIRED: set ELIZA_LIFEOPS_BROWSER_SUPPORT_URL"}`,
  `- Privacy policy URL: ${privacyPolicyUrl ?? "REQUIRED: set ELIZA_LIFEOPS_BROWSER_PRIVACY_POLICY_URL"}`,
  `- Marketing URL: ${marketingUrl ?? "Optional"}`,
  `- Store listing URL: ${storeUrls.chromeWebStoreUrl ?? "Not configured yet"}`,
  "",
  "## Safari App Store",
  "",
  `- Upload signed app derived from: \`${safariPackageFile}\``,
  `- Generated Xcode project archive: \`${safariProjectFile}\``,
  `- Marketing version: \`${metadata.safariMarketingVersion}\``,
  `- Build version: \`${metadata.safariBuildVersion}\``,
  `- Bundle identifier: \`ai.lifeops.browser\``,
  `- Support URL: ${supportUrl ?? "REQUIRED: set ELIZA_LIFEOPS_BROWSER_SUPPORT_URL"}`,
  `- Privacy policy URL: ${privacyPolicyUrl ?? "REQUIRED: set ELIZA_LIFEOPS_BROWSER_PRIVACY_POLICY_URL"}`,
  `- App Store URL: ${storeUrls.safariAppStoreUrl ?? "Not configured yet"}`,
  "",
  "## Notes",
  "",
  "- Automatic pairing is the primary setup flow; manual JSON import is fallback only.",
  "- Re-sign the Safari app bundle and export through App Store Connect before submission.",
  "- Review the JSON metadata files in this artifacts directory for permission text and reviewer notes.",
  "",
];

await fs.mkdir(artifactsDir, { recursive: true });

const outputs = [
  {
    fileName: "lifeops-browser-chrome-store-metadata.json",
    contents: `${JSON.stringify(chromeSubmission, null, 2)}\n`,
  },
  {
    fileName: versionedArtifactName(
      "lifeops-browser-chrome-store-metadata",
      "json",
      release,
    ),
    contents: `${JSON.stringify(chromeSubmission, null, 2)}\n`,
  },
  {
    fileName: "lifeops-browser-safari-store-metadata.json",
    contents: `${JSON.stringify(safariSubmission, null, 2)}\n`,
  },
  {
    fileName: versionedArtifactName(
      "lifeops-browser-safari-store-metadata",
      "json",
      release,
    ),
    contents: `${JSON.stringify(safariSubmission, null, 2)}\n`,
  },
  {
    fileName: "lifeops-browser-store-checklist.md",
    contents: checklistLines.join("\n"),
  },
  {
    fileName: versionedArtifactName(
      "lifeops-browser-store-checklist",
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
  `Wrote LifeOps Browser store metadata and checklist artifacts to ${artifactsDir}`,
);
