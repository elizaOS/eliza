import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseSubArgs, verifyBuildSource } from "../android/build-aosp.ts";
import { verifyDeviceSource } from "../android/verify-device-source.mjs";
import {
  loadProfile,
  main,
  verifyCheckout,
  verifyProfileSource,
} from "../android/verify-source-lock.ts";

const expected = {
  target: "pixel10a",
  codename: "stallion",
  androidRelease: "17",
};
const verifyPixel10aSource = (options) =>
  verifyDeviceSource({ ...options, expected });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const base = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pixel-source-")),
  );
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, "source"),
    factory = path.join(base, "factory.zip"),
    lock = path.join(base, "lock.json");
  function repo(relative) {
    const dir = path.join(source, relative);
    fs.mkdirSync(dir, { recursive: true });
    const git = (...args) =>
      execFileSync("git", ["-C", dir, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    git("init");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    fs.writeFileSync(path.join(dir, "source.txt"), "original");
    git("add", ".");
    git("commit", "-m", "fixture");
    return { git, dir, commit: git("rev-parse", "HEAD") };
  }
  const manifest = repo(".repo/manifests"),
    project = repo("framework");
  fs.writeFileSync(path.join(project.dir, "source.txt"), "reviewed override");
  const generated = "vendor/google_devices/stallion/kernel";
  fs.mkdirSync(path.dirname(path.join(source, generated)), { recursive: true });
  fs.writeFileSync(path.join(source, generated), "kernel");
  fs.writeFileSync(factory, "factory");
  const record = (name) => {
    const bytes = fs.readFileSync(path.join(source, name));
    return { path: name, sizeBytes: bytes.length, sha256: sha(bytes) };
  };
  const contract = {
    schema: 1,
    target: "pixel10a",
    device: { codename: "stallion", androidRelease: "17" },
    developmentOnly: true,
    releaseQualified: false,
    manifest: { commit: manifest.commit },
    factory: { sizeBytes: 7, sha256: sha("factory") },
    projects: [{ path: "framework", commit: project.commit }],
    overrides: [record("framework/source.txt")],
    generated: {
      root: "vendor/google_devices/stallion",
      files: [record(generated)],
    },
  };
  fs.writeFileSync(path.join(source, ".repo/manifest.xml"), "<manifest/>");
  fs.writeFileSync(path.join(source, ".repo/project.list"), "framework\n");
  contract.manifest.configuration = [
    record(".repo/manifest.xml"),
    record(".repo/project.list"),
  ];
  const save = () => fs.writeFileSync(lock, JSON.stringify(contract));
  save();
  return { source, factory, lock, contract, save, project };
}
test("exact prepared source is development evidence only and inspection is read-only", async (t) => {
  const f = fixture(t);
  const result = await verifyPixel10aSource(f);
  assert.equal(result.projectsChecked, 1);
  assert.equal(result.generatedFilesChecked, 1);
  assert.equal(result.releaseQualified, false);
  assert.equal(result.imageBuilt, false);
  assert.equal(result.deviceAcceptanceVerified, false);
  assert.equal(
    fs.readFileSync(path.join(f.project.dir, "source.txt"), "utf8"),
    "reviewed override",
  );
});
test("wrong factory, source revision and generated kernel are rejected", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.factory, "changed");
  await assert.rejects(verifyPixel10aSource(f), /factory archive differs/);
  fs.writeFileSync(f.factory, "factory");
  f.contract.projects[0].commit = "0".repeat(40);
  f.save();
  await assert.rejects(verifyPixel10aSource(f), /Source revision differs/);
  f.contract.projects[0].commit = f.project.commit;
  f.save();
  fs.writeFileSync(
    path.join(f.source, "vendor/google_devices/stallion/kernel"),
    "other!",
  );
  await assert.rejects(verifyPixel10aSource(f), /Source bytes differ/);
});
test("extra inputs and hidden index modifications cannot reuse the receipt", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project.dir, "extra.cpp"), "extra");
  await assert.rejects(verifyPixel10aSource(f), /Unrecorded source changes/);
  fs.unlinkSync(path.join(f.project.dir, "extra.cpp"));
  f.project.git("update-index", "--assume-unchanged", "source.txt");
  await assert.rejects(verifyPixel10aSource(f), /Hidden or unresolved/);
});
test("unrecorded generated file and changed reviewed override fail", async (t) => {
  const f = fixture(t);
  const extra = path.join(f.source, "vendor/google_devices/stallion/extra");
  fs.writeFileSync(extra, "extra");
  await assert.rejects(verifyPixel10aSource(f), /inventory differs/);
  fs.unlinkSync(extra);
  fs.writeFileSync(
    path.join(f.project.dir, "source.txt"),
    "malicious override",
  );
  await assert.rejects(verifyPixel10aSource(f), /Source bytes differ/);
});
test("wrong device and unsafe source paths fail without staging outputs", async (t) => {
  const f = fixture(t);
  f.contract.device.codename = "grizzly";
  f.save();
  await assert.rejects(verifyPixel10aSource(f), /source contract/);
  f.contract.device.codename = "stallion";
  f.contract.projects[0].path = "../outside";
  f.save();
  await assert.rejects(verifyPixel10aSource(f), /Unsafe source path/);
});

test("changed manifest worktree and unlisted local manifests cannot retain source admission", async (t) => {
  const f = fixture(t),
    file = path.join(f.source, ".repo/manifests/source.txt");
  fs.writeFileSync(file, "changed manifest");
  await assert.rejects(
    verifyPixel10aSource(f),
    /manifest working tree differs/,
  );
  fs.writeFileSync(file, "original");
  fs.mkdirSync(path.join(f.source, ".repo/local_manifests"));
  fs.writeFileSync(
    path.join(f.source, ".repo/local_manifests/extra.xml"),
    "<manifest/>",
  );
  await assert.rejects(
    verifyPixel10aSource(f),
    /Local manifest inventory differs/,
  );
});
test("changing the selected manifest or registered project list fails", async (t) => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.source, ".repo/project.list"), "extra\n");
  await assert.rejects(verifyPixel10aSource(f), /Source bytes differ/);
});

test("ignored build inputs cannot bypass project status verification", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    path.join(f.project.dir, ".git/info/exclude"),
    "hidden.cpp\n",
  );
  fs.writeFileSync(path.join(f.project.dir, "hidden.cpp"), "unreviewed");
  await assert.rejects(
    verifyPixel10aSource(f),
    /Ignored source inventory differs/,
  );
});

function withPatch(t) {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.project.dir, "base.txt"), "pinned");
  f.project.git("add", "base.txt");
  f.project.git("commit", "-m", "base");
  f.contract.projects[0].commit = f.project.git("rev-parse", "HEAD");
  f.save();
  fs.writeFileSync(path.join(f.project.dir, "base.txt"), "patched");
  fs.writeFileSync(path.join(f.project.dir, "chip.txt"), "new");
  const manifest = {
    project: "framework",
    revision: f.contract.projects[0].commit,
    baselineLockSha256: sha(fs.readFileSync(f.lock)),
    patchSha256: "p".repeat(64),
    files: [
      {
        path: "base.txt",
        beforeSha256: sha("pinned"),
        afterSha256: sha("patched"),
      },
      { path: "chip.txt", beforeSha256: null, afterSha256: sha("new") },
    ],
  };
  return {
    ...f,
    manifest,
    appliedPatches: [
      { name: "chip", manifest, manifestSha256: "m".repeat(64) },
    ],
  };
}
test("a build copy with an exactly applied reviewed patch verifies the baseline and reports the patch", async (t) => {
  const f = withPatch(t);
  await assert.rejects(
    verifyPixel10aSource({ ...f, appliedPatches: [] }),
    /Unrecorded source changes/,
  );
  const result = await verifyPixel10aSource(f);
  assert.deepEqual(result.appliedPatches, [
    {
      name: "chip",
      project: "framework",
      revision: f.manifest.revision,
      manifestSha256: "m".repeat(64),
      patchSha256: "p".repeat(64),
      filesChecked: 2,
    },
  ]);
  assert.equal(result.overridesChecked, 1);
  assert.equal(result.releaseQualified, false);
  assert.equal(result.imageBuilt, false);
});
test("applied patches cannot carry changed bytes, wrong preimages, extra files, another lock or overlaps", async (t) => {
  const f = withPatch(t);
  fs.writeFileSync(path.join(f.project.dir, "chip.txt"), "tampered");
  await assert.rejects(verifyPixel10aSource(f), /Applied patch bytes differ/);
  fs.writeFileSync(path.join(f.project.dir, "chip.txt"), "new");
  f.manifest.files[0].beforeSha256 = sha("other");
  await assert.rejects(
    verifyPixel10aSource(f),
    /Applied patch preimage differs/,
  );
  f.manifest.files[0].beforeSha256 = sha("pinned");
  fs.writeFileSync(path.join(f.project.dir, "extra.txt"), "x");
  await assert.rejects(verifyPixel10aSource(f), /Unrecorded source changes/);
  fs.unlinkSync(path.join(f.project.dir, "extra.txt"));
  await assert.rejects(
    verifyPixel10aSource({
      ...f,
      appliedPatches: [
        {
          ...f.appliedPatches[0],
          manifest: { ...f.manifest, baselineLockSha256: "0".repeat(64) },
        },
      ],
    }),
    /not reviewed against this source lock/,
  );
  await assert.rejects(
    verifyPixel10aSource({
      ...f,
      appliedPatches: [
        {
          ...f.appliedPatches[0],
          manifest: { ...f.manifest, revision: "0".repeat(40) },
        },
      ],
    }),
    /locked project revision/,
  );
  await assert.rejects(
    verifyPixel10aSource({
      ...f,
      appliedPatches: [
        {
          ...f.appliedPatches[0],
          manifest: {
            ...f.manifest,
            files: [
              { path: "source.txt", beforeSha256: null, afterSha256: sha("x") },
            ],
          },
        },
      ],
    }),
    /overlaps/,
  );
});

test("recorded ignored inputs retain their exact bytes", async (t) => {
  const f = fixture(t),
    hidden = path.join(f.project.dir, "hidden.cpp");
  fs.writeFileSync(
    path.join(f.project.dir, ".git/info/exclude"),
    "hidden.cpp\n",
  );
  fs.writeFileSync(hidden, "recorded");
  const row = {
    path: "framework/hidden.cpp",
    sizeBytes: 8,
    sha256: sha("recorded"),
  };
  f.contract.ignoredInputs = [
    { project: "framework", files: 1, sha256: sha(`${JSON.stringify(row)}\n`) },
  ];
  f.save();
  await verifyPixel10aSource(f);
  fs.writeFileSync(hidden, "modified");
  await assert.rejects(verifyPixel10aSource(f), /Ignored source bytes differ/);
});

test("recorded generated symlinks must remain within the source tree", async (t) => {
  const f = fixture(t),
    link = "vendor/google_devices/stallion/link";
  fs.symlinkSync("kernel", path.join(f.source, link));
  f.contract.generated.files.push({ path: link, link: "kernel" });
  f.save();
  await verifyPixel10aSource(f);
  const outside = path.join(path.dirname(f.source), "outside");
  fs.writeFileSync(outside, "outside");
  fs.unlinkSync(path.join(f.source, link));
  fs.symlinkSync(outside, path.join(f.source, link));
  f.contract.generated.files.at(-1).link = outside;
  f.save();
  await assert.rejects(verifyPixel10aSource(f), /Source link escapes tree/);
});

function profileFixture(t) {
  const f = fixture(t);
  Object.assign(f.contract.manifest, {
    tag: "fixture",
    tagObject: "1".repeat(40),
  });
  f.save();
  const profile = {
    kind: "physical",
    device: {
      sourceTarget: "pixel10a",
      codename: "stallion",
      androidRelease: "17",
    },
    manifest: { url: "https://example.invalid/aosp", ...f.contract.manifest },
    sourceInventory: {
      path: path.basename(f.lock),
      sha256: sha(fs.readFileSync(f.lock)),
    },
  };
  const lockPath = path.join(path.dirname(f.lock), "profiles.json");
  const saveProfile = () =>
    fs.writeFileSync(
      lockPath,
      JSON.stringify({ schemaVersion: 1, profiles: { fixture: profile } }),
    );
  saveProfile();
  return { ...f, profile, lockPath, saveProfile };
}

test("the source profile authenticates the inventory and cannot use partial checkout checks", async (t) => {
  const f = profileFixture(t),
    profile = loadProfile("fixture", f.lockPath);
  assert.throws(
    () => verifyCheckout(profile, f.source),
    /complete source inventory requires verifyProfileSource/,
  );
  assert.throws(
    () =>
      main([
        "--profile",
        "fixture",
        "--lock",
        f.lockPath,
        "--aosp-root",
        f.source,
      ]),
    /requires --aosp-root and --vendor-archive/,
  );
  const direct = await verifyPixel10aSource(f);
  const selected = await verifyProfileSource(profile, {
    aospRoot: f.source,
    archivePath: f.factory,
    lockPath: f.lockPath,
  });
  assert.deepEqual(selected, direct);
  assert.equal(selected.releaseQualified, false);
  f.profile.sourceInventory.sha256 = "0".repeat(64);
  f.saveProfile();
  assert.throws(
    () => loadProfile("fixture", f.lockPath),
    /inventory SHA-256 differs/,
  );
  f.profile.sourceInventory.sha256 = sha(fs.readFileSync(f.lock));
  f.profile.device.codename = "grizzly";
  f.saveProfile();
  assert.throws(
    () => loadProfile("fixture", f.lockPath),
    /target or manifest differs/,
  );
  f.profile.device.codename = "stallion";
  f.profile.sourceInventory.path = "../outside";
  f.saveProfile();
  assert.throws(
    () => loadProfile("fixture", f.lockPath),
    /invalid complete source inventory reference/,
  );
});

test("the shared Pixel 10a source facts do not grant image installation or release qualification", () => {
  const profile = loadProfile("pixel10a");
  assert.equal(
    profile.sourceInventory.sha256,
    "760a7184c62c93aeac40595cf5733f8089aa16ccd28eb7a5f5ce41d4dae741d3",
  );
  const source = JSON.parse(
    fs.readFileSync(
      new URL("../../android/sources/pixel10a-stallion.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(source.releaseQualified, false);
  assert.equal(source.developmentOnly, false);
  const inventory = JSON.parse(
    fs.readFileSync(
      new URL("../../android/hardware-targets.json", import.meta.url),
      "utf8",
    ),
  );
  const target = inventory.targets.find(
    (row) => row.targetId === "pixel10a-stallion",
  );
  assert.equal(target.installerEligible, false);
  assert.equal(target.labExperimentsEligible, false);
});

test("both brands select complete source admission before build orchestration", async (t) => {
  const f = profileFixture(t);
  for (const brandName of ["eliza", "alpha"]) {
    const brand = {
      brand: brandName,
      aospLockPath: f.lockPath,
      aospLockProfile: "fixture",
    };
    await assert.rejects(
      verifyBuildSource({ brand, aospRoot: f.source }),
      /requires --aosp-root and --vendor-archive/,
    );
    const result = await verifyBuildSource({
      brand,
      aospRoot: f.source,
      archivePath: f.factory,
    });
    assert.equal(result.lock, null);
    assert.equal(
      result.sourceEvidence.sourceLockSha256,
      f.profile.sourceInventory.sha256,
    );
    assert.equal(result.sourceEvidence.releaseQualified, false);
  }
  assert.equal(
    parseSubArgs(["--aosp-root", f.source, "--vendor-archive", f.factory])
      .vendorArchive,
    f.factory,
  );
});
