/** Exercises locked factory build guards and hardware APK admission against temporary generated trees. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { loadBrandConfig } from "../distro-android/brand-config.ts";
import {
  assertGeneratedVintfApi,
  grizzlyLunchTarget,
  normalizeGeneratedBuildIdGuard,
  withLockedVendorReference,
} from "../distro-android/prepare-grizzly.ts";
import { syncToAosp } from "../distro-android/sync-to-aosp.ts";

function temporaryTree(t) {
  const parent = testOutputPath("pixel-firmware-preparation");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Pixel release selection preserves the stock policy API and rejects development API drift", (t) => {
  const root = temporaryTree(t);
  const flag = path.join(
    root,
    "build/release/flag_values/cp2a/RELEASE_BOARD_API_LEVEL.textproto",
  );
  const manifest = path.join(
    root,
    "vendor/google_devices/grizzly/vintf/vendor/manifest.xml",
  );
  for (const file of [flag, manifest])
    fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    flag,
    'name: "RELEASE_BOARD_API_LEVEL"\nvalue: { string_value: "202604" }\n',
  );
  const xml =
    "<manifest><sepolicy><version>202604</version></sepolicy></manifest>\n";
  fs.writeFileSync(manifest, xml);
  const lock = {
    device: {
      productName: "eliza_grizzly_phone",
      releaseConfig: "cp2a",
      vendorApiLevel: "202604",
    },
  };
  const brand = loadBrandConfig(
    new URL("../distro-android/brand.eliza-grizzly.json", import.meta.url)
      .pathname,
  );
  const hardware = JSON.parse(
    fs.readFileSync(
      new URL("../../android/hardware-targets.json", import.meta.url),
      "utf8",
    ),
  ).targets.find((target) => target.targetId === "pixel11pro-grizzly");
  assert.equal(hardware.lunchTarget, brand.lunchTarget);
  assert.equal(grizzlyLunchTarget(root, lock), brand.lunchTarget);
  assertGeneratedVintfApi(root, lock.device.vendorApiLevel);
  assert.equal(fs.readFileSync(manifest, "utf8"), xml);
  fs.writeFileSync(flag, 'value: { string_value: "202704" }\n');
  assert.throws(
    () => grizzlyLunchTarget(root, lock),
    /does not match stock vendor API/,
  );
  fs.writeFileSync(manifest, xml.replace("202604", "202704"));
  assert.throws(
    () => assertGeneratedVintfApi(root, lock.device.vendorApiLevel),
    /must retain locked API/,
  );
  assert.equal(
    fs.readFileSync(manifest, "utf8"),
    xml.replace("202604", "202704"),
  );
});

test("locked vendor inputs restore the upstream checkout after successful and failed generation", (t) => {
  const root = temporaryTree(t);
  const tool = path.join(root, "vendor/adevtool");
  const spec = path.join(tool, "vendor-specs/google_devices/grizzly.yml");
  const index = path.join(tool, "config/build-index/build-index-main.yml");
  for (const file of [spec, index])
    fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(spec, "original reference\n");
  fs.writeFileSync(index, "original build index\n");
  const candidate = Buffer.from("candidate reference\n");
  fs.writeFileSync(path.join(root, "candidate.yml"), candidate);
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const lock = {
    device: { codename: "grizzly", buildId: "CD1A.260905.001.B1" },
    referenceFactoryImage: {
      buildId: "CD1A.260905.001.B1",
      filename: "grizzly-b1.zip",
      url: "https://dl.google.com/dl/android/aosp/grizzly-b1.zip",
      sha256: "a".repeat(64),
    },
    generatedVendor: {
      referenceSpec: {
        path: "candidate.yml",
        sizeBytes: candidate.length,
        sha256: hash(candidate),
        baseSha256: hash(fs.readFileSync(spec)),
      },
    },
  };
  for (const fails of [false, true]) {
    const operation = () => {
      assert.deepEqual(fs.readFileSync(spec), candidate);
      assert.match(
        fs.readFileSync(index, "utf8"),
        /grizzly CD1A\.260905\.001\.B1:/,
      );
      assert.throws(() =>
        withLockedVendorReference(root, lock, () => {}, root),
      );
      if (fails) throw new Error("generator failed");
      return "generated";
    };
    if (fails)
      assert.throws(
        () => withLockedVendorReference(root, lock, operation, root),
        /generator failed/,
      );
    else
      assert.equal(
        withLockedVendorReference(root, lock, operation, root),
        "generated",
      );
    assert.equal(fs.readFileSync(spec, "utf8"), "original reference\n");
    assert.equal(fs.readFileSync(index, "utf8"), "original build index\n");
    assert.equal(
      fs.existsSync(path.join(tool, ".elizaos-vendor-reference")),
      false,
    );
  }
  fs.writeFileSync(path.join(root, "candidate.yml"), "corrupt");
  assert.throws(
    () =>
      withLockedVendorReference(
        root,
        lock,
        () => assert.fail("must not run"),
        root,
      ),
    /digest mismatch/,
  );
  assert.equal(fs.readFileSync(spec, "utf8"), "original reference\n");
});

test("a matched newer factory guard permits the AOSP source build without losing its stock identity", (t) => {
  const root = temporaryTree(t);
  const generated = path.join(root, "vendor/google_devices/grizzly");
  fs.mkdirSync(generated, { recursive: true });
  const makefile = path.join(generated, "grizzly.mk");
  const buildId = "CD1A.260905.001.B1";
  fs.writeFileSync(
    makefile,
    `ifneq ($(BUILD_ID),${buildId})\n  $(error BUILD_ID: expected ${buildId}, got $(BUILD_ID))\nendif\n.PHONY: all\nall:\n\t@echo built\n`,
  );
  const run = () =>
    spawnSync("make", ["-f", makefile, "BUILD_ID=BP2A.250805.005"], {
      encoding: "utf8",
    });
  assert.notEqual(run().status, 0);
  normalizeGeneratedBuildIdGuard(root, buildId);
  const normalized = fs.readFileSync(makefile, "utf8");
  normalizeGeneratedBuildIdGuard(root, buildId);
  assert.equal(fs.readFileSync(makefile, "utf8"), normalized);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /factory CD1A\.260905\.001\.B1/);
  assert.throws(
    () => normalizeGeneratedBuildIdGuard(root, "CD1A.260714.001.A9"),
    /does not match/,
  );
  assert.equal(fs.readFileSync(makefile, "utf8"), normalized);
});

test("Pixel sync admits matching ARM64 app bytes and rejects x86 pins before replacing vendor output", (t) => {
  const root = temporaryTree(t);
  const aospRoot = path.join(root, "aosp");
  const sourceVendor = path.join(root, "vendor");
  const brand = loadBrandConfig(
    new URL("../distro-android/brand.eliza-grizzly.json", import.meta.url)
      .pathname,
  );
  fs.mkdirSync(path.join(aospRoot, "build"), { recursive: true });
  fs.writeFileSync(path.join(aospRoot, "build/envsetup.sh"), "# fixture\n");
  fs.mkdirSync(path.join(sourceVendor, "apps/Eliza"), { recursive: true });
  fs.writeFileSync(
    path.join(sourceVendor, "apps/Eliza/Eliza.apk"),
    "Eliza fixture",
  );
  fs.mkdirSync(path.join(sourceVendor, "manifests"));
  const pins = JSON.parse(
    fs.readFileSync(
      new URL(
        "../../android/vendor/eliza/manifests/browser-apps.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  pins.schemaVersion = 1;
  pins.chromium = pins.chromium.variants.arm64;
  for (const [name, directory] of [
    ["chromium", "Chromium"],
    ["bitwarden", "Bitwarden"],
  ]) {
    const bytes = Buffer.from(`${name} admitted fixture bytes`);
    fs.mkdirSync(path.join(sourceVendor, "apps", directory), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(sourceVendor, "apps", directory, `${directory}.apk`),
      bytes,
    );
    pins[name].sha256 = createHash("sha256").update(bytes).digest("hex");
    pins[name].architectures = ["arm64"];
  }
  const manifest = path.join(sourceVendor, "manifests/browser-apps.json");
  fs.writeFileSync(manifest, JSON.stringify(pins));
  assert.throws(
    () => syncToAosp({ aospRoot, sourceVendor, brand }),
    /development snapshot/,
  );
  const target = syncToAosp({
    aospRoot,
    sourceVendor,
    brand,
    allowDevelopmentBrowser: true,
  });
  assert.equal(
    fs.readFileSync(path.join(target, "apps/Chromium/Chromium.apk"), "utf8"),
    "chromium admitted fixture bytes",
  );
  pins.chromium.architectures = ["x86_64"];
  fs.writeFileSync(manifest, JSON.stringify(pins));
  assert.throws(
    () =>
      syncToAosp({
        aospRoot,
        sourceVendor,
        brand,
        allowDevelopmentBrowser: true,
      }),
    /No verified chromium artifact for arm64/,
  );
  assert.equal(
    fs.readFileSync(path.join(target, "apps/Chromium/Chromium.apk"), "utf8"),
    "chromium admitted fixture bytes",
  );
});
