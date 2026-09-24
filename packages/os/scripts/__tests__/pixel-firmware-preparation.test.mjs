/** Exercises locked factory build guards and hardware APK admission against temporary generated trees. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { loadBrandConfig } from "../distro-android/brand-config.mjs";
import { normalizeGeneratedBuildIdGuard } from "../distro-android/prepare-grizzly.mjs";
import { syncToAosp } from "../distro-android/sync-to-aosp.mjs";

function temporaryTree(t) {
  const parent = testOutputPath("pixel-firmware-preparation");
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, "case-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

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
  const target = syncToAosp({ aospRoot, sourceVendor, brand });
  assert.equal(
    fs.readFileSync(path.join(target, "apps/Chromium/Chromium.apk"), "utf8"),
    "chromium admitted fixture bytes",
  );
  pins.chromium.architectures = ["x86_64"];
  fs.writeFileSync(manifest, JSON.stringify(pins));
  assert.throws(
    () => syncToAosp({ aospRoot, sourceVendor, brand }),
    /No verified chromium artifact for arm64/,
  );
  assert.equal(
    fs.readFileSync(path.join(target, "apps/Chromium/Chromium.apk"), "utf8"),
    "chromium admitted fixture bytes",
  );
});
