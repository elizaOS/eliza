import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  LifeOpsBrowserCompanionPackageStatus,
  LifeOpsBrowserCompanionReleaseManifest,
  LifeOpsBrowserKind,
} from "../contracts/lifeops";
import { VERSION } from "@elizaos/agent/runtime";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../",
);
const extensionRootCandidates = [
  path.join(repoRoot, "apps", "app-lifeops", "extensions", "lifeops-browser"),
  path.join(repoRoot, "apps", "extensions", "lifeops-browser"),
];
const repoPackageJsonPath = path.join(repoRoot, "package.json");
const repoBuildInfoPath = path.join(repoRoot, "dist", "build-info.json");
const NIGHTLY_EPOCH_UTC_MS = Date.UTC(2020, 0, 1);
const DEFAULT_REPOSITORY = "eliza-ai/eliza";

function existingPath(candidate: string): string | null {
  return fs.existsSync(candidate) ? candidate : null;
}

function readVersionField(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
    version?: unknown;
  };
  return typeof parsed.version === "string" && parsed.version.trim()
    ? parsed.version.trim()
    : null;
}

function resolveElizaReleaseVersion(): string {
  return (
    readVersionField(repoPackageJsonPath) ||
    readVersionField(repoBuildInfoPath) ||
    VERSION
  );
}

type ReleaseVersion = {
  raw: string;
  tag: string;
  major: number;
  minor: number;
  patch: number;
  prereleaseLabel: string | null;
  prereleaseValue: string | null;
  baseVersion: string;
  hasPrerelease: boolean;
};

function normalizeReleaseVersionCandidate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}

function parseReleaseVersion(raw: string): ReleaseVersion | null {
  const normalized = normalizeReleaseVersionCandidate(raw);
  if (!normalized) {
    return null;
  }
  const match = normalized.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc|nightly)\.([0-9A-Za-z.-]+))?$/,
  );
  if (!match) {
    return null;
  }
  const majorRaw = match[1];
  const minorRaw = match[2];
  const patchRaw = match[3];
  if (!majorRaw || !minorRaw || !patchRaw) {
    return null;
  }
  const major = Number.parseInt(majorRaw, 10);
  const minor = Number.parseInt(minorRaw, 10);
  const patch = Number.parseInt(patchRaw, 10);
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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function parseNumericPrereleaseValue(value: string | null): number {
  if (!value) {
    return 0;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function deriveNightlyOrdinal(value: string | null): number {
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

function derivePrereleaseOrdinal(release: ReleaseVersion): number {
  if (!release.hasPrerelease || !release.prereleaseLabel) {
    return 0;
  }
  if (release.prereleaseLabel === "nightly") {
    return deriveNightlyOrdinal(release.prereleaseValue);
  }
  return clamp(parseNumericPrereleaseValue(release.prereleaseValue), 0, 9999);
}

function buildChromeExtensionVersion(release: ReleaseVersion): string {
  let buildSegment = 60000;
  if (release.hasPrerelease && release.prereleaseLabel) {
    const ordinal = derivePrereleaseOrdinal(release);
    buildSegment =
      release.prereleaseLabel === "rc"
        ? 50000 + ordinal
        : release.prereleaseLabel === "beta"
          ? 40000 + ordinal
          : release.prereleaseLabel === "alpha"
            ? 30000 + ordinal
            : 10000 + ordinal;
  }
  return [release.major, release.minor, release.patch, buildSegment].join(".");
}

function buildSafariExtensionVersions(release: ReleaseVersion): {
  marketingVersion: string;
  buildVersion: string;
} {
  const ordinal = derivePrereleaseOrdinal(release);
  const suffix =
    !release.hasPrerelease || !release.prereleaseLabel
      ? 9000
      : release.prereleaseLabel === "rc"
        ? 8000 + ordinal
        : release.prereleaseLabel === "beta"
          ? 7000 + ordinal
          : release.prereleaseLabel === "alpha"
            ? 6000 + ordinal
            : 5000 + ordinal;

  return {
    marketingVersion: release.baseVersion,
    buildVersion: String(
      release.major * 100_000_000 +
        release.minor * 1_000_000 +
        release.patch * 10_000 +
        suffix,
    ),
  };
}

function versionedArtifactName(
  prefix: string,
  extension: string,
  release: ReleaseVersion,
): string {
  return `${prefix}-${release.tag}.${extension.replace(/^\./, "")}`;
}

function buildGitHubReleasePageUrl(
  repository: string,
  release: ReleaseVersion,
): string {
  return `https://github.com/${repository}/releases/tag/${release.tag}`;
}

function buildGitHubReleaseAssetDownloadUrl(
  repository: string,
  release: ReleaseVersion,
  assetName: string,
): string {
  return `https://github.com/${repository}/releases/download/${release.tag}/${assetName}`;
}

function resolveLifeOpsBrowserStoreUrls(env = process.env): {
  chromeWebStoreUrl: string | null;
  safariAppStoreUrl: string | null;
} {
  const chromeWebStoreUrl =
    typeof env.ELIZA_LIFEOPS_BROWSER_CHROME_STORE_URL === "string" &&
    env.ELIZA_LIFEOPS_BROWSER_CHROME_STORE_URL.trim()
      ? env.ELIZA_LIFEOPS_BROWSER_CHROME_STORE_URL.trim()
      : null;
  const safariAppStoreUrl =
    typeof env.ELIZA_LIFEOPS_BROWSER_SAFARI_STORE_URL === "string" &&
    env.ELIZA_LIFEOPS_BROWSER_SAFARI_STORE_URL.trim()
      ? env.ELIZA_LIFEOPS_BROWSER_SAFARI_STORE_URL.trim()
      : null;
  return {
    chromeWebStoreUrl,
    safariAppStoreUrl,
  };
}

export function buildLifeOpsBrowserReleaseManifestForVersion(
  rawVersion: string,
  env = process.env,
): LifeOpsBrowserCompanionReleaseManifest | null {
  const release = parseReleaseVersion(rawVersion);
  if (!release) {
    return null;
  }
  const repository =
    typeof env.GITHUB_REPOSITORY === "string" && env.GITHUB_REPOSITORY.trim()
      ? env.GITHUB_REPOSITORY.trim()
      : DEFAULT_REPOSITORY;
  const storeUrls = resolveLifeOpsBrowserStoreUrls(env);
  const chromeAssetName = versionedArtifactName(
    "lifeops-browser-chrome",
    "zip",
    release,
  );
  const safariAssetName = versionedArtifactName(
    "lifeops-browser-safari",
    "zip",
    release,
  );
  const safariVersions = buildSafariExtensionVersions(release);
  return {
    schema: "lifeops_browser_release_v2",
    releaseTag: release.tag,
    releaseVersion: release.raw,
    repository,
    releasePageUrl: buildGitHubReleasePageUrl(repository, release),
    chromeVersion: buildChromeExtensionVersion(release),
    chromeVersionName: release.raw,
    safariMarketingVersion: safariVersions.marketingVersion,
    safariBuildVersion: safariVersions.buildVersion,
    chrome: {
      installKind: storeUrls.chromeWebStoreUrl
        ? "chrome_web_store"
        : "github_release",
      installUrl:
        storeUrls.chromeWebStoreUrl ??
        buildGitHubReleaseAssetDownloadUrl(
          repository,
          release,
          chromeAssetName,
        ),
      storeListingUrl: storeUrls.chromeWebStoreUrl,
      asset: {
        fileName: chromeAssetName,
        downloadUrl: buildGitHubReleaseAssetDownloadUrl(
          repository,
          release,
          chromeAssetName,
        ),
      },
    },
    safari: {
      installKind: storeUrls.safariAppStoreUrl
        ? "apple_app_store"
        : "github_release",
      installUrl:
        storeUrls.safariAppStoreUrl ??
        buildGitHubReleaseAssetDownloadUrl(
          repository,
          release,
          safariAssetName,
        ),
      storeListingUrl: storeUrls.safariAppStoreUrl,
      asset: {
        fileName: safariAssetName,
        downloadUrl: buildGitHubReleaseAssetDownloadUrl(
          repository,
          release,
          safariAssetName,
        ),
      },
    },
    generatedAt: new Date().toISOString(),
  };
}

function readReleaseManifest(
  artifactsDir: string,
): LifeOpsBrowserCompanionReleaseManifest | null {
  const manifestPath = path.join(
    artifactsDir,
    "lifeops-browser-release-manifest.json",
  );
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    return JSON.parse(
      fs.readFileSync(manifestPath, "utf8"),
    ) as LifeOpsBrowserCompanionReleaseManifest;
  } catch {
    return null;
  }
}

export function resolveLifeOpsBrowserReleaseManifest(
  artifactsDir: string | null,
  options?: {
    allowSynthesis?: boolean;
    version?: string;
    env?: NodeJS.ProcessEnv;
  },
): LifeOpsBrowserCompanionReleaseManifest | null {
  if (artifactsDir) {
    const releaseManifest = readReleaseManifest(artifactsDir);
    if (releaseManifest) {
      return releaseManifest;
    }
  }
  if (!options?.allowSynthesis) {
    return null;
  }
  return buildLifeOpsBrowserReleaseManifestForVersion(
    options.version ?? resolveElizaReleaseVersion(),
    options.env,
  );
}

function resolveLifeOpsBrowserExtensionRoot(): string | null {
  for (const candidate of extensionRootCandidates) {
    const resolved = existingPath(candidate);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function packageScriptName(browser: LifeOpsBrowserKind): string {
  return browser === "safari" ? "package-safari.mjs" : "package-chrome.mjs";
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          stderr.trim() ||
            `${command} ${args.join(" ")} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

export function resolveLifeOpsBrowserExtensionPath(): string | null {
  return resolveLifeOpsBrowserExtensionRoot();
}

export function resolveLifeOpsBrowserCompanionPackagePath(
  status: LifeOpsBrowserCompanionPackageStatus,
  target: LifeOpsBrowserPackagePathTarget,
): string | null {
  switch (target) {
    case "extension_root":
      return status.extensionPath;
    case "chrome_build":
      return status.chromeBuildPath;
    case "chrome_package":
      return status.chromePackagePath;
    case "safari_web_extension":
      return status.safariWebExtensionPath;
    case "safari_app":
      return status.safariAppPath;
    case "safari_package":
      return status.safariPackagePath;
    default:
      return null;
  }
}

async function openPathInHost(
  pathValue: string,
  revealOnly: boolean,
): Promise<void> {
  const revealDirectory =
    revealOnly &&
    fs.existsSync(pathValue) &&
    fs.statSync(pathValue).isDirectory()
      ? pathValue
      : path.dirname(pathValue);
  switch (process.platform) {
    case "darwin":
      await runCommand(
        "open",
        revealOnly ? ["-R", pathValue] : [pathValue],
        repoRoot,
      );
      return;
    case "win32":
      await runCommand(
        revealOnly ? "explorer.exe" : "cmd",
        revealOnly ? [`/select,${pathValue}`] : ["/c", "start", "", pathValue],
        repoRoot,
      );
      return;
    case "linux":
      await runCommand(
        "xdg-open",
        [revealOnly ? revealDirectory : pathValue],
        repoRoot,
      );
      return;
    default:
      throw new Error(
        `Opening local paths is not supported on ${process.platform}`,
      );
  }
}

async function openChromeExtensionsManager(): Promise<void> {
  switch (process.platform) {
    case "darwin":
      await runCommand(
        "open",
        ["-a", "Google Chrome", "chrome://extensions/"],
        repoRoot,
      );
      return;
    case "win32":
      await runCommand(
        "cmd",
        ["/c", "start", "", "chrome", "chrome://extensions/"],
        repoRoot,
      );
      return;
    case "linux":
      await runCommand("xdg-open", ["chrome://extensions/"], repoRoot);
      return;
    default:
      throw new Error(
        `Opening the Chrome extensions manager is not supported on ${process.platform}`,
      );
  }
}

export function getLifeOpsBrowserCompanionPackageStatus(): LifeOpsBrowserCompanionPackageStatus {
  const resolvedExtensionPath = resolveLifeOpsBrowserExtensionPath();
  if (!resolvedExtensionPath) {
    return {
      extensionPath: null,
      chromeBuildPath: null,
      chromePackagePath: null,
      safariWebExtensionPath: null,
      safariAppPath: null,
      safariPackagePath: null,
      releaseManifest: resolveLifeOpsBrowserReleaseManifest(null, {
        allowSynthesis: true,
      }),
    };
  }

  const distDir = path.join(resolvedExtensionPath, "dist");
  const artifactsDir = path.join(distDir, "artifacts");

  return {
    extensionPath: resolvedExtensionPath,
    chromeBuildPath: existingPath(path.join(distDir, "chrome")),
    chromePackagePath: existingPath(
      path.join(artifactsDir, "lifeops-browser-chrome.zip"),
    ),
    safariWebExtensionPath: existingPath(path.join(distDir, "safari")),
    safariAppPath: existingPath(path.join(artifactsDir, "LifeOps Browser.app")),
    safariPackagePath: existingPath(
      path.join(artifactsDir, "lifeops-browser-safari.zip"),
    ),
    releaseManifest: resolveLifeOpsBrowserReleaseManifest(artifactsDir, {
      allowSynthesis: true,
    }),
  };
}

export function getLifeOpsBrowserCompanionDownloadFile(
  browser: LifeOpsBrowserKind,
): { path: string; filename: string; contentType: string } {
  const status = getLifeOpsBrowserCompanionPackageStatus();
  const filePath =
    browser === "safari" ? status.safariPackagePath : status.chromePackagePath;
  if (!filePath) {
    throw new Error(
      `${browser === "safari" ? "Safari" : "Chrome"} package has not been built yet`,
    );
  }
  return {
    path: filePath,
    filename: path.basename(filePath),
    contentType: "application/zip",
  };
}

export async function openLifeOpsBrowserCompanionPackagePath(
  target: LifeOpsBrowserPackagePathTarget,
  options?: { revealOnly?: boolean },
): Promise<{
  target: LifeOpsBrowserPackagePathTarget;
  path: string;
  revealOnly: boolean;
}> {
  const revealOnly = options?.revealOnly ?? false;
  const status = getLifeOpsBrowserCompanionPackageStatus();
  const resolvedPath = resolveLifeOpsBrowserCompanionPackagePath(
    status,
    target,
  );
  if (!resolvedPath) {
    throw new Error(`LifeOps Browser path is not available for ${target}`);
  }
  await openPathInHost(resolvedPath, revealOnly);
  return {
    target,
    path: resolvedPath,
    revealOnly,
  };
}

export async function openLifeOpsBrowserCompanionManager(
  browser: LifeOpsBrowserKind,
): Promise<{ browser: LifeOpsBrowserKind }> {
  if (browser !== "chrome") {
    throw new Error(
      "Only Chrome exposes a local extensions manager for unpacked install",
    );
  }
  await openChromeExtensionsManager();
  return { browser };
}

export async function buildLifeOpsBrowserCompanionPackage(
  browser: LifeOpsBrowserKind,
): Promise<LifeOpsBrowserCompanionPackageStatus> {
  const resolvedExtensionPath = resolveLifeOpsBrowserExtensionPath();
  if (!resolvedExtensionPath) {
    throw new Error("LifeOps Browser extension workspace is not available");
  }

  await runCommand(
    "bun",
    [path.join(resolvedExtensionPath, "scripts", packageScriptName(browser))],
    resolvedExtensionPath,
  );

  return getLifeOpsBrowserCompanionPackageStatus();
}
