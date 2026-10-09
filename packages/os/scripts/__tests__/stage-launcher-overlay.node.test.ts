import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  createDevelopmentLauncherDescriptor,
  renderOverlay,
  stageLauncher,
  validateDescriptor,
  validateInspection,
} from "../android/stage-launcher-overlay.ts";

test("development descriptor requires opt-in before reading files or invoking tools", () => {
  assert.throws(
    () =>
      createDevelopmentLauncherDescriptor({
        identity: descriptor,
        apk: "absent",
        apksigner: "must-not-run",
        development: false,
      }),
    /explicit development/,
  );
});

test("development descriptor verifies a private copy and refuses malformed or multiple signers", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "launcher-descriptor-test-"),
  );
  try {
    const apk = path.join(root, "original.apk"),
      tool = path.join(root, "signer"),
      record = path.join(root, "inspected");
    fs.writeFileSync(apk, "fixture-apk");
    fs.writeFileSync(
      tool,
      `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]!=='verify'||process.argv[3]!=='--print-certs')process.exit(2);fs.writeFileSync(process.env.RECORD,process.argv[4]);if(fs.readFileSync(process.argv[4],'utf8')!=='fixture-apk')process.exit(3);console.log(process.env.SIGNATURES);`,
      { mode: 0o700 },
    );
    const options = {
      identity: descriptor,
      apk,
      apksigner: tool,
      development: true,
      env: { ...process.env, RECORD: record, SIGNATURES: signer },
    };
    const result = createDevelopmentLauncherDescriptor(options);
    assert.equal(result.certificateSha256, descriptor.certificateSha256);
    assert.equal(
      result.apkSha256,
      createHash("sha256").update("fixture-apk").digest("hex"),
    );
    const inspected = fs.readFileSync(record, "utf8");
    assert.notEqual(inspected, apk);
    assert.equal(fs.existsSync(inspected), false);
    for (const signatures of [
      "",
      `${signer}\n${signer}`,
      `certificate SHA-256 digest: ${"b".repeat(64)}g`,
    ])
      assert.throws(
        () =>
          createDevelopmentLauncherDescriptor({
            ...options,
            env: { ...options.env, SIGNATURES: signatures },
          }),
        /valid launcher signer/,
      );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const descriptor = {
  schemaVersion: 1 as const,
  brand: "alpha_phone",
  moduleName: "AlphaPhone",
  packageName: "ai.elizaresearch.alphaphone",
  apkSha256: "a".repeat(64),
  certificateSha256: "b".repeat(64),
};
const badging = `package: name='${descriptor.packageName}'`;
const xml = `  E: activity\n    A: android:exported(0x01010010)=(type 0x12)0xffffffff\n    E: intent-filter\n      E: action\n        A: android:name="android.intent.action.MAIN"\n      E: category\n        A: android:name="android.intent.category.HOME"\n      E: category\n        A: android:name="android.intent.category.DEFAULT"`;
const signer = `Signer #1 certificate SHA-256 digest: ${descriptor.certificateSha256}`;
test("descriptor rejects code and path injection", () => {
  for (const field of [
    "brand",
    "moduleName",
    "packageName",
    "apkSha256",
    "certificateSha256",
  ])
    assert.throws(() =>
      validateDescriptor({ ...descriptor, [field]: '../evil"' }),
    );
  assert.throws(() => validateDescriptor(null));
  assert.throws(() => validateDescriptor({ ...descriptor, schemaVersion: 2 }));
  assert.deepEqual(validateDescriptor(descriptor), descriptor);
});
test("valid launcher remains additive and nonprivileged", () => {
  validateInspection(descriptor, badging, xml, signer, false);
  const generated = renderOverlay(descriptor);
  assert.match(generated.blueprint, /presigned: true/);
  assert.doesNotMatch(generated.blueprint, /privileged: true|overrides:/);
  assert.match(generated.product, /PRODUCT_PACKAGES \+= AlphaPhone/);
});
test("rejects wrong package, signer, multiple signers, missing HOME, and separated filters", () => {
  assert.throws(() =>
    validateInspection(descriptor, "package: name='wrong'", xml, signer, false),
  );
  assert.throws(() =>
    validateInspection(
      descriptor,
      badging,
      xml,
      signer.replaceAll("b", "c"),
      false,
    ),
  );
  assert.throws(() =>
    validateInspection(descriptor, badging, xml, `${signer}\n${signer}`, false),
  );
  assert.throws(() =>
    validateInspection(
      descriptor,
      badging,
      xml.replace("category.HOME", "category.LAUNCHER"),
      signer,
      false,
    ),
  );
  assert.throws(() =>
    validateInspection(
      descriptor,
      badging,
      xml.replace(
        "      E: category",
        "    E: intent-filter\n      E: category",
      ),
      signer,
      false,
    ),
  );
});
test("debug APK requires an explicit development lane", () => {
  const debugXml = `A: android:debuggable(0x0101000f)=(type 0x12)0xffffffff\n${xml}`;
  assert.throws(() =>
    validateInspection(descriptor, badging, debugXml, signer, false),
  );
  validateInspection(descriptor, badging, debugXml, signer, true);
});
test("digest mismatch stages nothing and never invokes SDK tools", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-test-"));
  try {
    const file = path.join(dir, "apk");
    fs.writeFileSync(file, "wrong");
    const descriptorPath = path.join(dir, "descriptor.json");
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor));
    assert.throws(
      () =>
        stageLauncher({
          descriptor: descriptorPath,
          apk: file,
          output: path.join(dir, "out"),
          aapt: "must-not-run",
          apksigner: "must-not-run",
          development: true,
        }),
      /hash mismatch/,
    );
    assert.equal(fs.existsSync(path.join(dir, "out")), false);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["apk", "descriptor.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects private, disabled and non-activity HOME filters", () => {
  for (const invalid of [
    xml.replace("0xffffffff", "0x0"),
    xml.replace("E: activity", "E: receiver"),
    xml.replace(
      "    E: intent-filter",
      "    A: android:enabled(0x0101000e)=(type 0x12)0x0\n    E: intent-filter",
    ),
  ])
    assert.throws(() =>
      validateInspection(descriptor, badging, invalid, signer, true),
    );
});

test("intent names must belong to the correct action and category elements", () => {
  for (const invalid of [
    xml.replace("E: action", "E: category"),
    xml.replaceAll("E: category", "E: action"),
    xml.replace(
      'android:name="android.intent.category.HOME',
      'android:label="android.intent.category.HOME',
    ),
  ])
    assert.throws(() =>
      validateInspection(descriptor, badging, invalid, signer, false),
    );
});

test("reviewed default permissions are declared by the APK and granted revocably", () => {
  const granted = {
    ...descriptor,
    defaultPermissions: [
      "android.permission.RECORD_AUDIO",
      "android.permission.POST_NOTIFICATIONS",
    ],
  };
  assert.deepEqual(validateDescriptor(granted), granted);
  for (const defaultPermissions of [
    [],
    ["android.permission.RECORD_AUDIO", "android.permission.RECORD_AUDIO"],
    ['android.permission.X"/><permission name="android.permission.Y'],
    ["com.example.permission.PRIVATE"],
    Array.from({ length: 33 }, (_, i) => `android.permission.P${i}`),
  ])
    assert.throws(
      () => validateDescriptor({ ...descriptor, defaultPermissions }),
      /Invalid default permissions/,
    );
  const declared = `${badging}\nuses-permission: name='android.permission.RECORD_AUDIO'\nuses-permission: name='android.permission.POST_NOTIFICATIONS'`;
  validateInspection(granted, declared, xml, signer, false);
  assert.throws(
    () => validateInspection(granted, badging, xml, signer, false),
    /does not declare android.permission.RECORD_AUDIO/,
  );
  const generated = renderOverlay(granted);
  assert.match(generated.blueprint, /prebuilt_etc \{/);
  assert.match(generated.blueprint, /sub_dir: "default-permissions"/);
  assert.match(
    generated.product,
    /PRODUCT_PACKAGES \+= AlphaPhone AlphaPhoneDefaultPermissions/,
  );
  assert.match(
    generated.permissions ?? "",
    /<exception package="ai.elizaresearch.alphaphone">/,
  );
  assert.equal(
    (generated.permissions ?? "").match(/fixed="false"/g)?.length,
    2,
  );
  assert.equal(renderOverlay(descriptor).permissions, null);
  assert.doesNotMatch(renderOverlay(descriptor).blueprint, /prebuilt_etc/);
});
