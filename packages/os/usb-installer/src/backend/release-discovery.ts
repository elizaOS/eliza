// Discovers only checksum-backed ISO assets published by the OS repository.
import type { ElizaOsImage } from "./types";
import { hasTrustedChecksum } from "./write-safety";

const RELEASES_API = "https://api.github.com/repos/elizaOS/os/releases";

interface GitHubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  published_at: string;
  prerelease: boolean;
  assets: GitHubAsset[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRelease(value: unknown): GitHubRelease {
  if (!isRecord(value) || !Array.isArray(value.assets)) {
    throw new Error("GitHub OS release metadata is malformed.");
  }
  if (
    typeof value.tag_name !== "string" ||
    !value.tag_name ||
    typeof value.published_at !== "string" ||
    Number.isNaN(Date.parse(value.published_at)) ||
    typeof value.prerelease !== "boolean"
  ) {
    throw new Error("GitHub OS release identity is malformed.");
  }
  const assets = value.assets.map((asset) => {
    if (
      !isRecord(asset) ||
      typeof asset.name !== "string" ||
      typeof asset.browser_download_url !== "string" ||
      !asset.browser_download_url.startsWith(
        "https://github.com/elizaOS/os/",
      ) ||
      !Number.isSafeInteger(asset.size) ||
      Number(asset.size) <= 0
    ) {
      throw new Error("GitHub OS release asset metadata is malformed.");
    }
    return {
      name: asset.name,
      browser_download_url: asset.browser_download_url,
      size: Number(asset.size),
    };
  });
  return {
    tag_name: value.tag_name,
    published_at: value.published_at,
    prerelease: value.prerelease,
    assets,
  };
}

function architectureFor(
  filename: string,
): ElizaOsImage["architecture"] | null {
  const normalized = filename.toLowerCase();
  if (/(?:^|[-_.])(riscv64)(?:[-_.]|$)/.test(normalized)) return "riscv64";
  if (/(?:^|[-_.])(arm64|aarch64)(?:[-_.]|$)/.test(normalized)) return "arm64";
  if (/(?:^|[-_.])(amd64|x86_64)(?:[-_.]|$)/.test(normalized)) return "x86_64";
  return null;
}

function channelFor(release: GitHubRelease): ElizaOsImage["channel"] {
  if (!release.prerelease) return "stable";
  return release.tag_name.toLowerCase().includes("nightly")
    ? "nightly"
    : "beta";
}

async function checksumFor(
  isoName: string,
  checksumUrl: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const response = await fetchImpl(checksumUrl, {
    headers: { Accept: "text/plain" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(
      `Checksum download failed for ${isoName}: HTTP ${response.status}`,
    );
  }
  const body = await response.text();
  if (body.length > 1024) {
    throw new Error(`Checksum response is too large for ${isoName}.`);
  }
  const lines = body.trim().split(/\r?\n/);
  if (lines.length !== 1) {
    throw new Error(`Checksum response is ambiguous for ${isoName}.`);
  }
  const match = /^([a-f0-9]{64})(?:\s+\*?(.+))?$/.exec(lines[0] ?? "");
  const checksum = match?.[1];
  const declaredName = match?.[2];
  if (
    !checksum ||
    !hasTrustedChecksum(checksum) ||
    (declaredName !== undefined && declaredName !== isoName)
  ) {
    throw new Error(`Checksum contract is invalid for ${isoName}.`);
  }
  return checksum;
}

export async function fetchPublishedIsoImages(
  fetchImpl: typeof fetch = fetch,
): Promise<ElizaOsImage[]> {
  const response = await fetchImpl(RELEASES_API, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`OS release discovery failed: HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("OS release discovery returned malformed JSON.");
  }

  const images: ElizaOsImage[] = [];
  for (const releaseValue of payload) {
    const release = parseRelease(releaseValue);
    const byName = new Map(release.assets.map((asset) => [asset.name, asset]));
    for (const iso of release.assets) {
      if (!iso.name.endsWith(".iso")) continue;
      const architecture = architectureFor(iso.name);
      const checksumAsset = byName.get(`${iso.name}.sha256`);
      if (!architecture || !checksumAsset) continue;
      const checksumSha256 = await checksumFor(
        iso.name,
        checksumAsset.browser_download_url,
        fetchImpl,
      );
      images.push({
        id: `github-${encodeURIComponent(release.tag_name)}-${encodeURIComponent(iso.name)}`,
        label: `elizaOS ${release.tag_name}`,
        version: release.tag_name,
        channel: channelFor(release),
        architecture,
        buildId: release.tag_name,
        publishedAt: release.published_at,
        url: iso.browser_download_url,
        checksumSha256,
        sizeBytes: iso.size,
        minUsbSizeBytes: Math.max(Math.ceil(iso.size * 1.2), 8 * 1024 ** 3),
        manifestVersion: 1,
      });
    }
  }
  return images;
}
