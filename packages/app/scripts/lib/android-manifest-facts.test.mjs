import assert from "node:assert/strict";
import { test } from "node:test";
import { manifestFacts, parseXmlTree } from "./android-manifest-facts.mjs";

const xml = `N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=2)
    A: package="org.example.shell" (Raw: "org.example.shell")
    A: android:versionCode(0x0101021b)=(type 0x10)0x2a
    A: android:versionName="1.2"
    E: uses-permission
      A: android:name="android.permission.INTERNET"
    E: uses-permission-sdk-23
      A: android:name="android.permission.CAMERA"
    E: queries
      E: package
        A: android:name="org.example.viewer"
    E: application
      A: android:allowBackup(0x01010280)=(type 0x12)0x0
      A: android:usesCleartextTraffic=(type 0x12)0x0
      A: android:networkSecurityConfig=@0x7f120001
      A: android:debuggable=(type 0x12)0xffffffff
      E: activity
        A: android:name=".MainActivity"
        A: android:exported=(type 0x12)0xffffffff
        E: intent-filter
          E: action
            A: android:name="android.intent.action.MAIN"
      E: service
        A: android:name="SyncService"
        A: android:exported=(type 0x12)0x0
      E: receiver
        A: android:name="org.example.shared.Receiver"
        A: android:exported=(type 0x12)0xffffffff
        A: android:permission="android.permission.DUMP"
      E: activity-alias
        A: android:name=".Alias"
        A: android:exported=(type 0x12)0xffffffff
      E: provider
        A: android:name=".Files"
`;
test("tree retains hierarchy and attaches attributes to the correct siblings", () => {
  const root = parseXmlTree(xml),
    manifest = root.children[0],
    app = manifest.children.at(-1);
  assert.equal(manifest.name, "manifest");
  assert.equal(manifest.attrs.package, "org.example.shell");
  assert.deepEqual(
    app.children.map((n) => n.name),
    ["activity", "service", "receiver", "activity-alias", "provider"],
  );
  assert.equal(
    app.children[0].children[0].children[0].attrs.name,
    "android.intent.action.MAIN",
  );
  assert.equal(app.children[1].attrs.name, "SyncService");
  assert.equal(app.attrs.allowBackup, "0x0");
});
test("facts preserve permission/query declarations, qualify names and report explicit exports", () => {
  const f = manifestFacts(
    xml,
    "package: name='org.example.shell' versionCode='42' versionName='1.2'",
  );
  assert.equal(f.packageName, "org.example.shell");
  assert.equal(f.versionCode, 42);
  assert.equal(f.versionName, "1.2");
  assert.deepEqual(f.permissions, [
    "android.permission.INTERNET",
    "android.permission.CAMERA",
  ]);
  assert.deepEqual(f.queriedPackages, ["org.example.viewer"]);
  assert.deepEqual(
    f.components.map((c) => c.name),
    [
      "org.example.shell.MainActivity",
      "org.example.shell.SyncService",
      "org.example.shared.Receiver",
      "org.example.shell.Alias",
      "org.example.shell.Files",
    ],
  );
  assert.deepEqual(
    f.exported.map((c) => c.tag),
    ["activity", "receiver", "activity-alias"],
  );
  assert.equal(f.exported[1].permission, "android.permission.DUMP");
  assert.deepEqual(f.application, {
    allowBackup: "0x0",
    usesCleartextTraffic: "0x0",
    networkSecurityConfig: "@0x7f120001",
    debuggable: "0xffffffff",
  });
});
test("absent declarations stay absent and do not produce host policy conclusions", () => {
  const f = manifestFacts("");
  assert.equal(f.packageName, undefined);
  assert.deepEqual(f.components, []);
  assert.equal(f.versionCode, null);
  assert.equal(f.versionName, null);
  assert.ok(Object.values(f.application).every((v) => v === null));
});
test("badging supplies package and decimal versions when no xml declaration exists", () => {
  const f = manifestFacts(
    "",
    "package: name='org.example.other' versionCode='7' versionName='two'",
  );
  assert.equal(f.packageName, "org.example.other");
  assert.equal(f.versionCode, 7);
  assert.equal(f.versionName, "two");
});
for (const value of ["0", "-1", "01", "1.5", "nope", "0x2a"])
  test(`non-positive or non-decimal version ${value} remains unqualified`, () => {
    assert.equal(
      manifestFacts(xml, `package: versionCode='${value}'`).versionCode,
      null,
    );
  });
test("xml attributes retain references and escaped string content", () => {
  const root = parseXmlTree(
    'E: sample\n  A: ref=@0x7f001\n  A: text="a\\"b" (Raw: "a\\"b")',
  );
  assert.equal(root.children[0].attrs.ref, "@0x7f001");
  assert.equal(root.children[0].attrs.text, 'a\\"b');
});
