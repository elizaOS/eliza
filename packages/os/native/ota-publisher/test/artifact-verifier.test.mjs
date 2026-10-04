import assert from "node:assert/strict";
import test from "node:test";
import { createArtifactVerifier } from "../artifact-verifier.mjs";

const forbidden = () => {
  throw Error("Unexpected build tool");
};
const { verifyManifest, verifyReleaseArtifacts } = createArtifactVerifier({
  validateRelease: forbidden,
  otaTrustSource: forbidden,
  androidEnv: forbidden,
  tool: forbidden,
  distributionMetadataKey: "org.example.app.distribution",
});
const descriptor = { packageId: "org.example.app", distribution: "launcher" };
const artifact = {
  versionCode: 2,
  versionName: "0.1.2",
  android: { sdk: { min: 35, max: 35 }, targetSdk: 36 },
};
const xml = `N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=2)
    A: package="org.example.app" (Raw: "org.example.app")
    A: android:versionCode(0x0101021b)=(type 0x10)0x2
    A: android:versionName(0x0101021c)="0.1.2" (Raw: "0.1.2")
    E: uses-sdk (line=7)
      A: android:minSdkVersion(0x0101020c)=(type 0x10)0x1d
      A: android:targetSdkVersion(0x01010270)=(type 0x10)0x24
    E: application (line=8)
      E: meta-data (line=9)
        A: android:name="org.example.app.distribution"
        A: android:value="launcher"
      E: activity (line=10)
        E: intent-filter (line=11)
          E: action (line=12)
            A: android:name="android.intent.action.MAIN"
          E: category (line=13)
            A: android:name="android.intent.category.LAUNCHER"
          E: category (line=14)
            A: android:name="android.intent.category.HOME"
`;
test("release artifact gate checks application-scoped binary manifest identity", () => {
  assert.doesNotThrow(() => verifyManifest(xml, descriptor, artifact));
  for (const changed of [
    xml.replace("0x2\n", "0x3\n"),
    xml.replaceAll('"0.1.2"', '"0.1.3"'),
    xml.replaceAll('org.example.app"', 'other.package"'),
    xml.replace('A: android:value="launcher"', 'A: android:value="standalone"'),
    xml.replace("E: application (line=8)", "E: queries (line=8)"),
    xml.replace(
      "E: application (line=8)",
      "E: application (line=8)\n      A: android:debuggable=(type 0x12)0xffffffff",
    ),
    xml.replace(
      "E: application (line=8)",
      "E: application (line=8)\n      A: android:testOnly=(type 0x12)0xffffffff",
    ),
    xml.replace(
      "E: uses-sdk (line=7)",
      "E: uses-sdk (line=7)\n      A: android:maxSdkVersion=(type 0x10)0x22",
    ),
    xml.replace(
      "E: uses-sdk (line=7)",
      "A: android:versionCodeMajor=(type 0x10)0x1\n    E: uses-sdk (line=7)",
    ),
    xml.replace("category.HOME", "category.OTHER"),
    xml.replace("0x24\n", "0x23\n"),
    xml.replace("0x1d\n", "0x0\n"),
  ])
    assert.throws(() => verifyManifest(changed, descriptor, artifact));
  assert.throws(() =>
    verifyManifest(
      xml,
      { ...descriptor, distribution: "standalone" },
      artifact,
    ),
  );
});

test("release snapshots reject nonregular and oversized descriptors before invoking build tools", async () => {
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-inputs-"));
  try {
    const large = path.join(dir, "large");
    fs.writeFileSync(large, Buffer.alloc(1024 * 1024 + 1));
    const fifo = path.join(dir, "fifo");
    execFileSync("mkfifo", [fifo]);
    const symlink = path.join(dir, "symlink");
    fs.symlinkSync(large, symlink);
    for (const descriptorFile of [dir, large, fifo, symlink])
      assert.throws(() =>
        verifyReleaseArtifacts({
          descriptorFile,
          candidate: "absent",
          recovery: "absent",
          expectedSigner: "a".repeat(64),
          hosts: ["github.com"],
        }),
      );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("artifact verifier refuses incomplete host configuration", () => {
  assert.throws(() => createArtifactVerifier());
  assert.throws(() =>
    createArtifactVerifier({
      validateRelease: forbidden,
      otaTrustSource: forbidden,
      androidEnv: forbidden,
      tool: forbidden,
    }),
  );
});
