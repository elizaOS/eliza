import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  renderOverlay,
  stageLauncher,
  validateDescriptor,
  validateInspection,
} from "../distro-android/stage-launcher-overlay.ts";

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
