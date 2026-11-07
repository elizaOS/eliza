// Booted-image expectations for the nonprivileged-launcher profile, checked
// against fabricated adb output. Not image boot or device evidence.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultApkPath } from "../android/avd-test.ts";
import {
  assertLauncherPackagePath,
  assertNonprivilegedPackageDump,
  assertRecoveryHome,
  assertRoleHolders,
  UNGRANTED_PRIVILEGED_PERMISSIONS,
} from "../android/boot-validate.ts";
import { loadBrandConfig } from "../android/brand-config.ts";
import { installedLauncherPath } from "../android/image-launcher.ts";

const brand = loadBrandConfig(
  new URL("../android/brand.eliza.json", import.meta.url).pathname,
);
const PKG = brand.packageName;
const grants = [
  "android.permission.RECORD_AUDIO",
  "android.permission.POST_NOTIFICATIONS",
];

test("the launcher must be installed only at its nonprivileged product path", () => {
  const expected = installedLauncherPath(brand);
  assert.equal(expected, "/product/app/Eliza/Eliza.apk");
  assert.equal(
    assertLauncherPackagePath(`package:${expected}\n`, expected),
    expected,
  );
  for (const output of [
    "package:/system/priv-app/Eliza/Eliza.apk",
    "",
    `package:${expected}\npackage:/data/app/~~x/ai.elizaos.app/base.apk`,
  ])
    assert.throws(
      () => assertLauncherPackagePath(output, expected),
      /installed only at/,
    );
  assert.equal(
    installedLauncherPath({ ...brand, productName: "eliza_gsi_arm64" }),
    "/system/app/Eliza/Eliza.apk",
  );
});

test("HOME and assistant are required; dialer and SMS are not", () => {
  const holders = {
    "android.app.role.HOME": PKG,
    "android.app.role.ASSISTANT": PKG,
    "android.app.role.DIALER": "com.android.dialer",
    "android.app.role.SMS": "com.android.messaging",
  };
  assert.equal(assertRoleHolders(holders, PKG), holders);
  assert.throws(
    () =>
      assertRoleHolders({ ...holders, "android.app.role.ASSISTANT": "" }, PKG),
    /ASSISTANT holder/,
  );
  assert.throws(
    () =>
      assertRoleHolders(
        { ...holders, "android.app.role.HOME": "com.android.launcher3" },
        PKG,
      ),
    /HOME holder/,
  );
});

test("a stock HOME stays installed as the recovery path", () => {
  assert.deepEqual(
    assertRecoveryHome(
      `${PKG}/.MainActivity\ncom.android.launcher3/com.android.launcher3.uioverrides.QuickstepLauncher\n`,
      PKG,
    ),
    ["com.android.launcher3"],
  );
  assert.throws(
    () => assertRecoveryHome(`${PKG}/.MainActivity\n`, PKG),
    /No recovery HOME/,
  );
});

test("the package is a system app, never privileged, with only reviewed grants", () => {
  const dump = [
    "pkgFlags=[ SYSTEM HAS_CODE ALLOW_CLEAR_USER_DATA ]",
    "privateFlags=[ PRIVATE_FLAG_ACTIVITIES_RESIZE_MODE_RESIZEABLE PRODUCT ]",
    ...grants.map(
      (name) => `      ${name}: granted=true, flags=[ GRANTED_BY_DEFAULT ]`,
    ),
    "      android.permission.MANAGE_APP_OPS_MODES: granted=false",
  ].join("\n");
  assert.equal(assertNonprivilegedPackageDump(dump, brand, grants), dump);
  assert.throws(
    () =>
      assertNonprivilegedPackageDump(
        dump.replace("PRODUCT ]", "PRIVILEGED PRODUCT ]"),
        brand,
        grants,
      ),
    /must not be a privileged app/,
  );
  assert.throws(
    () =>
      assertNonprivilegedPackageDump(
        dump.replace(
          "RECORD_AUDIO: granted=true",
          "RECORD_AUDIO: granted=false",
        ),
        brand,
        grants,
      ),
    /RECORD_AUDIO grant/,
  );
  for (const permission of UNGRANTED_PRIVILEGED_PERMISSIONS)
    assert.throws(
      () =>
        assertNonprivilegedPackageDump(
          `${dump}\n      ${permission}: granted=true`,
          brand,
          grants,
        ),
      /must not be granted/,
    );
});

test("AVD installs prefer the staged signed launcher over the unsigned build output", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "avd-launcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const unsigned = path.join(root, brand.vendorDir, "apps/Eliza/Eliza.apk");
  assert.equal(defaultApkPath(brand, root), unsigned);
  const staged = path.join(root, brand.vendorDir, "launcher/Launcher.apk");
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, "signed");
  assert.equal(defaultApkPath(brand, root), staged);
});

test("grizzly bundles require the staged launcher pin and refuse the platform key", async (t) => {
  const { assertLauncherSigner, LAUNCHER_INSTALL_PATH, readLauncherPin } =
    await import("../android/build-grizzly-bundle.ts");
  assert.equal(LAUNCHER_INSTALL_PATH, "product/app/Eliza/Eliza.apk");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grizzly-pin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => readLauncherPin(root), /missing or unreadable/);
  const file = path.join(root, "vendor/eliza/launcher/launcher.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const pin = {
    packageName: PKG,
    apkSha256: "a".repeat(64),
    certificateSha256: "b".repeat(64),
  };
  fs.writeFileSync(file, JSON.stringify({ ...pin, partition: "system" }));
  assert.throws(() => readLauncherPin(root), /product-partition/);
  fs.writeFileSync(file, JSON.stringify(pin));
  assert.deepEqual(readLauncherPin(root), pin);
  const ok = {
    certificateSha256: pin.certificateSha256,
    apkSha256: pin.apkSha256,
    pin,
    platformCertificateSha256: "f".repeat(64),
  };
  assertLauncherSigner(ok);
  assert.throws(
    () =>
      assertLauncherSigner({
        ...ok,
        certificateSha256: "f".repeat(64),
        pin: { ...pin, certificateSha256: "f".repeat(64) },
      }),
    /platform certificate/,
  );
  assert.throws(
    () => assertLauncherSigner({ ...ok, certificateSha256: "c".repeat(64) }),
    /signer differs/,
  );
  assert.throws(
    () => assertLauncherSigner({ ...ok, apkSha256: "c".repeat(64) }),
    /bytes differ/,
  );
});
