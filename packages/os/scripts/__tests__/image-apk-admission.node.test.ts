// Image APK admission and reviewed source overrides, on fixture trees: a fake APK file,
// injected build-flag and manifest readers, and a git fixture project. Staging evidence
// only; nothing here builds or boots an image.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apkReleaseBlockers } from "../android/apk-release-record.mjs";
import {
  admitImageApk,
  manifestTreeIsDebuggable,
  reviewedSourceOverrides,
} from "../android/image-apk-admission.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function temporary(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const DEBUG_TREE =
  "E: application\n  A: android:debuggable(0x0101000f)=(type 0x12)0xffffffff\n";
const RELEASE_TREE = "E: application\n  A: android:label=Launcher\n";

function releaseRow(sha256, overrides = {}) {
  return {
    file: "launcher-release.apk",
    sha256,
    mode: "release",
    testMocks: false,
    bundleAudit: "passed",
    signed: true,
    releaseAdmission: { failures: [], blockers: [], signerMatches: true },
    runtime: "PACKAGED",
    runtimeNotices: true,
    voiceHost: { packaged: true, differences: [], qualified: true },
    licenceBlockers: [],
    distributable: true,
    ...overrides,
  };
}

function fixture(t) {
  const dir = temporary(t, "image-apk-");
  const apk = path.join(dir, "launcher.apk");
  fs.writeFileSync(apk, "apk bytes");
  const mocks = path.join(dir, "test-mocks");
  fs.mkdirSync(mocks);
  return { dir, apk, mocks, sha256: hash(fs.readFileSync(apk)) };
}

const base = (f, extra = {}) => ({
  apk: f.apk,
  testMocksDir: f.mocks,
  readBuildFlags: () => ({ testMocks: false }),
  readManifestTree: () => RELEASE_TREE,
  judge: (row, manifest) =>
    apkReleaseBlockers(row, { manifestTestMocks: manifest.testMocks }),
  ...extra,
});

test("the aapt debuggable check reads only android:debuggable=true", () => {
  assert.equal(manifestTreeIsDebuggable(DEBUG_TREE), true);
  assert.equal(manifestTreeIsDebuggable(RELEASE_TREE), false);
  assert.equal(
    manifestTreeIsDebuggable(
      "A: android:debuggable(0x0101000f)=(type 0x12)0x0\n",
    ),
    false,
  );
});

test("test-mocks paths and test-mocks web bundles are never admitted", (t) => {
  const f = fixture(t);
  const mocked = path.join(f.mocks, "launcher.apk");
  fs.copyFileSync(f.apk, mocked);
  assert.throws(
    () => admitImageApk(base(f, { apk: mocked, development: true })),
    /test-mocks\/ builds are never staged/,
  );
  // A symlink outside the directory that resolves into it is refused too.
  const link = path.join(f.dir, "linked.apk");
  fs.symlinkSync(mocked, link);
  assert.throws(
    () => admitImageApk(base(f, { apk: link, development: true })),
    /never staged/,
  );
  assert.throws(
    () =>
      admitImageApk(
        base(f, {
          development: true,
          readBuildFlags: () => ({ testMocks: true }),
        }),
      ),
    /built with test mocks enabled/,
  );
  assert.throws(
    () =>
      admitImageApk(
        base(f, {
          development: true,
          readBuildFlags: () => {
            throw new Error("missing");
          },
        }),
      ),
    /test-mocks flag is unverified/,
  );
  assert.throws(
    () =>
      admitImageApk(
        base(f, {
          development: true,
          manifest: { testMocks: true, results: [{ sha256: f.sha256 }] },
        }),
      ),
    /records it as a test-mocks build/,
  );
  assert.throws(() => admitImageApk({ apk: f.apk }), /testMocksDir/);
});

test("production admits only a distributable release row with no blockers", (t) => {
  const f = fixture(t);
  assert.throws(
    () => admitImageApk(base(f)),
    /Production staging requires a release APK/,
  );
  const good = { testMocks: false, results: [releaseRow(f.sha256)] };
  const admitted = admitImageApk(base(f, { manifest: good }));
  assert.equal(admitted.entry.sha256, f.sha256);
  assert.deepEqual(admitted.blockers, []);
  // A row whose recorded facts contradict distributable:true is still refused, naming each.
  const contradicted = {
    testMocks: false,
    results: [releaseRow(f.sha256, { runtime: "UNPACKAGED", signed: false })],
  };
  assert.throws(
    () => admitImageApk(base(f, { manifest: contradicted })),
    (error) =>
      /not distributable/.test(error.message) &&
      /unsigned release/.test(error.message) &&
      /unpackaged runtime/.test(error.message),
  );
  // Open-source licence flags never block (P-09); only a policy-named check does.
  const flagged = {
    testMocks: false,
    results: [
      releaseRow(f.sha256, {
        licenceFlags: ["copyleft-strong"],
        licenceBlockers: ["unresolved-font-licence: Display"],
      }),
    ],
  };
  assert.equal(
    admitImageApk(base(f, { manifest: flagged })).blockers.length,
    0,
  );
  assert.throws(
    () =>
      admitImageApk(
        base(f, {
          manifest: flagged,
          judge: (row) =>
            apkReleaseBlockers(row, {
              licenceBlocks: (item) =>
                item.startsWith("unresolved-font-licence"),
            }),
        }),
      ),
    /unresolved-font-licence/,
  );
  // The reviewed image platform certificate is part of production judgement.
  assert.throws(
    () =>
      admitImageApk(
        base(f, {
          manifest: good,
          judge: (row) =>
            apkReleaseBlockers(row, {
              image: { platformCertificateSha256: "PLACEHOLDER" },
            }),
        }),
      ),
    /image platform certificate/,
  );
  assert.deepEqual(
    admitImageApk(
      base(f, {
        manifest: good,
        judge: (row) =>
          apkReleaseBlockers(row, {
            image: { platformCertificateSha256: "c".repeat(64) },
          }),
      }),
    ).blockers,
    [],
  );
});

test("development stages debug builds only, and never an unrecorded release", (t) => {
  const f = fixture(t);
  assert.equal(
    admitImageApk(
      base(f, { development: true, readManifestTree: () => DEBUG_TREE }),
    ).debuggable,
    true,
  );
  assert.throws(
    () => admitImageApk(base(f, { development: true })),
    /debug builds only\. This is a release build/,
  );
  assert.throws(
    () =>
      admitImageApk(
        base(f, {
          development: true,
          readManifestTree: () => {
            throw new Error("aapt failed");
          },
        }),
      ),
    /build type could not be read/,
  );
  // A release relabelled "debug" in the manifest is still read from the APK.
  const relabelled = {
    testMocks: false,
    results: [
      releaseRow(f.sha256, { mode: "debug", distributable: undefined }),
    ],
  };
  assert.throws(
    () => admitImageApk(base(f, { development: true, manifest: relabelled })),
    /debug builds only/,
  );
  // A distributable release row is admitted for development without reading the manifest tree.
  const good = { testMocks: false, results: [releaseRow(f.sha256)] };
  assert.equal(
    admitImageApk(
      base(f, {
        development: true,
        manifest: good,
        readManifestTree: () => {
          throw new Error("not read");
        },
      }),
    ).debuggable,
    null,
  );
});

test("reviewed source overrides admit exact patch preimages, revisions and bytes", (t) => {
  const source = temporary(t, "overrides-");
  const lockPath = path.join(source, "lock.json");
  const directory = path.join(source, "framework");
  fs.mkdirSync(directory);
  const git = (...args) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(directory, "ui.txt"), "before");
  git("add", ".");
  git("commit", "-qm", "fixture");
  const revision = git("rev-parse", "HEAD");
  const pinned = [
    {
      path: "frameworks/base/Android.bp",
      sha256: "a".repeat(64),
      sizeBytes: 1,
    },
  ];
  fs.writeFileSync(
    lockPath,
    JSON.stringify({
      projects: [{ path: "framework", commit: revision }],
      overrides: pinned,
    }),
  );
  const lockSha256 = hash(fs.readFileSync(lockPath));
  assert.deepEqual(reviewedSourceOverrides({ lockPath }), []);
  assert.deepEqual(
    reviewedSourceOverrides({ imageTarget: true, lockPath }),
    pinned,
  );
  assert.deepEqual(
    reviewedSourceOverrides({
      physicalSource: { sourceLockSha256: lockSha256 },
      lockPath,
    }),
    pinned,
  );
  assert.throws(
    () =>
      reviewedSourceOverrides({
        physicalSource: { sourceLockSha256: "0".repeat(64) },
        lockPath,
      }),
    /source lock changed/,
  );
  const manifest = {
    project: "framework",
    revision,
    baselineLockSha256: lockSha256,
    files: [
      {
        path: "ui.txt",
        beforeSha256: hash("before"),
        afterSha256: hash("after"),
      },
      { path: "Chip.java", beforeSha256: null, afterSha256: hash("chip") },
    ],
  };
  fs.writeFileSync(path.join(directory, "ui.txt"), "after");
  fs.writeFileSync(path.join(directory, "Chip.java"), "chip");
  const options = {
    source,
    imageTarget: true,
    lockPath,
    appliedPatches: [{ manifest }],
  };
  const overrides = () => reviewedSourceOverrides(options);
  assert.deepEqual(
    overrides().map((row) => row.path),
    ["frameworks/base/Android.bp", "framework/ui.txt", "framework/Chip.java"],
  );
  fs.writeFileSync(path.join(directory, "Chip.java"), "tampered");
  assert.throws(overrides, /patch bytes differ/);
  fs.writeFileSync(path.join(directory, "Chip.java"), "chip");
  manifest.files[0].beforeSha256 = hash("wrong");
  assert.throws(overrides, /preimage differs/);
  manifest.files[0].beforeSha256 = hash("before");
  manifest.baselineLockSha256 = "0".repeat(64);
  assert.throws(overrides, /source lock differs/);
  manifest.baselineLockSha256 = lockSha256;
  manifest.revision = "f".repeat(40);
  assert.throws(overrides, /revision differs/);
  manifest.revision = revision;
  manifest.files.push({
    path: "../escape.txt",
    beforeSha256: null,
    afterSha256: hash("x"),
  });
  assert.throws(overrides, /Unsafe SystemUI patch path/);
  manifest.files.pop();
  options.appliedPatches.push({ manifest });
  assert.throws(overrides, /overlaps/);
  options.appliedPatches.pop();
  fs.rmSync(path.join(directory, "Chip.java"));
  fs.symlinkSync(
    path.join(source, "lock.json"),
    path.join(directory, "Chip.java"),
  );
  assert.throws(overrides, /not regular/);
});
