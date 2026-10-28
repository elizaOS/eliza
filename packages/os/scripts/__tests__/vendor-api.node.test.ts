/** The stock vendor API contract shared by the Pixel 10a (stallion) and Pixel 11 Pro (grizzly) products. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertGeneratedVintfApi,
  assertStockVendorApi,
  readReleaseBoardApi,
} from "../android/vendor-api.mjs";

const read = (relative) =>
  JSON.parse(
    fs.readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8"),
  );

function tree(t, { codename, releaseConfig, boardApi, vintfApi }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-api-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const flag = path.join(
    root,
    "build/release/flag_values",
    releaseConfig,
    "RELEASE_BOARD_API_LEVEL.textproto",
  );
  const manifest = path.join(
    root,
    "vendor/google_devices",
    codename,
    "vintf/vendor/manifest.xml",
  );
  for (const file of [flag, manifest])
    fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    flag,
    `name: "RELEASE_BOARD_API_LEVEL"\nvalue: {\n  string_value: "${boardApi}"\n}\n`,
  );
  fs.writeFileSync(
    manifest,
    `<manifest version="8.0" type="device">\n  <sepolicy>\n    <version>${vintfApi}</version>\n  </sepolicy>\n</manifest>\n`,
  );
  return { root, flag, manifest };
}

const stallion = () => {
  const profile = read("android/aosp.lock.json").profiles.pixel10a;
  return {
    codename: profile.device.codename,
    vendorApiLevel: profile.device.vendorApiLevel,
  };
};

test("the Pixel 10a source profile locks the stock stallion vendor API", () => {
  const { codename, vendorApiLevel } = stallion();
  assert.equal(codename, "stallion");
  assert.match(vendorApiLevel, /^[0-9]{6}$/);
  // Every brand's Pixel 10a product lunches a release configuration that must
  // carry this level; the shared hardware target names the same release.
  const target = read("android/hardware-targets.json").targets.find(
    (entry) => entry.targetId === "pixel10a-stallion",
  );
  for (const brand of ["eliza", "alpha"]) {
    const product = read(`android/products/pixel10a-${brand}.json`);
    assert.equal(product.sourceProfile, "pixel10a");
    assert.ok(
      target.lunchTarget.endsWith(`-${product.releaseConfig}-user`),
      `${brand} release ${product.releaseConfig} matches the hardware target`,
    );
  }
});

test("a stallion tree whose release and vendor VINTF carry the locked API is admitted", (t) => {
  const { codename, vendorApiLevel } = stallion();
  const { root, manifest } = tree(t, {
    codename,
    releaseConfig: "cp2a",
    boardApi: vendorApiLevel,
    vintfApi: vendorApiLevel,
  });
  const before = fs.readFileSync(manifest, "utf8");
  assert.deepEqual(
    assertStockVendorApi(root, {
      codename,
      releaseConfig: "cp2a",
      vendorApiLevel,
    }),
    { codename, releaseConfig: "cp2a", vendorApiLevel },
  );
  assert.equal(readReleaseBoardApi(root, "cp2a"), vendorApiLevel);
  assert.equal(fs.readFileSync(manifest, "utf8"), before, "never rewritten");
});

test("a development release with a different board API is refused, not rewritten", (t) => {
  const { codename, vendorApiLevel } = stallion();
  const { root, manifest } = tree(t, {
    codename,
    releaseConfig: "cp2a",
    boardApi: "202704",
    vintfApi: vendorApiLevel,
  });
  const before = fs.readFileSync(manifest, "utf8");
  assert.throws(
    () =>
      assertStockVendorApi(root, {
        codename,
        releaseConfig: "cp2a",
        vendorApiLevel,
      }),
    /\[distro-android:stallion\] Pixel release cp2a does not match stock vendor API/,
  );
  assert.equal(fs.readFileSync(manifest, "utf8"), before);
});

test("a vendor VINTF manifest with another sepolicy version is refused", (t) => {
  const { codename, vendorApiLevel } = stallion();
  const { root } = tree(t, {
    codename,
    releaseConfig: "cp2a",
    boardApi: vendorApiLevel,
    vintfApi: "202504",
  });
  assert.throws(
    () =>
      assertStockVendorApi(root, {
        codename,
        releaseConfig: "cp2a",
        vendorApiLevel,
      }),
    /must retain locked API/,
  );
});

test("missing, ambiguous or unlocked inputs are refused", (t) => {
  const { codename, vendorApiLevel } = stallion();
  const { root, flag, manifest } = tree(t, {
    codename,
    releaseConfig: "cp2a",
    boardApi: vendorApiLevel,
    vintfApi: vendorApiLevel,
  });
  assert.throws(
    () =>
      assertStockVendorApi(root, {
        codename,
        releaseConfig: "cp2a",
        vendorApiLevel: undefined,
      }),
    /Missing locked vendor API level/,
  );
  assert.throws(
    () => readReleaseBoardApi(root, "cp9z"),
    /declares no board API level/,
  );
  assert.throws(
    () => readReleaseBoardApi(root, "../cp2a"),
    /release configuration is required/,
  );
  assert.throws(
    () => assertGeneratedVintfApi(root, vendorApiLevel, "../stallion"),
    /Invalid device codename/,
  );
  assert.throws(
    () => assertGeneratedVintfApi(root, vendorApiLevel, "grizzly"),
    /grizzly vendor VINTF manifest is missing/,
  );
  fs.appendFileSync(flag, 'value: { string_value: "202604" }\n');
  assert.throws(
    () => readReleaseBoardApi(root, "cp2a"),
    /must declare one board API/,
  );
  fs.writeFileSync(
    manifest,
    `<manifest><sepolicy><version>${vendorApiLevel}</version></sepolicy><sepolicy><version>${vendorApiLevel}</version></sepolicy></manifest>`,
  );
  assert.throws(
    () => assertGeneratedVintfApi(root, vendorApiLevel, codename),
    /must retain locked API/,
  );
});
