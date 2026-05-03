#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRawGitHubAssetBase } from "./lib/asset-cdn.mjs";

const REPOSITORY = "elizaos/eliza";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// SCRIPT_DIR is packages/app-core/scripts; the repo root is three levels up.
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const OUTPUT_PATH = path.resolve(
  REPO_ROOT,
  "packages/homepage/src/generated/release-data.ts",
);
const RELEASES_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=20`;
const RELEASES_PAGE_URL = `https://github.com/${REPOSITORY}/releases`;

const installBaseUrl = "https://eliza.ai";
const scripts = {
  shell: {
    url: `${installBaseUrl}/install.sh`,
    command: `curl -fsSL ${installBaseUrl}/install.sh | bash`,
  },
  powershell: {
    url: `${installBaseUrl}/install.ps1`,
    command: `irm ${installBaseUrl}/install.ps1 | iex`,
  },
};

const publishedAtFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "size unavailable";
  }

  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  const decimals = unitIndex === 0 ? 0 : 1;
  return `${size.toFixed(decimals)} ${units[unitIndex]}`;
}

function noteForAsset(name) {
  if (/\.dmg$/i.test(name)) {
    return "DMG installer";
  }
  if (/\.msix$/i.test(name)) {
    return "MSIX package";
  }
  if (/\.exe$/i.test(name)) {
    return "Windows installer";
  }
  if (/\.zip$/i.test(name)) {
    return "ZIP package";
  }
  if (/\.appimage$/i.test(name)) {
    return "AppImage";
  }
  if (/\.deb$/i.test(name)) {
    return "Debian package";
  }
  if (/\.tar\.gz$/i.test(name)) {
    return "tar.gz package";
  }
  return "Release asset";
}

function sortReleasesByRecency(releases) {
  return [...releases]
    .filter((release) => !release.draft)
    .sort((a, b) => {
      const aTime = Date.parse(a.published_at ?? a.created_at ?? 0);
      const bTime = Date.parse(b.published_at ?? b.created_at ?? 0);
      return bTime - aTime;
    });
}

function pickRelease(releases) {
  const published = sortReleasesByRecency(releases);
  // Pick the most recent release that has downloadable assets
  return (
    published.find((r) => Array.isArray(r.assets) && r.assets.length > 0) ??
    published[0] ??
    null
  );
}

function pickStableRelease(releases) {
  const stable = sortReleasesByRecency(releases).filter((r) => !r.prerelease);
  return (
    stable.find((r) => Array.isArray(r.assets) && r.assets.length > 0) ??
    stable[0] ??
    null
  );
}

function pickCanaryRelease(releases) {
  const canary = sortReleasesByRecency(releases).filter((r) => r.prerelease);
  return (
    canary.find((r) => Array.isArray(r.assets) && r.assets.length > 0) ??
    canary[0] ??
    null
  );
}

function pickAsset(assets, matchers) {
  for (const matcher of matchers) {
    const asset = assets.find(matcher);
    if (asset) {
      return asset;
    }
  }
  return null;
}

function serializeDownload(id, label, asset) {
  return {
    id,
    label,
    fileName: asset.name,
    url: asset.browser_download_url,
    sizeLabel: formatBytes(asset.size ?? 0),
    note: noteForAsset(asset.name),
  };
}

function pickAssetFromReleases(releases, matchers) {
  for (const release of releases) {
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = pickAsset(assets, matchers);
    if (asset) {
      return asset;
    }
  }
  return null;
}

function buildRelease(release, allReleases = []) {
  if (!release) {
    return {
      tagName: "unavailable",
      publishedAtLabel: "unavailable",
      prerelease: false,
      url: RELEASES_PAGE_URL,
      downloads: [],
      checksum: null,
    };
  }

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const releasesByRecency = sortReleasesByRecency(allReleases);
  const prioritizedReleases = [
    release,
    ...releasesByRecency.filter((candidate) => candidate !== release),
  ].filter(Boolean);

  const downloads = [
    {
      id: "macos-arm64",
      label: "macOS (Apple Silicon)",
      asset: pickAssetFromReleases(prioritizedReleases, [
        (asset) =>
          /macos-arm64/i.test(asset.name) && /\.dmg$/i.test(asset.name),
        (asset) => /arm64/i.test(asset.name) && /\.dmg$/i.test(asset.name),
      ]),
    },
    {
      id: "macos-x64",
      label: "macOS (Intel)",
      asset: pickAssetFromReleases(prioritizedReleases, [
        (asset) => /macos-x64/i.test(asset.name) && /\.dmg$/i.test(asset.name),
        (asset) =>
          /mac/i.test(asset.name) &&
          !/arm64/i.test(asset.name) &&
          /\.dmg$/i.test(asset.name),
      ]),
    },
    {
      id: "windows-x64",
      label: "Windows",
      asset: pickAssetFromReleases(prioritizedReleases, [
        (asset) => /setup/i.test(asset.name) && /\.exe$/i.test(asset.name),
        (asset) => /win/i.test(asset.name) && /\.exe$/i.test(asset.name),
        (asset) => /win/i.test(asset.name) && /\.msix$/i.test(asset.name),
      ]),
    },
    {
      id: "linux-x64",
      label: "Linux",
      asset: pickAssetFromReleases(prioritizedReleases, [
        (asset) => /linux/i.test(asset.name) && /\.appimage$/i.test(asset.name),
        (asset) => /linux/i.test(asset.name) && /\.tar\.gz$/i.test(asset.name),
      ]),
    },
    {
      id: "linux-deb",
      label: "Ubuntu / Debian",
      asset: pickAssetFromReleases(prioritizedReleases, [
        (asset) => /linux/i.test(asset.name) && /\.deb$/i.test(asset.name),
        (asset) => /\.deb$/i.test(asset.name),
      ]),
    },
  ]
    .filter((entry) => entry.asset)
    .map((entry) => serializeDownload(entry.id, entry.label, entry.asset));

  const checksumAsset =
    assets.find((asset) => asset.name === "SHA256SUMS.txt") ?? null;

  return {
    tagName: release.tag_name ?? "unavailable",
    publishedAtLabel: release.published_at
      ? publishedAtFormatter.format(new Date(release.published_at))
      : "unavailable",
    prerelease: Boolean(release.prerelease),
    url: release.html_url ?? RELEASES_PAGE_URL,
    downloads,
    checksum: checksumAsset
      ? {
          fileName: checksumAsset.name,
          url: checksumAsset.browser_download_url,
        }
      : null,
  };
}

function buildPayload(release, allReleases = [], canaryRelease = null) {
  const tagName = release?.tag_name ?? "unavailable";
  return {
    generatedAt: new Date().toISOString(),
    scripts,
    cdn: {
      tagName,
      appAssetBaseUrl:
        tagName === "unavailable"
          ? ""
          : buildRawGitHubAssetBase({
              releaseTag: tagName,
              assetRoot: "packages/app/public",
            }),
      homepageAssetBaseUrl:
        tagName === "unavailable"
          ? ""
          : buildRawGitHubAssetBase({
              releaseTag: tagName,
              assetRoot: "packages/homepage/public",
            }),
    },
    release: buildRelease(release, allReleases),
    stableRelease: buildRelease(release, allReleases),
    canaryRelease: canaryRelease
      ? buildRelease(canaryRelease, allReleases)
      : null,
  };
}

const TYPE_HEADER = `// Generated by packages/app-core/scripts/write-homepage-release-data.mjs.
// Do not edit by hand — run \`bun run prebuild\` (or rerun the script directly)
// to refresh from the GitHub Releases API.

export type ReleaseDataDownload = {
  id: string;
  label: string;
  fileName: string;
  url: string;
  sizeLabel: string;
  note: string;
};

export type ReleaseDataChecksum = {
  fileName: string;
  url: string;
};

export type ReleaseDataRelease = {
  tagName: string;
  publishedAtLabel: string;
  prerelease: boolean;
  url: string;
  downloads: ReleaseDataDownload[];
  checksum: ReleaseDataChecksum | null;
};

export type ReleaseDataScripts = {
  shell: { url: string; command: string };
  powershell: { url: string; command: string };
};

export type ReleaseDataCdn = {
  tagName: string;
  appAssetBaseUrl: string;
  homepageAssetBaseUrl: string;
};

export type ReleaseDataPayload = {
  generatedAt: string;
  scripts: ReleaseDataScripts;
  cdn: ReleaseDataCdn;
  release: ReleaseDataRelease;
  stableRelease: ReleaseDataRelease;
  canaryRelease: ReleaseDataRelease | null;
};

`;

function toModule(payload) {
  return `${TYPE_HEADER}export const releaseData: ReleaseDataPayload = ${JSON.stringify(payload, null, 2)};\n`;
}

async function fetchReleases() {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "eliza-homepage-release-data",
  };

  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(RELEASES_URL, { headers });
  if (!response.ok) {
    throw new Error(
      `GitHub API returned ${response.status} ${response.statusText}`,
    );
  }

  return response.json();
}

async function writePayload(payload) {
  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, toModule(payload));
  // Best-effort biome format; biome.json may exclude `src/generated/`, in which
  // case biome exits non-zero. The generated file is JSON.stringify output and
  // doesn't need formatting to be correct, so failures here are not fatal.
  const relOutput = path.relative(REPO_ROOT, OUTPUT_PATH);
  const biomeArgs = ["@biomejs/biome", "format", "--write", relOutput];
  const bunx = process.platform === "win32" ? "bunx.cmd" : "bunx";
  try {
    execFileSync(bunx, biomeArgs, {
      stdio: "ignore",
      cwd: REPO_ROOT,
      shell: false,
    });
  } catch {
    // Ignore — the file is still valid TypeScript without biome's pass.
  }
}

async function main() {
  try {
    const releases = await fetchReleases();
    const stableRelease = pickStableRelease(releases);
    const canaryRelease = pickCanaryRelease(releases);
    // Use stable release as primary; fall back to any release if no stable exists
    const primaryRelease = stableRelease ?? pickRelease(releases);
    await writePayload(buildPayload(primaryRelease, releases, canaryRelease));
    const tag = primaryRelease?.tag_name ?? "no published release";
    const canaryTag = canaryRelease?.tag_name;
    console.log(
      `homepage release data: stable=${tag}${canaryTag ? `, canary=${canaryTag}` : ""}`,
    );
  } catch (error) {
    if (existsSync(OUTPUT_PATH)) {
      console.warn(
        `homepage release data refresh failed, keeping existing file: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    await writePayload(buildPayload(null));
    console.warn(
      `homepage release data refresh failed, wrote fallback file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

await main();
