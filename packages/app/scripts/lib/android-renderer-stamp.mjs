/**
 * Android renderer-stamp verifier for sideload APKs. The mobile build already
 * proves the staged Gradle assets match the fresh Vite build; this module
 * checks the packaged APK before adb install so a stale artifact cannot reach a
 * device just because it was the newest file in the outputs directory.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const RENDERER_MANIFEST = "eliza-renderer-build.json";
export const ANDROID_APK_RENDERER_MANIFEST_PATH = `assets/public/${RENDERER_MANIFEST}`;

function findEndOfCentralDirectory(buffer) {
  const signature = 0x06054b50;
  const minOffset = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function readZipEntry(zipPath, entryName) {
  const buffer = fs.readFileSync(zipPath);
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new Error(`APK is not a readable zip: ${zipPath}`);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let cursor = buffer.readUInt32LE(eocd + 16);
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`APK central directory is corrupt: ${zipPath}`);
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const nameStart = cursor + 46;
    const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
    if (name === entryName) {
      if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error(`APK local file header is corrupt: ${zipPath}`);
      }
      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart =
        localHeaderOffset + 30 + localNameLength + localExtraLength;
      const data = buffer.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      throw new Error(
        `APK entry ${entryName} uses unsupported zip compression method ${method}.`,
      );
    }
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return null;
}

function readRendererManifest(manifestPath, label) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`${label} renderer manifest is missing: ${manifestPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (typeof parsed.buildId !== "string" || parsed.buildId.length === 0) {
    throw new Error(
      `${label} renderer manifest has no buildId: ${manifestPath}`,
    );
  }
  return parsed;
}

export function freshAndroidRendererManifestPath({
  repoRoot,
  rendererDist = process.env.ELIZA_ANDROID_RENDERER_DIST ??
    process.env.ELIZA_SMOKE_RENDERER_DIST,
}) {
  return path.join(
    rendererDist
      ? path.resolve(rendererDist)
      : path.join(repoRoot, "packages", "app", "dist"),
    RENDERER_MANIFEST,
  );
}

export function readAndroidApkRendererManifest(apkPath, label = "Android APK") {
  const entry = readZipEntry(apkPath, ANDROID_APK_RENDERER_MANIFEST_PATH);
  if (!entry) {
    throw new Error(
      `${label} is missing ${ANDROID_APK_RENDERER_MANIFEST_PATH}; refusing to install an unverifiable renderer.`,
    );
  }
  const parsed = JSON.parse(entry.toString("utf8"));
  if (typeof parsed.buildId !== "string" || parsed.buildId.length === 0) {
    throw new Error(`${label} renderer manifest has no buildId.`);
  }
  return parsed;
}

export function compareAndroidRendererBuildIds({
  fresh,
  packaged,
  label = "Android APK",
  expectedCommit = null,
}) {
  if (
    expectedCommit &&
    fresh.commit &&
    !String(expectedCommit).startsWith(String(fresh.commit)) &&
    !String(fresh.commit).startsWith(String(expectedCommit))
  ) {
    throw new Error(
      `freshly built renderer commit ${fresh.commit} != HEAD ${expectedCommit} - stale Android dist.`,
    );
  }
  if (packaged.buildId !== fresh.buildId) {
    throw new Error(
      `${label} renderer buildId ${packaged.buildId} != freshly built ${fresh.buildId} - stale Android APK.`,
    );
  }
  return {
    buildId: fresh.buildId,
    builtAt: fresh.builtAt ?? null,
  };
}

export function assertAndroidApkRendererFresh({
  apkPath,
  repoRoot,
  rendererDist = process.env.ELIZA_ANDROID_RENDERER_DIST ??
    process.env.ELIZA_SMOKE_RENDERER_DIST,
  expectedCommit = null,
  label = "Android APK",
  log = () => {},
}) {
  const freshManifest = freshAndroidRendererManifestPath({
    repoRoot,
    rendererDist,
  });
  const fresh = readRendererManifest(freshManifest, "freshly built");
  const packaged = readAndroidApkRendererManifest(apkPath, label);
  const result = compareAndroidRendererBuildIds({
    fresh,
    packaged,
    label,
    expectedCommit,
  });
  log(
    `renderer build stamp OK for ${label}: ${String(result.buildId).slice(0, 12)}${result.builtAt ? ` built ${result.builtAt}` : ""}`,
  );
  return result;
}
