#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const extensionPackageJsonPath = path.join(extensionRoot, "package.json");
const NIGHTLY_EPOCH_UTC_MS = Date.UTC(2020, 0, 1);
const DEFAULT_REPOSITORY = "elizaos/eliza";

function readExtensionPackageVersion() {
  const packageJson = JSON.parse(
    fs.readFileSync(extensionPackageJsonPath, "utf8"),
  );
  return typeof packageJson.version === "string" && packageJson.version.trim()
    ? packageJson.version.trim()
    : "0.1.0";
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeReleaseVersionCandidate(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

export function parseReleaseVersion(raw) {
  const normalized = normalizeReleaseVersionCandidate(raw);
  if (!normalized) {
    throw new Error("Release version is required");
  }
  const match = normalized.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-(beta|rc|nightly)\.([0-9A-Za-z.-]+))?$/,
  );
  if (!match) {
    throw new Error(
      `Unsupported Agent Browser Bridge release version "${raw}". Expected 1.2.3 or 1.2.3-beta.0 style semver.`,
    );
  }
  const major = Number.parseInt(match[1], 10);
  const minor = Number.parseInt(match[2], 10);
  const patch = Number.parseInt(match[3], 10);
  const prereleaseLabel = match[4] ?? null;
  const prereleaseValue = match[5] ?? null;

  return {
    raw: normalized,
    tag: `v${normalized}`,
    major,
    minor,
    patch,
    prereleaseLabel,
    prereleaseValue,
    baseVersion: `${major}.${minor}.${patch}`,
    hasPrerelease: prereleaseLabel !== null,
  };
}

export function resolveBrowserBridgeReleaseVersion(env = process.env) {
  const candidate =
    normalizeReleaseVersionCandidate(env.ELIZA_RELEASE_TAG) ??
    normalizeReleaseVersionCandidate(env.RELEASE_VERSION) ??
    normalizeReleaseVersionCandidate(env.npm_package_version) ??
    readExtensionPackageVersion();
  return parseReleaseVersion(candidate);
}

export function resolveBrowserBridgeReleaseRepository(env = process.env) {
  const raw =
    typeof env.GITHUB_REPOSITORY === "string"
      ? env.GITHUB_REPOSITORY.trim()
      : "";
  return raw || DEFAULT_REPOSITORY;
}

function parseNumericPrereleaseValue(value) {
  if (!value) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function deriveNightlyOrdinal(value) {
  if (typeof value === "string" && /^\d{8}$/.test(value)) {
    const year = Number.parseInt(value.slice(0, 4), 10);
    const month = Number.parseInt(value.slice(4, 6), 10);
    const day = Number.parseInt(value.slice(6, 8), 10);
    const utcMs = Date.UTC(year, month - 1, day);
    if (Number.isFinite(utcMs)) {
      return clamp(
        Math.floor((utcMs - NIGHTLY_EPOCH_UTC_MS) / 86_400_000) + 1,
        1,
        9999,
      );
    }
  }

  const parsed = parseNumericPrereleaseValue(value);
  if (parsed > 0) {
    return clamp(parsed, 1, 9999);
  }

  let hash = 0;
  for (const character of String(value ?? "")) {
    hash = (hash * 33 + character.charCodeAt(0)) % 9999;
  }
  return clamp(hash, 1, 9999);
}

function derivePrereleaseOrdinal(release) {
  if (!release.hasPrerelease || !release.prereleaseLabel) {
    return 0;
  }
  if (release.prereleaseLabel === "nightly") {
    return deriveNightlyOrdinal(release.prereleaseValue);
  }
  return clamp(parseNumericPrereleaseValue(release.prereleaseValue), 0, 9999);
}

function deriveChromeBuildSegment(release) {
  if (!release.hasPrerelease || !release.prereleaseLabel) {
    return 60000;
  }

  const ordinal = derivePrereleaseOrdinal(release);
  switch (release.prereleaseLabel) {
    case "rc":
      return 50000 + ordinal;
    case "beta":
      return 40000 + ordinal;
    case "nightly":
      return 10000 + ordinal;
    default:
      return 20000 + ordinal;
  }
}

export function buildChromeExtensionVersion(release) {
  return [
    release.major,
    release.minor,
    release.patch,
    deriveChromeBuildSegment(release),
  ].join(".");
}

export function buildSafariExtensionVersions(release) {
  const ordinal = derivePrereleaseOrdinal(release);
  const suffix =
    !release.hasPrerelease || !release.prereleaseLabel
      ? 9000
      : release.prereleaseLabel === "rc"
        ? 8000 + ordinal
        : release.prereleaseLabel === "beta"
          ? 7000 + ordinal
          : 5000 + ordinal;

  const buildVersion =
    release.major * 100_000_000 +
    release.minor * 1_000_000 +
    release.patch * 10_000 +
    suffix;

  return {
    marketingVersion: release.baseVersion,
    buildVersion: String(buildVersion),
  };
}

export function buildBrowserBridgeReleaseMetadata(release) {
  const chromeVersion = buildChromeExtensionVersion(release);
  const safari = buildSafariExtensionVersions(release);
  return {
    schema: "browser_bridge_release_v2",
    releaseTag: release.tag,
    releaseVersion: release.raw,
    chromeVersion,
    chromeVersionName: release.raw,
    safariMarketingVersion: safari.marketingVersion,
    safariBuildVersion: safari.buildVersion,
  };
}

export function versionedArtifactName(prefix, extension, release) {
  return `${prefix}-${release.tag}.${extension.replace(/^\./, "")}`;
}

export function buildGitHubReleasePageUrl(repository, release) {
  if (!repository) {
    return null;
  }
  return `https://github.com/${repository}/releases/tag/${release.tag}`;
}

export function buildGitHubReleaseAssetDownloadUrl(
  repository,
  release,
  assetName,
) {
  if (!repository || !assetName) {
    return null;
  }
  return `https://github.com/${repository}/releases/download/${release.tag}/${assetName}`;
}

export function resolveBrowserBridgeStoreUrls(env = process.env) {
  const chromeWebStoreUrl =
    typeof env.ELIZA_BROWSER_BRIDGE_CHROME_STORE_URL === "string" &&
    env.ELIZA_BROWSER_BRIDGE_CHROME_STORE_URL.trim()
      ? env.ELIZA_BROWSER_BRIDGE_CHROME_STORE_URL.trim()
      : null;
  const safariAppStoreUrl =
    typeof env.ELIZA_BROWSER_BRIDGE_SAFARI_STORE_URL === "string" &&
    env.ELIZA_BROWSER_BRIDGE_SAFARI_STORE_URL.trim()
      ? env.ELIZA_BROWSER_BRIDGE_SAFARI_STORE_URL.trim()
      : null;
  return {
    chromeWebStoreUrl,
    safariAppStoreUrl,
  };
}
