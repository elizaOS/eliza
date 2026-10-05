import assert from "node:assert/strict";
import { test } from "node:test";
import {
  androidInstrumentationEvidenceFromAapt,
  androidPlayManifestEvidenceFromAapt,
} from "./android-tools.ts";

const manifest = `N: android=http://schemas.android.com/apk/res/android
  E: manifest
    E: uses-sdk
      A: android:targetSdkVersion(0x0101027A)=(type 0x10)0x24
    E: queries
      E: package
        A: android:name="viewer"
    E: application
      A: android:debuggable=(type 0x12)0x0
      A: android:allowBackup=(type 0x12)0xffffffff
      E: activity
        A: android:name="compiled" (Raw: ".Main")
      E: instrumentation
        A: android:name="nested.invalid.Runner"
    E: instrumentation
      A: android:name="org.example.Runner"
      A: android:targetPackage="org.example.app"
`;

test("shared tree preserves normalized policy attributes and query ancestry", () => {
  const evidence = androidPlayManifestEvidenceFromAapt(manifest);
  assert.equal(evidence.targetSdkVersion, "36");
  assert.equal(evidence.application.debuggable, "false");
  assert.equal(evidence.application.allowBackup, "true");
  assert.deepEqual(evidence.components, ["activity:.Main"]);
  assert.deepEqual(evidence.queryPackages, ["viewer"]);
  assert.deepEqual(
    androidPlayManifestEvidenceFromAapt(manifest.replaceAll("\n", "\r\n")),
    evidence,
  );
});

test("only direct manifest instrumentation declarations provide install identity", () => {
  assert.deepEqual(androidInstrumentationEvidenceFromAapt(manifest), [
    {
      name: "org.example.Runner",
      targetPackage: "org.example.app",
    },
  ]);
});
