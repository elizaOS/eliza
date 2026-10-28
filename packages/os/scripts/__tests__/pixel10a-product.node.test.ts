import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderProvisioningOverlay } from "../android/launcher-provisioning.mjs";
import { inspectBootAnimationArchive } from "../android/pixel10a-brand-assets.mjs";
import {
  composePixel10aProduct,
  renderSensePermissions,
  validatePixel10aProduct,
} from "../android/pixel10a-product.ts";
import { soongAppNativePatch } from "../android/soong-app-native.mjs";
import { renderOverlay } from "../android/stage-launcher-overlay.ts";
import {
  main as stageMain,
  stagePixel10aProduct,
} from "../android/stage-pixel10a-product.ts";

function fixture(t, brand) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "pixel10a-product-"));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const product = JSON.parse(
    fs.readFileSync(
      new URL(`../../android/products/pixel10a-${brand}.json`, import.meta.url),
      "utf8",
    ),
  );
  const launcher = {
    schemaVersion: 1,
    brand,
    ...product.launcher,
    apkSha256: "a".repeat(64),
    certificateSha256: "b".repeat(64),
  };
  const overlay = renderOverlay(launcher);
  fs.writeFileSync(path.join(output, "Android.bp"), overlay.blueprint);
  fs.writeFileSync(path.join(output, "product.mk"), overlay.product);
  return {
    output,
    product,
    launcher,
    sourceEvidence: { fixture: true, releaseQualified: false },
  };
}

for (const brand of ["alpha", "eliza"]) {
  test(`${brand} composes the same Pixel 10a hardware with a nonprivileged launcher`, (t) => {
    const f = fixture(t, brand);
    const result = composePixel10aProduct({ ...f, production: true });
    assert.equal(result.releaseQualified, false);
    assert.equal(result.imageBuilt, false);
    assert.equal(result.imageSigned, false);
    assert.equal(result.deviceAcceptanceVerified, false);
    assert.equal(result.nativeLibrariesStaged, false);
    const blueprint = fs.readFileSync(
      path.join(f.output, "Android.bp"),
      "utf8",
    );
    assert.doesNotMatch(blueprint, /privileged/);
    const mk = fs.readFileSync(
      path.join(f.output, `${f.product.productName}.mk`),
      "utf8",
    );
    assert.match(mk, /vendor\/google_devices\/stallion\/stallion.mk/);
    assert.match(mk, /vendor\/alphaphone\/product.mk/);
    assert.doesNotMatch(
      mk,
      /eliza_common|BOARD_AVB|privapp|default-permissions/,
    );
    assert.match(mk, new RegExp(`PRODUCT_MODEL := ${f.product.model}`));
    // Alarms and timers stay with the system Clock in both brands' images.
    assert.equal(
      fs
        .readFileSync(path.join(f.output, "product.mk"), "utf8")
        .match(/^PRODUCT_PACKAGES \+= DeskClock$/gm)?.length,
      1,
    );
    assert.match(
      fs.readFileSync(path.join(f.output, "AndroidProducts.mk"), "utf8"),
      new RegExp(`${f.product.productName}-cp2a-user\\b`),
    );
    // Every brand's Pixel image declares its launcher's image feature once.
    const feature = `${f.launcher.packageName}.aosp_image`;
    assert.deepEqual(result.imageFeature, { feature, version: 1 });
    assert.equal(
      fs
        .readFileSync(path.join(f.output, "product.mk"), "utf8")
        .split(`/etc/permissions/${feature}.xml`).length - 1,
      1,
    );
    assert.equal(result.vendorApi, null, "staging records the checked API");
    const source = new URL("../../android/devices/pixel10a/", import.meta.url);
    for (const name of fs.readdirSync(source, { recursive: true })) {
      const file = new URL(name, source);
      if (fs.statSync(file).isFile())
        assert.deepEqual(
          fs.readFileSync(path.join(f.output, "stallion", name)),
          fs.readFileSync(file),
          name,
        );
    }
  });
  test(`${brand} listener keeps exactly the two approved privileges`, (t) => {
    const f = fixture(t, brand);
    const permissions = path.join(f.output, "listener", "permissions");
    fs.mkdirSync(permissions, { recursive: true });
    const file = path.join(
      permissions,
      `privapp-permissions-${f.launcher.packageName}.sense.xml`,
    );
    const minimal = renderSensePermissions(f.launcher.packageName);
    fs.writeFileSync(
      file,
      minimal.replace(
        "</privapp-permissions>",
        '<permission name="android.permission.INTERNET" /></privapp-permissions>',
      ),
    );
    assert.throws(() => composePixel10aProduct(f), /exact minimal Sense/);
    assert.equal(fs.existsSync(path.join(f.output, "stallion")), false);
    fs.writeFileSync(file, minimal);
    composePixel10aProduct(f);
    assert.doesNotMatch(
      minimal,
      /RECORD_AUDIO|INTERNET|READ_PHONE_STATE|BYPASS/,
    );
  });
}

test("a launcher product that already requires DeskClock keeps one requirement", (t) => {
  const f = fixture(t, "alpha");
  fs.appendFileSync(
    path.join(f.output, "product.mk"),
    "\n# Brand staging\nPRODUCT_PACKAGES += DeskClock\n",
  );
  composePixel10aProduct(f);
  assert.equal(
    fs
      .readFileSync(path.join(f.output, "product.mk"), "utf8")
      .match(/DeskClock/g)?.length,
    1,
  );
});

/** A bootanimation.zip; `stored` false deflates its entries. */
function bootAnimation(
  dir,
  name,
  { stored = true, desc = "1080 2400 30\np 1 0 part0\n" } = {},
) {
  const file = path.join(dir, name);
  execFileSync("python3", [
    "-c",
    "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_STORED if sys.argv[2]=='1' else zipfile.ZIP_DEFLATED)\nz.writestr('desc.txt',sys.argv[3])\nz.writestr('part0/00001.png',b'\\x89PNG'+bytes(64))\nz.close()",
    file,
    stored ? "1" : "0",
    desc,
  ]);
  return file;
}

test("a pinned brand boot animation is installed exactly; unpinned, compressed or different archives are refused", (t) => {
  const f = fixture(t, "eliza");
  const archive = bootAnimation(f.output, "brand-boot.zip");
  const sha256 = createHash("sha256")
    .update(fs.readFileSync(archive))
    .digest("hex");
  // Without a pin in the composition no asset is accepted, and none is installed.
  assert.throws(
    () => composePixel10aProduct({ ...f, bootAnimation: archive }),
    /pins no boot animation/,
  );
  const pinned = { ...f.product, brandAssets: { bootAnimation: { sha256 } } };
  assert.throws(
    () => composePixel10aProduct({ ...f, product: pinned }),
    /supply the reviewed bootanimation\.zip/,
  );
  assert.throws(
    () =>
      composePixel10aProduct({
        ...f,
        product: {
          ...f.product,
          brandAssets: { bootAnimation: { sha256: "0".repeat(64) } },
        },
        bootAnimation: archive,
      }),
    /not the composition's pinned/,
  );
  assert.throws(
    () =>
      validatePixel10aProduct({ ...f.product, brandAssets: { wallpaper: {} } }),
    /may only pin a bootAnimation/,
  );
  const compressed = bootAnimation(f.output, "compressed.zip", {
    stored: false,
  });
  const compressedSha = createHash("sha256")
    .update(fs.readFileSync(compressed))
    .digest("hex");
  assert.throws(
    () =>
      composePixel10aProduct({
        ...f,
        product: {
          ...f.product,
          brandAssets: { bootAnimation: { sha256: compressedSha } },
        },
        bootAnimation: compressed,
      }),
    /is compressed; every entry must be stored/,
  );
  assert.equal(
    fs.existsSync(path.join(f.output, "stallion")),
    false,
    "refusals write nothing",
  );
  const evidence = composePixel10aProduct({
    ...f,
    product: pinned,
    bootAnimation: archive,
  });
  assert.deepEqual(evidence.brandAssets.bootAnimation, {
    sha256,
    sizeBytes: fs.statSync(archive).size,
    parts: ["part0"],
  });
  assert.deepEqual(
    fs.readFileSync(path.join(f.output, "brand/bootanimation.zip")),
    fs.readFileSync(archive),
  );
  assert.match(
    fs.readFileSync(path.join(f.output, `${f.product.productName}.mk`), "utf8"),
    /^PRODUCT_COPY_FILES \+= vendor\/alphaphone\/brand\/bootanimation\.zip:\$\(TARGET_COPY_OUT_PRODUCT\)\/media\/bootanimation\.zip$/m,
  );
  assert.throws(
    () =>
      inspectBootAnimationArchive(
        fs.readFileSync(
          bootAnimation(f.output, "empty-part.zip", {
            desc: "1080 2400 30\np 1 0 part1\n",
          }),
        ),
      ),
    /part part1 has no PNG frames/,
  );
  assert.throws(
    () => inspectBootAnimationArchive(Buffer.from("not a zip archive at all")),
    /end-of-central-directory/,
  );
});

test("changed privilege policy, product identity and qualified claims fail before composition", (t) => {
  const f = fixture(t, "alpha");
  assert.throws(
    () => validatePixel10aProduct({ ...f.product, releaseQualified: true }),
    /unqualified/,
  );
  assert.throws(
    () =>
      validatePixel10aProduct({
        ...f.product,
        model: "bad\nPRODUCT_PACKAGES += Unsafe",
      }),
    /model/,
  );
  assert.throws(
    () =>
      composePixel10aProduct({
        ...f,
        launcher: { ...f.launcher, packageName: "example.foreign" },
      }),
    /identity/,
  );
  fs.appendFileSync(path.join(f.output, "Android.bp"), "\nprivileged: true\n");
  assert.throws(() => composePixel10aProduct(f), /nonprivileged/);
  assert.equal(fs.existsSync(path.join(f.output, "stallion")), false);
});

test("shared provisioning takes actual component names and leaves absent Autofill unset", () => {
  const files = renderProvisioningOverlay("ai.elizaos.app", {
    home: "ai.elizaos.app.MainActivity",
    assistant: "ai.elizaos.app.AssistActivity",
    autofill: null,
  });
  const config =
    files[
      "provisioning/overlay/frameworks/base/core/res/res/values/config.xml"
    ];
  assert.match(config, /ai.elizaos.app/);
  assert.doesNotMatch(config, /config_defaultAutofillService/);
  assert.doesNotMatch(files["provisioning/README.md"], /Autofill offer|\/null/);
  assert.throws(
    () =>
      renderProvisioningOverlay("ai.elizaos.app", {
        home: "bad/component",
        assistant: "ai.elizaos.app.AssistActivity",
      }),
    /fully qualified/,
  );
});

test("Pixel staging requires explicit source and archive inputs", async () => {
  await assert.rejects(stageMain([]), /requires product/);
  await assert.rejects(
    stageMain(["--product", "input", "--surprise", "value"]),
    /Expected Pixel/,
  );
});

test("Pixel staging refuses output inside the source tree before any write", async (t) => {
  const f = fixture(t, "eliza");
  const product = path.join(f.output, "product.json"),
    descriptor = path.join(f.output, "launcher.json");
  fs.writeFileSync(product, JSON.stringify(f.product));
  fs.writeFileSync(descriptor, JSON.stringify(f.launcher));
  const source = path.join(f.output, "source");
  fs.mkdirSync(source);
  const link = path.join(f.output, "source-link");
  fs.symlinkSync(source, link, "dir");
  for (const output of [
    path.join(source, "output"),
    path.join(link, "nested", "output"),
  ]) {
    await assert.rejects(
      stagePixel10aProduct({ product, descriptor, output, aospRoot: source }),
      /outside the AOSP source tree/,
    );
    assert.equal(fs.existsSync(output), false);
  }
});

test("a Makefile without admission never proves native staging", (t) => {
  const f = fixture(t, "eliza");
  fs.writeFileSync(
    path.join(f.output, "Android.mk"),
    "LOCAL_PRODUCT_MODULE := true\n",
  );
  const report = composePixel10aProduct(f);
  assert.equal(report.nativeLibrariesStaged, false);
});

test("Soong native installation uses the pinned source patch without ELF check overrides", () => {
  const envelope = soongAppNativePatch();
  const lock = fs.readFileSync(
    new URL("../../android/sources/pixel10a-stallion.json", import.meta.url),
  );
  assert.equal(envelope.name, "soong-app-native");
  assert.equal(
    envelope.manifest.baselineLockSha256,
    createHash("sha256").update(lock).digest("hex"),
  );
  assert.equal(
    envelope.manifest.revision,
    JSON.parse(lock).projects.find((entry) => entry.path === "build/soong")
      .commit,
  );
  const patch = fs.readFileSync(
    new URL(
      `../../android/patches/soong-app-native/${envelope.manifest.patch}`,
      import.meta.url,
    ),
    "utf8",
  );
  assert.doesNotMatch(
    patch,
    /BUILD_BROKEN|Check_elf_files|check_elf_files|prebuilt_any/,
  );
});
