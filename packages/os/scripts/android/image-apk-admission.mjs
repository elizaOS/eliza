/**
 * Admission of a product launcher APK into an AOSP image overlay, and of the reviewed
 * source overrides a staging run may carry.
 *
 * A product (elizaOS or a white-label brand) passes its own policy as data: where its
 * separate test-mocks builds land, its APK verification manifest, how it judges a recorded
 * release row (apk-release-record.mjs `apkReleaseBlockers` with its signer and licence
 * policy) and the reviewed image platform certificate. Nothing here reads a product file
 * by a fixed path.
 *
 * Admission is staging evidence only: an admitted APK is not an image build, boot, device
 * acceptance or a distribution decision.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** True when an `aapt dump xmltree` of AndroidManifest.xml declares android:debuggable=true. */
export function manifestTreeIsDebuggable(tree) {
  return /android:debuggable[^\n]*0xffffffff/.test(String(tree ?? ""));
}

/** The packaged web bundle's build flags, read from the APK (`assets/public/build-flags.json`). */
export function readApkBuildFlags(apk) {
  return JSON.parse(
    execFileSync("unzip", ["-p", apk, "assets/public/build-flags.json"], {
      encoding: "utf8",
      maxBuffer: 1 << 20,
    }),
  );
}

/** `aapt dump xmltree APK AndroidManifest.xml`. */
export function aaptManifestTree(
  apk,
  { aapt = "aapt", env = process.env } = {},
) {
  return execFileSync(aapt, ["dump", "xmltree", apk, "AndroidManifest.xml"], {
    encoding: "utf8",
    env,
    maxBuffer: 64 << 20,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function inside(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Refuse an APK that must never reach an image, or return the manifest row that admits it.
 *
 * - Anything under `testMocksDir` (by path or by its real path) is refused.
 * - The APK's packaged web bundle must record `testMocks: false` in build-flags.json.
 * - A row in `manifest` (matched by SHA-256) recorded as test mocks is refused.
 * - A release row is judged by `judge(row, manifest)`, which returns named blockers (a
 *   product passes `apkReleaseBlockers` bound to its signer and licence policy). A row
 *   recorded as not distributable, or a release with blockers, is refused with each blocker.
 * - Production (`development: false`) requires a release row recorded distributable with no
 *   blockers.
 * - Development stages debug builds: an APK without a release row must be debuggable
 *   (`readManifestTree`), so an unrecorded release is never staged by relabelling.
 *
 * @returns {{entry: object|null, blockers: string[], debuggable: boolean|null}}
 */
export function admitImageApk({
  apk,
  sha256 = digest(fs.readFileSync(apk)),
  development = false,
  manifest = null,
  manifestFile = "apk-manifest.json",
  testMocksDir,
  judge = () => [],
  readBuildFlags = readApkBuildFlags,
  readManifestTree = aaptManifestTree,
}) {
  if (!testMocksDir) throw new Error("admitImageApk requires testMocksDir");
  const mocks = path.resolve(testMocksDir);
  const real = fs.realpathSync(apk);
  for (const candidate of [path.resolve(apk), real])
    if (inside(mocks, candidate))
      throw new Error(
        `Refusing ${apk}: ${path.basename(mocks)}/ builds are never staged into an image.`,
      );
  let flags;
  try {
    flags = readBuildFlags(apk);
  } catch {
    throw new Error(
      `Refusing ${apk}: its web bundle has no assets/public/build-flags.json, so its test-mocks flag is unverified.`,
    );
  }
  if (flags?.testMocks !== false)
    throw new Error(
      `Refusing ${apk}: its web bundle was built with test mocks enabled.`,
    );
  const entry =
    manifest?.results?.find((row) => row?.sha256 === sha256) ?? null;
  if (entry && (manifest.testMocks === true || entry.testMocks === true))
    throw new Error(
      `Refusing ${apk}: ${manifestFile} records it as a test-mocks build.`,
    );
  const blockers =
    entry && (entry.mode === "release" || entry.distributable !== undefined)
      ? judge(entry, manifest)
      : [];
  if (
    entry &&
    (entry.distributable === false ||
      (entry.mode === "release" && blockers.length))
  )
    throw new Error(
      `Refusing ${apk}: ${manifestFile} records this release as not distributable (runtime ${entry.runtime ?? "unknown"}, ${entry.signed ? "signed" : "unsigned"}). Unresolved blockers:\n${blockers.map((item) => `  - ${item}`).join("\n")}`,
    );
  if (
    !development &&
    !(
      entry &&
      entry.mode === "release" &&
      entry.distributable === true &&
      blockers.length === 0
    )
  )
    throw new Error(
      `Production staging requires a release APK that verify-apks recorded as distributable in ${manifestFile}.`,
    );
  let debuggable = null;
  if (development && entry?.mode !== "release") {
    try {
      debuggable = manifestTreeIsDebuggable(readManifestTree(apk));
    } catch {
      throw new Error(
        `Refusing ${apk}: --development stages debug builds only, and this APK's build type could not be read.`,
      );
    }
    if (!debuggable)
      throw new Error(
        `Refusing ${apk}: --development stages debug builds only. This is a release build that ${manifestFile} does not record as distributable.`,
      );
  }
  return { entry, blockers, debuggable };
}

const safeRelative = (name) =>
  typeof name === "string" &&
  name.length > 0 &&
  !path.isAbsolute(name) &&
  !name.split(/[\\/]/).some((part) => !part || part === "." || part === "..");

/**
 * Source overrides a secure-camera (or other) source check admits for an image staging run.
 *
 * Image targets (a physical product or Cuttlefish) built from one reviewed source lock admit
 * exactly its hash-pinned `overrides`, plus the files of every applied patch whose manifest
 * names that lock, a locked project revision, a safe project path, the checked-out revision,
 * each file's preimage at that revision and its exact patched bytes. Other staging admits none.
 *
 * `physicalSource.sourceLockSha256`, when given, must still be the lock's digest. Each applied
 * patch is `{ manifest: { baselineLockSha256, project, revision, files: [{path, beforeSha256,
 * afterSha256}] } }`, as the shared patch descriptors (sense-systemui.mjs, soong-app-native.mjs)
 * produce. Any mismatch throws; nothing is rewritten.
 */
export function reviewedSourceOverrides({
  physicalSource = null,
  imageTarget = false,
  lockPath,
  source,
  appliedPatches = [],
  label = "SystemUI",
} = {}) {
  if (!physicalSource && !imageTarget) return [];
  if (!lockPath) throw new Error("reviewedSourceOverrides requires lockPath");
  const lockBytes = fs.readFileSync(lockPath);
  const lockSha256 = digest(lockBytes);
  if (physicalSource && lockSha256 !== physicalSource.sourceLockSha256)
    throw new Error("Pixel source lock changed during staging");
  const lock = JSON.parse(lockBytes);
  const overrides = [...(lock.overrides ?? [])];
  const seen = new Set(overrides.map((entry) => entry.path));
  for (const { manifest } of appliedPatches) {
    if (!source || manifest?.baselineLockSha256 !== lockSha256)
      throw new Error(`Applied ${label} patch source lock differs`);
    if (
      !lock.projects?.some(
        (project) =>
          project.path === manifest.project &&
          project.commit === manifest.revision,
      )
    )
      throw new Error(`Applied ${label} patch revision differs`);
    if (!safeRelative(manifest.project))
      throw new Error(`Unsafe ${label} project path`);
    const base = fs.realpathSync(source);
    const directory = fs.realpathSync(path.join(base, manifest.project));
    if (!directory.startsWith(base + path.sep))
      throw new Error(`${label} project escapes source`);
    const git = (args) =>
      execFileSync("git", ["-C", directory, ...args], {
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
        maxBuffer: 64 << 20,
      });
    if (git(["rev-parse", "HEAD"]).toString().trim() !== manifest.revision)
      throw new Error(`Applied ${label} checkout revision differs`);
    for (const file of manifest.files ?? []) {
      if (!safeRelative(file.path))
        throw new Error(`Unsafe ${label} patch path`);
      const relative = `${manifest.project}/${file.path}`;
      if (seen.has(relative))
        throw new Error(`Applied ${label} patch overlaps source override`);
      seen.add(relative);
      const listed = git([
        "ls-tree",
        manifest.revision,
        "--",
        file.path,
      ]).toString();
      const before = listed
        ? digest(git(["show", `${manifest.revision}:${file.path}`]))
        : null;
      if (before !== file.beforeSha256)
        throw new Error(`Applied ${label} patch preimage differs`);
      const target = path.join(directory, file.path);
      if (
        !fs.lstatSync(target).isFile() ||
        !fs.realpathSync(target).startsWith(directory + path.sep)
      )
        throw new Error(`Applied ${label} patch file is not regular`);
      const bytes = fs.readFileSync(target);
      if (digest(bytes) !== file.afterSha256)
        throw new Error(`Applied ${label} patch bytes differ`);
      overrides.push({
        path: relative,
        sizeBytes: bytes.length,
        sha256: file.afterSha256,
      });
    }
  }
  return overrides;
}
