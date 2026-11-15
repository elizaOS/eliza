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
  assertPixel10aSourceLayout,
  composePixel10aProduct,
  enforceLauncherLockScreenPolicy,
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
  const product =
    brand === "example"
      ? {
          schemaVersion: 1,
          target: "pixel10a",
          sourceProfile: "pixel10a",
          vendorDirectory: "example_phone",
          productName: "example_stallion_phone",
          model: "Example Pixel 10a",
          brand: "Example",
          manufacturer: "Google",
          releaseConfig: "cp2a",
          launcher: {
            moduleName: "ExamplePhone",
            packageName: "org.example.phone",
            refuseLockScreenSurfaces: true,
            assistantRole: false,
            imageProvisioning: {
              module: "ExampleImageCapabilityOverlay",
              overlayable: "ExampleImageProvisioning",
              resource: "example_aosp_image_capability",
            },
          },
          releaseQualified: false,
        }
      : JSON.parse(
          fs.readFileSync(
            new URL(
              `../../android/products/pixel10a-${brand}.json`,
              import.meta.url,
            ),
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

for (const brand of ["example", "eliza"]) {
  test(`${brand} composes the same Pixel 10a hardware with a nonprivileged launcher`, (t) => {
    const f = fixture(t, brand);
    const oldUmask = process.umask(0o077);
    let result: ReturnType<typeof composePixel10aProduct>;
    try {
      result = composePixel10aProduct({ ...f, production: true });
    } finally {
      process.umask(oldUmask);
    }
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
    assert.ok(mk.includes(`vendor/${f.product.vendorDirectory}/product.mk`));
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
    // Only a brand whose presigned launcher reads an overlayable provisioning
    // resource gets the product RRO, and only in a production image.
    const provisioning = f.product.launcher.imageProvisioning;
    if (provisioning) {
      assert.deepEqual(result.imageProvisioning, {
        module: provisioning.module,
        overlayable: provisioning.overlayable,
      });
      assert.match(
        fs.readFileSync(path.join(f.output, "product.mk"), "utf8"),
        new RegExp(`^PRODUCT_PACKAGES \\+= ${provisioning.module}$`, "m"),
      );
      assert.match(
        fs.readFileSync(
          path.join(f.output, "image-capabilities/res/values/capabilities.xml"),
          "utf8",
        ),
        new RegExp(`name="${provisioning.resource}">true<`),
      );
    } else {
      assert.equal(result.imageProvisioning, null);
      assert.equal(
        fs.existsSync(path.join(f.output, "image-capabilities")),
        false,
      );
    }
    const hardware = result.hardwareComposition;
    assert.equal(hardware.vendorDirectory, f.product.vendorDirectory);
    const source = new URL("../../android/devices/pixel10a/", import.meta.url);
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    const sourceNames = fs
      .readdirSync(source, { recursive: true })
      .filter((name) => fs.statSync(new URL(name, source)).isFile())
      .sort();
    assert.deepEqual(
      hardware.files.map((file) => file.sourcePath).sort(),
      sourceNames,
    );
    for (const file of hardware.files) {
      const before = fs.readFileSync(new URL(file.sourcePath, source));
      const after = fs.readFileSync(path.join(f.output, file.path));
      assert.equal(file.sourceSha256, digest(before), file.sourcePath);
      assert.equal(file.sha256, digest(after), file.path);
      assert.equal(
        file.mode,
        fs.statSync(new URL(file.sourcePath, source)).mode & 0o777,
        file.sourcePath,
      );
      assert.equal(
        fs.statSync(path.join(f.output, file.path)).mode & 0o777,
        file.mode,
        "rendered hardware retains source modes under a private umask",
      );
      assert.doesNotMatch(
        after.toString(),
        /@VENDOR_DIRECTORY@|@PIXEL_CONFIG_MODULE@/,
      );
      if (
        !before.includes("@VENDOR_DIRECTORY@") &&
        !before.includes("@PIXEL_CONFIG_MODULE@") &&
        !file.sourcePath.startsWith("vendor-config/")
      )
        assert.deepEqual(after, before, file.sourcePath);
    }
    const device = fs.readFileSync(
      path.join(f.output, "stallion/device.mk"),
      "utf8",
    );
    assert.ok(
      device.includes(
        `include vendor/${f.product.vendorDirectory}/stallion/device-common.mk`,
      ),
    );
    assert.ok(
      device.includes(`PRODUCT_PACKAGES += ${hardware.pixelConfig.moduleName}`),
    );
    for (const patch of ["eliza-product.patch", "enforce-selinux.patch"])
      assert.ok(
        fs
          .readFileSync(path.join(f.output, "stallion/patches", patch), "utf8")
          .includes(`vendor/${f.product.vendorDirectory}/stallion/`),
      );
    const provider = fs.readFileSync(
      path.join(
        f.output,
        "stallion/vendor-config/src",
        hardware.pixelConfig.packageName.replaceAll(".", "/"),
        "FlagsProvider.java",
      ),
      "utf8",
    );
    assert.ok(
      provider.startsWith(`package ${hardware.pixelConfig.packageName};`),
    );
    assert.ok(provider.includes(`return "${hardware.pixelConfig.mimeType}"`));
    assert.match(
      provider,
      /private static final String AUTHORITY = "com.google.android.gsf.gservices"/,
    );
    assert.match(provider, /ApplicationInfo\.FLAG_SYSTEM/);
    assert.match(
      provider,
      /CLIENTS = \{"com.google.euiccpixel", "com.google.android.euicc"\}/,
    );
    const sourceProvider = fs.readFileSync(
      new URL(
        "vendor-config/src/ai/eliza/hardware/pixelconfig/FlagsProvider.java",
        source,
      ),
      "utf8",
    );
    assert.equal(
      provider,
      sourceProvider
        .replaceAll(
          "ai.eliza.hardware.pixelconfig",
          hardware.pixelConfig.packageName,
        )
        .replaceAll(
          "vnd.android.cursor.dir/vnd.eliza.pixel-flags",
          hardware.pixelConfig.mimeType,
        ),
      "provider behavior is unchanged outside explicit installed identity",
    );
    assert.ok(
      fs
        .readFileSync(
          path.join(f.output, "stallion/vendor-config/AndroidManifest.xml"),
          "utf8",
        )
        .includes(`package="${hardware.pixelConfig.packageName}"`),
    );
    assert.ok(
      fs
        .readFileSync(
          path.join(f.output, "stallion/vendor-config/Android.bp"),
          "utf8",
        )
        .includes(`name: "${hardware.pixelConfig.moduleName}"`),
    );
    if (brand === "example") {
      assert.equal(hardware.pixelConfig.moduleName, "PixelConfig");
      assert.equal(
        hardware.pixelConfig.packageName,
        "ai.eliza.hardware.pixelconfig",
      );
    } else assert.deepEqual(hardware.pixelConfig, f.product.pixelConfig);
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
  const f = fixture(t, "example");
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
    new RegExp(
      `^PRODUCT_COPY_FILES \\+= vendor/${f.product.vendorDirectory}/brand/bootanimation\\.zip:\\$\\(TARGET_COPY_OUT_PRODUCT\\)/media/bootanimation\\.zip$`,
      "m",
    ),
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
  const f = fixture(t, "example");
  assert.throws(
    () => validatePixel10aProduct({ ...f.product, releaseQualified: true }),
    /unqualified/,
  );
  for (const vendorDirectory of [
    undefined,
    "",
    "../escape",
    "bad/name",
    "x\nPRODUCT_PACKAGES += Unsafe",
  ])
    assert.throws(
      () => validatePixel10aProduct({ ...f.product, vendorDirectory }),
      /vendorDirectory/,
    );
  for (const pixelConfig of [
    null,
    {},
    { moduleName: "Unsafe", packageName: "bad/name", mimeType: "invalid" },
    {
      moduleName: "Unsafe",
      packageName: "org.example.flags",
      mimeType: "vnd.android.cursor.dir/vnd.example\nunsafe",
    },
    ...[
      f.product.launcher.packageName,
      `${f.product.launcher.packageName}.sense`,
    ].map((packageName) => ({
      moduleName: "PixelConfig",
      packageName,
      mimeType: "vnd.android.cursor.dir/vnd.example.flags",
    })),
    {
      moduleName: ["PixelConfig"],
      packageName: "org.example.flags",
      mimeType: "vnd.android.cursor.dir/vnd.example.flags",
    },
  ])
    assert.throws(
      () => validatePixel10aProduct({ ...f.product, pixelConfig }),
      /pixelConfig/,
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

test("Pixel source staging rejects a selected layout that differs from the admitted source", (t) => {
  const f = fixture(t, "example");
  const file = path.join(
    f.output,
    "vendor/google_devices/stallion/stallion.mk",
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const include = `$(call inherit-product, vendor/${f.product.vendorDirectory}/stallion/device.mk)\n`;
  fs.writeFileSync(file, include);
  assert.deepEqual(assertPixel10aSourceLayout(f.output, f.product), {
    vendorDirectory: f.product.vendorDirectory,
    path: "vendor/google_devices/stallion/stallion.mk",
    sha256: createHash("sha256").update(include).digest("hex"),
  });
  assert.throws(
    () =>
      assertPixel10aSourceLayout(f.output, {
        ...f.product,
        vendorDirectory: "other",
      }),
    /source layout differs/,
  );
  fs.writeFileSync(file, include + include);
  assert.throws(
    () => assertPixel10aSourceLayout(f.output, f.product),
    /source layout differs/,
  );
});

test("a brand that leaves lock-screen capture to Camera2 refuses a launcher shown over Keyguard", (t) => {
  const example = fixture(t, "example").product;
  const eliza = fixture(t, "eliza").product;
  const manifest = (attrs) =>
    [
      "N: android=http://schemas.android.com/apk/res/android",
      "  E: manifest (line=2)",
      "    E: application (line=3)",
      "      E: activity (line=4)",
      `        A: android:name(0x01010003)="${example.launcher.packageName}.Ringing" (Raw: "${example.launcher.packageName}.Ringing")`,
      ...attrs,
    ].join("\n");
  const locked = manifest([
    "        A: android:showWhenLocked(0x01010003)=(type 0x12)0xffffffff",
  ]);
  assert.equal(example.launcher.refuseLockScreenSurfaces, true);
  assert.equal(enforceLauncherLockScreenPolicy(example, manifest([])), true);
  assert.throws(
    () => enforceLauncherLockScreenPolicy(example, locked),
    /Example does not implement[\s\S]*Ringing sets android:showWhenLocked/,
  );
  // Eliza's own launcher keeps its alarm activity over Keyguard.
  assert.equal(eliza.launcher.refuseLockScreenSurfaces, undefined);
  assert.equal(enforceLauncherLockScreenPolicy(eliza, locked), false);
  assert.throws(
    () =>
      validatePixel10aProduct({
        ...example,
        launcher: { ...example.launcher, refuseLockScreenSurfaces: "yes" },
      }),
    /refuseLockScreenSurfaces must be a boolean/,
  );
});

test("only a product that says so stages without the assistant role", (t) => {
  const example = fixture(t, "example").product;
  const eliza = fixture(t, "eliza").product;
  assert.equal(example.launcher.assistantRole, false);
  assert.equal(eliza.launcher.assistantRole, undefined);
  assert.throws(
    () =>
      validatePixel10aProduct({
        ...example,
        launcher: { ...example.launcher, assistantRole: "no" },
      }),
    /assistantRole must be a boolean/,
  );
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

test("development images keep the launcher's provisioning default and malformed provisioning is refused", (t) => {
  const f = fixture(t, "example");
  const result = composePixel10aProduct({ ...f, production: false });
  assert.equal(result.imageProvisioning, null);
  assert.equal(fs.existsSync(path.join(f.output, "image-capabilities")), false);
  for (const imageProvisioning of [
    null,
    { module: "Example", extra: true },
    { resource: "Not-A-Resource" },
  ])
    assert.throws(
      () =>
        validatePixel10aProduct({
          ...f.product,
          launcher: { ...f.product.launcher, imageProvisioning },
        }),
      /imageProvisioning|Invalid/,
    );
});

test("a product can stage the disabled updater with exact source evidence", (t) => {
  const f = fixture(t, "example");
  f.product.systemUpdater = true;
  const result = composePixel10aProduct({ ...f, production: true });
  assert.equal(result.systemUpdater.staged, true);
  assert.equal(result.systemUpdater.enabled, false);
  assert.equal(result.systemUpdater.files.length, 18);
  for (const file of result.systemUpdater.files) {
    assert.equal(
      createHash("sha256")
        .update(fs.readFileSync(path.join(f.output, file.path)))
        .digest("hex"),
      file.sha256,
    );
  }
  assert.match(
    fs.readFileSync(path.join(f.output, "product.mk"), "utf8"),
    /inherit-product, vendor\/example_phone\/system-updater\/product.mk/,
  );
  assert.match(
    fs.readFileSync(
      path.join(f.output, "system-updater/res/values/config.xml"),
      "utf8",
    ),
    /<bool name="os_update_enabled">false<\/bool>/,
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(f.output, "Android.bp"), "utf8"),
    /privileged/,
  );
  assert.equal(result.imageBuilt, false);
  assert.equal(result.deviceAcceptanceVerified, false);
});

test("updater enrollment cannot be smuggled into the staging switch", (t) => {
  const f = fixture(t, "example");
  f.product.systemUpdater = { enabled: true };
  assert.throws(
    () => composePixel10aProduct(f),
    /systemUpdater must be a boolean/,
  );
  assert.equal(fs.existsSync(path.join(f.output, "system-updater")), false);
  assert.equal(
    fs.existsSync(path.join(f.output, "physical-product.json")),
    false,
  );
});

test("an existing updater staging directory is retained on refusal", (t) => {
  const f = fixture(t, "example");
  f.product.systemUpdater = true;
  const directory = path.join(f.output, "system-updater");
  fs.mkdirSync(directory);
  const marker = path.join(directory, "keep.txt");
  fs.writeFileSync(marker, "preexisting state");
  assert.throws(
    () => composePixel10aProduct(f),
    /composition already exists: system-updater/,
  );
  assert.equal(fs.readFileSync(marker, "utf8"), "preexisting state");
  assert.deepEqual(fs.readdirSync(directory), ["keep.txt"]);
});
