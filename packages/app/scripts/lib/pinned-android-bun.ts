/** Pins and verifies upstream Bun artifacts for Android's x64 and arm64 hosts. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const lock = JSON.parse(
  fs.readFileSync(
    new URL("./android-bun-artifacts.lock.json", import.meta.url),
    "utf8",
  ),
);
const SHA256 = /^[a-f0-9]{64}$/;

export function resolvePinnedBunArtifact(channel, arch) {
  const release = lock.channels[channel];
  const artifact = release?.artifacts?.[arch];
  if (
    lock.schemaVersion !== 1 ||
    lock.repository !== "oven-sh/bun" ||
    !artifact ||
    !Number.isSafeInteger(artifact.assetId) ||
    artifact.assetId <= 0 ||
    !SHA256.test(artifact.archiveSha256) ||
    !SHA256.test(artifact.binarySha256) ||
    !/^[a-f0-9]{40}$/.test(release.revision) ||
    typeof release.version !== "string"
  ) {
    throw new Error(
      `Missing or invalid pinned Android Bun artifact: ${channel}/${arch}`,
    );
  }
  return {
    ...artifact,
    version: release.version,
    revision: release.revision,
    filename: `bun-linux-${arch}-musl.zip`,
    entry: `bun-linux-${arch}-musl/bun`,
    url: `https://api.github.com/repos/oven-sh/bun/releases/assets/${artifact.assetId}`,
  };
}

function verifyFile(file, expected, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile())
    throw new Error(`${label} must be a regular file: ${file}`);
  const actual = createHash("sha256")
    .update(fs.readFileSync(file))
    .digest("hex");
  if (actual !== expected)
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expected}, got ${actual}`,
    );
}

/**
 * Verify both ZIP and executable before publishing to a content-addressed cache.
 * Every cache hit is rehashed; neither mtime nor a checksum sidecar is authority.
 * Local archives must match the same reviewed pin as a network download.
 */
export async function stagePinnedBunArtifact({
  cacheDir,
  artifact,
  sourceFile,
  sourceProvenance = {},
  download,
  log = () => {},
}) {
  if (
    !SHA256.test(artifact.archiveSha256) ||
    !SHA256.test(artifact.binarySha256)
  ) {
    throw new Error("Pinned Bun requires archive and binary SHA-256 values");
  }
  if (sourceFile) verifyFile(sourceFile, artifact.archiveSha256, "Bun archive");
  const artifactDir = path.join(cacheDir, `bun-${artifact.archiveSha256}`);
  const bunPath = path.join(artifactDir, "bun");
  const source = {
    kind: sourceFile ? "file" : "url",
    ...sourceProvenance,
    url: artifact.url,
    asset_id: artifact.assetId,
    artifact_filename: artifact.filename,
    artifact_sha256: artifact.archiveSha256,
    binary_sha256: artifact.binarySha256,
    version: artifact.version,
    revision: artifact.revision,
  };
  if (fs.existsSync(bunPath)) {
    verifyFile(bunPath, artifact.binarySha256, "Cached Bun binary");
    return {
      bunPath,
      source: {
        ...source,
        kind: "cache",
        cache_key: path.basename(artifactDir),
      },
    };
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(cacheDir, ".bun-staging-"));
  try {
    const archive = path.join(staging, "bun.zip");
    if (sourceFile) fs.copyFileSync(sourceFile, archive);
    else {
      log(`Downloading pinned Bun ${artifact.version} from ${artifact.url}`);
      await download(artifact.url, archive, {
        log,
        headers: { Accept: "application/octet-stream" },
      });
    }
    verifyFile(archive, artifact.archiveSha256, "Bun archive");
    // Extract only the pinned member; archive paths cannot write outside staging.
    const candidate = path.join(staging, "bun");
    const fd = fs.openSync(candidate, "wx", 0o755);
    try {
      execFileSync("unzip", ["-p", archive, artifact.entry], {
        stdio: ["ignore", fd, "pipe"],
      });
    } finally {
      fs.closeSync(fd);
    }
    verifyFile(candidate, artifact.binarySha256, "Bun executable");
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.renameSync(candidate, bunPath);
    verifyFile(bunPath, artifact.binarySha256, "Published Bun binary");
    return { bunPath, source };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
