/** Exercises real vendor-tree replacement without touching a device or a full AOSP checkout. */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stageImageLauncher } from "../android/image-launcher.ts";
import { syncToAosp } from "../android/sync-to-aosp.ts";
import { brandFor, fakeTools } from "./image-launcher-fixture.ts";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "aosp-vendor-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const aospRoot = path.join(root, "aosp");
  const sourceVendor = path.join(root, "source");
  mkdirSync(path.join(aospRoot, "build"), { recursive: true });
  writeFileSync(path.join(aospRoot, "build/envsetup.sh"), "# fixture\n");
  mkdirSync(path.join(sourceVendor, "apps/Eliza"), { recursive: true });
  // The unsigned build output is an input to signing, never synced.
  writeFileSync(
    path.join(sourceVendor, "apps/Eliza/Eliza.apk"),
    "unsigned build output",
  );
  const brand = brandFor("eliza_cf_arm64_phone");
  const tools = fakeTools(path.join(root, "tools"), "fixture APK bytes");
  stageImageLauncher({
    brand,
    apk: tools.apk,
    development: true,
    output: path.join(sourceVendor, "launcher"),
    aapt: tools.aapt,
    apksigner: tools.apksigner,
  });
  const target = path.join(aospRoot, "vendor/eliza");
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, "old"), "previous build");
  return { root, aospRoot, sourceVendor, target, brand };
}

test("replaces the vendor tree with the verified launcher and drops stale files", (t) => {
  const f = fixture(t);
  assert.equal(syncToAosp(f), f.target);
  assert.equal(
    readFileSync(path.join(f.target, "launcher/Launcher.apk"), "utf8"),
    "fixture APK bytes",
  );
  assert.equal(existsSync(path.join(f.target, "apps/Eliza/Eliza.apk")), false);
  assert.equal(existsSync(path.join(f.target, "old")), false);
});

test("a missing launcher does not erase the previously staged vendor tree", (t) => {
  const f = fixture(t);
  rmSync(path.join(f.sourceVendor, "launcher"), { recursive: true });
  assert.throws(() => syncToAosp(f), /Missing staged launcher/);
  assert.equal(
    readFileSync(path.join(f.target, "old"), "utf8"),
    "previous build",
  );
});

test("a tampered or mismatched launcher is refused before replacement", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.sourceVendor, "launcher/Launcher.apk"), "other");
  assert.throws(() => syncToAosp(f), /pinned launcher hash/);
  const g = fixture(t);
  assert.throws(
    () => syncToAosp({ ...g, brand: brandFor("eliza_cf_x86_64_phone") }),
    /does not belong/,
  );
  for (const target of [f.target, g.target])
    assert.equal(
      readFileSync(path.join(target, "old"), "utf8"),
      "previous build",
    );
});

test("rejects overlapping trees before deleting source bytes", (t) => {
  const f = fixture(t);
  assert.throws(
    () => syncToAosp({ ...f, sourceVendor: f.target }),
    /must not overlap/,
  );
  assert.equal(existsSync(path.join(f.target, "old")), true);
});

test("rejects a linked vendor parent before modifying its destination", (t) => {
  const f = fixture(t);
  rmSync(path.join(f.aospRoot, "vendor"), { recursive: true });
  symlinkSync(f.sourceVendor, path.join(f.aospRoot, "vendor"));
  assert.throws(() => syncToAosp(f), /must not be a symbolic link/);
  assert.equal(
    existsSync(path.join(f.sourceVendor, "apps/Eliza/Eliza.apk")),
    true,
  );
});

test("invalid vendor names cannot escape the selected checkout", (t) => {
  const f = fixture(t);
  assert.throws(
    () => syncToAosp({ ...f, brand: { ...f.brand, brand: "../../source" } }),
    /simple directory names/,
  );
  assert.equal(
    existsSync(path.join(f.sourceVendor, "apps/Eliza/Eliza.apk")),
    true,
  );
});
