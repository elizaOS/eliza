/**
 * Unit tests for the Android APK renderer freshness guard. The fixtures are
 * minimal zip files with the same `assets/public` manifest path Gradle packages
 * into real APKs, so the verifier can fail stale installs without adb.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyInstalledApkHash } from "./lib/android-device.mjs";
import {
  ANDROID_APK_RENDERER_MANIFEST_PATH,
  assertAndroidApkRendererFresh,
  compareAndroidRendererBuildIds,
  freshAndroidRendererManifestPath,
  readAndroidApkRendererManifest,
} from "./lib/android-renderer-stamp.mjs";

const tempDirs = [];

function tempDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "android-renderer-stamp-"));
  tempDirs.push(dir);
  return dir;
}

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function writeStoredZipEntry(zipPath, entryName, content) {
  const name = Buffer.from(entryName);
  const data = Buffer.from(content);
  const local = Buffer.concat([
    u32(0x04034b50),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(data.length),
    u32(data.length),
    u16(name.length),
    u16(0),
    name,
    data,
  ]);
  const centralOffset = local.length;
  const central = Buffer.concat([
    u32(0x02014b50),
    u16(20),
    u16(20),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(data.length),
    u32(data.length),
    u16(name.length),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    name,
  ]);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(1),
    u16(1),
    u32(central.length),
    u32(centralOffset),
    u16(0),
  ]);
  writeFileSync(zipPath, Buffer.concat([local, central, eocd]));
}

function writeApk(repoRoot, buildId) {
  const apkPath = path.join(repoRoot, "app-debug.apk");
  writeStoredZipEntry(
    apkPath,
    ANDROID_APK_RENDERER_MANIFEST_PATH,
    JSON.stringify({ buildId, builtAt: "2026-07-05T00:00:00.000Z" }),
  );
  return apkPath;
}

function writeFreshDist(repoRoot, buildId) {
  const dist = path.join(repoRoot, "packages", "app", "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(
    path.join(dist, "eliza-renderer-build.json"),
    JSON.stringify({ buildId, builtAt: "2026-07-05T00:01:00.000Z" }),
  );
}

afterEach(() => {
  delete process.env.ELIZA_ANDROID_RENDERER_DIST;
  delete process.env.ELIZA_SMOKE_RENDERER_DIST;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Android renderer stamp", () => {
  it("reads the renderer manifest packaged in an APK", () => {
    const repoRoot = tempDir();
    const apkPath = writeApk(repoRoot, "packaged");

    expect(readAndroidApkRendererManifest(apkPath)).toMatchObject({
      buildId: "packaged",
    });
  });

  it("accepts matching fresh and packaged build ids", () => {
    expect(
      compareAndroidRendererBuildIds({
        fresh: { buildId: "same", builtAt: "now" },
        packaged: { buildId: "same" },
      }),
    ).toEqual({ buildId: "same", builtAt: "now" });
  });

  it("rejects stale packaged renderer manifests", () => {
    expect(() =>
      compareAndroidRendererBuildIds({
        fresh: { buildId: "fresh" },
        packaged: { buildId: "old" },
      }),
    ).toThrow(/stale Android APK/);
  });

  it("rejects a fresh dist manifest from another commit", () => {
    expect(() =>
      compareAndroidRendererBuildIds({
        fresh: { buildId: "same", commit: "111111111111" },
        packaged: { buildId: "same" },
        expectedCommit: "222222222222",
      }),
    ).toThrow(/stale Android dist/);
  });

  it("compares a packaged APK against the freshly built dist manifest", () => {
    const repoRoot = tempDir();
    writeFreshDist(repoRoot, "same");
    const apkPath = writeApk(repoRoot, "same");

    expect(
      assertAndroidApkRendererFresh({
        apkPath,
        repoRoot,
        expectedCommit: null,
      }),
    ).toEqual({
      buildId: "same",
      builtAt: "2026-07-05T00:01:00.000Z",
    });
  });

  it("prefers the Android renderer dist override over the generic smoke override", () => {
    const repoRoot = tempDir();
    const smokeDist = path.join(repoRoot, "smoke-dist");
    const androidDist = path.join(repoRoot, "android-dist");
    process.env.ELIZA_SMOKE_RENDERER_DIST = smokeDist;
    process.env.ELIZA_ANDROID_RENDERER_DIST = androidDist;

    expect(freshAndroidRendererManifestPath({ repoRoot })).toBe(
      path.join(androidDist, "eliza-renderer-build.json"),
    );
  });

  it("fails when the APK is missing the renderer manifest", () => {
    const repoRoot = tempDir();
    const apkPath = path.join(repoRoot, "missing.apk");
    writeStoredZipEntry(apkPath, "assets/public/index.html", "<html></html>");

    expect(() => readAndroidApkRendererManifest(apkPath)).toThrow(
      /missing assets\/public\/eliza-renderer-build\.json/,
    );
  });

  it("accepts an installed APK hash that matches the local file", () => {
    expect(
      verifyInstalledApkHash({
        localHash: "abc123",
        deviceHash: "abc123",
      }),
    ).toEqual({ sha256: "abc123" });
  });

  it("rejects an installed APK hash mismatch", () => {
    expect(() =>
      verifyInstalledApkHash({
        localHash: "fresh",
        deviceHash: "stale",
      }),
    ).toThrow(/on-device APK does not match installed file/);
  });
});
