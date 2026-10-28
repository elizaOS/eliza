import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  apkArchiveFacts,
  apkDistributionPolicy,
  apkDistributionProblems,
  dexMarkers,
  extractApkWebPayload,
  parseApkSignerDigest,
  readApkEntries,
} from "./apk-distribution.mjs";

const policy = {
  developmentClasses: ["DevelopmentHook"],
  developmentManifestText: ["peerfixture"],
  developmentEntries: ["^res/xml/development_network_security_config\\.xml$"],
  exportedComponents: {
    "example.host.MainActivity": null,
    "example.host.Listener":
      "android.permission.BIND_NOTIFICATION_LISTENER_SERVICE",
  },
  forbiddenPermissions: ["android.permission.WRITE_EXTERNAL_STORAGE"],
  forbiddenEntries: /^assets\/removed\//,
  forbiddenEntriesLabel: "Removed runtime entries are packaged",
  forbiddenDexPrefixes: ["Lexample/removed/"],
  forbiddenDexLabel: "Removed runtime classes are packaged",
  requiredEntries: ["assets/public/licenses/third-party-notices.json"],
};
const badging =
  "package: name='example.host' versionCode='7' versionName='1.0.7'";

function manifest({
  backup = "0x0",
  cleartext = "0x0",
  nsc = true,
  components = "",
  extra = "",
} = {}) {
  return `N: android=http://schemas.android.com/apk/res/android
  E: manifest (line=2)
    A: package="example.host" (Raw: "example.host")
${extra}    E: application (line=10)
      A: android:allowBackup(0x01010280)=(type 0x12)${backup}
      A: android:usesCleartextTraffic(0x010104ec)=(type 0x12)${cleartext}
${nsc ? "      A: android:networkSecurityConfig(0x01010527)=@0x7f150002\n" : ""}      E: activity (line=12)
        A: android:name(0x01010003)="example.host.MainActivity" (Raw: "example.host.MainActivity")
        A: android:exported(0x01010010)=(type 0x12)0xffffffff
        E: intent-filter (line=13)
          E: action (line=14)
            A: android:name(0x01010003)="android.intent.action.MAIN" (Raw: "android.intent.action.MAIN")
          E: category (line=15)
            A: android:name(0x01010003)="android.intent.category.LAUNCHER" (Raw: "android.intent.category.LAUNCHER")
${components}`;
}
const clean = {
  xml: manifest(),
  badging,
  names: ["assets/public/index.html", ...policy.requiredEntries],
};

test("a clean release passes the host policy", () => {
  const { facts, problems } = apkDistributionProblems(clean, policy, {
    mode: "release",
  });
  assert.deepEqual(problems, []);
  assert.equal(facts.versionCode, 7);
  assert.deepEqual(apkArchiveFacts(clean), {
    packageName: "example.host",
    home: false,
    launcher: true,
    debuggable: false,
    webPayload: true,
  });
});

test("manifest, entry and dex violations are each named", () => {
  const apk = {
    xml: manifest({
      backup: "0xffffffff",
      cleartext: "0xffffffff",
      nsc: false,
      extra:
        '    E: uses-permission (line=3)\n      A: android:name(0x01010003)="android.permission.WRITE_EXTERNAL_STORAGE" (Raw: "android.permission.WRITE_EXTERNAL_STORAGE")\n    E: uses-permission (line=4)\n      A: android:name(0x01010003)="example.peerfixture.ACCESS" (Raw: "example.peerfixture.ACCESS")\n',
      components:
        '      E: service (line=20)\n        A: android:name(0x01010003)="example.host.Listener" (Raw: "example.host.Listener")\n        A: android:exported(0x01010010)=(type 0x12)0xffffffff\n      E: receiver (line=21)\n        A: android:name(0x01010003)="example.host.Stray" (Raw: "example.host.Stray")\n        A: android:exported(0x01010010)=(type 0x12)0xffffffff\n',
    }),
    badging: "package: name='example.host' versionCode='0' versionName='0'",
    names: [
      "assets/public/app.js.map",
      "assets/removed/model.bin",
      "res/xml/development_network_security_config.xml",
    ],
    dexClasses: ["DevelopmentHook"],
    forbiddenDex: ["Lexample/removed/"],
  };
  const { problems } = apkDistributionProblems(apk, policy, {
    mode: "release",
  });
  for (const expected of [
    /Development class DevelopmentHook is packaged/,
    /peerfixture permission or package query is packaged/,
    /Development entry res\/xml\/development_network_security_config\.xml/,
    /usesCleartextTraffic must be false/,
    /Release manifest has no networkSecurityConfig/,
    /allowBackup must be false/,
    /Exported example\.host\.Listener must require android\.permission\.BIND_NOTIFICATION_LISTENER_SERVICE/,
    /Unexpected exported receiver example\.host\.Stray/,
    /Test-only manifest entry example\.peerfixture\.ACCESS/,
    /WRITE_EXTERNAL_STORAGE is requested/,
    /Source maps are packaged: assets\/public\/app\.js\.map/,
    /Removed runtime entries are packaged: assets\/removed\/model\.bin/,
    /Removed runtime classes are packaged: Lexample\/removed\//,
    /third-party-notices\.json is missing/,
    /versionCode must be a positive integer/,
    /versionName must be set/,
  ])
    assert.ok(
      problems.some((problem) => expected.test(problem)),
      `${expected} in ${problems.join("\n")}`,
    );
});

test("development hooks are tolerated only in a test-mocks debug build", () => {
  const apk = {
    ...clean,
    xml: manifest({
      cleartext: "0xffffffff",
      components:
        '      E: service (line=20)\n        A: android:name(0x01010003)="example.host.DevelopmentHook" (Raw: "example.host.DevelopmentHook")\n        A: android:exported(0x01010010)=(type 0x12)0xffffffff\n',
    }),
    dexClasses: ["DevelopmentHook"],
  };
  assert.deepEqual(
    apkDistributionProblems(apk, policy, { mode: "debug", testMocks: true })
      .problems,
    [],
  );
  for (const options of [
    { mode: "debug", testMocks: false },
    { mode: "release", testMocks: true },
  ])
    assert.ok(
      apkDistributionProblems(apk, policy, options).problems.length >= 3,
      JSON.stringify(options),
    );
});

test("malformed policies are refused", () => {
  assert.throws(
    () => apkDistributionPolicy({ developmentClasses: "Hook" }),
    /developmentClasses/,
  );
  assert.throws(
    () => apkDistributionPolicy({ exportedComponents: { a: 3 } }),
    /exportedComponents\.a/,
  );
  assert.throws(
    () => apkDistributionPolicy({ exportedComponents: [] }),
    /exportedComponents/,
  );
  assert.throws(
    () => apkDistributionPolicy({ developmentEntries: "^res/" }),
    /developmentEntries/,
  );
  assert.throws(
    () => apkDistributionPolicy({ forbiddenEntries: 3 }),
    /forbiddenEntries/,
  );
});

test("a global pattern still names every matching entry", () => {
  const { problems } = apkDistributionProblems(
    {
      ...clean,
      names: [
        ...clean.names,
        "assets/removed/a.bin",
        "assets/removed/b.bin",
        "assets/removed/c.bin",
      ],
    },
    { ...policy, forbiddenEntries: /^assets\/removed\//g },
    { mode: "release" },
  );
  assert.deepEqual(problems, [
    "Removed runtime entries are packaged: assets/removed/a.bin, assets/removed/b.bin, assets/removed/c.bin",
  ]);
});

test("dex markers report development names and forbidden prefixes", () => {
  assert.deepEqual(
    dexMarkers(
      [
        Buffer.from("Lexample/host/DevelopmentHook;"),
        Buffer.from("Lexample/removed/Engine;"),
      ],
      policy,
    ),
    { development: ["DevelopmentHook"], forbidden: ["Lexample/removed/"] },
  );
  assert.deepEqual(dexMarkers([Buffer.from("Lexample/host/Main;")], policy), {
    development: [],
    forbidden: [],
  });
});

const a = "A".repeat(64);
const b = "b".repeat(64);
const legacy = `Signer #1 certificate SHA-256 digest: ${a}`;
const rotated = `Signer (minSdkVersion=24, maxSdkVersion=32) certificate SHA-256 digest: ${a}\nSigner (minSdkVersion=33, maxSdkVersion=2147483647) certificate SHA-256 digest: ${b}`;

test("signer digests are normalized and scoped to one API level", () => {
  assert.equal(parseApkSignerDigest(legacy), a.toLowerCase());
  assert.equal(
    parseApkSignerDigest(rotated, { apiLevel: 32 }),
    a.toLowerCase(),
  );
  assert.equal(parseApkSignerDigest(rotated, { apiLevel: 34 }), b);
  for (const apiLevel of [undefined, 0, 1.5, "34"])
    assert.throws(() => parseApkSignerDigest(rotated, { apiLevel }));
  assert.throws(() => parseApkSignerDigest(rotated, { apiLevel: 23 }));
  assert.throws(() =>
    parseApkSignerDigest(`${rotated}\n${rotated}`, { apiLevel: 34 }),
  );
  assert.throws(() =>
    parseApkSignerDigest(`${legacy}\n${rotated}`, { apiLevel: 34 }),
  );
  assert.throws(() =>
    parseApkSignerDigest(
      `${legacy}\nSigner #2 certificate SHA-256 digest: ${b}`,
    ),
  );
  assert.throws(() => parseApkSignerDigest("no signer"));
});

test("entries and the web payload are read from the archive", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apk-dist-test-"));
  try {
    const archive = path.join(directory, "app.apk");
    execFileSync("python3", [
      "-c",
      "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z:\n z.writestr('assets/public/index.html','<p>')\n z.writestr('classes.dex','dex')",
      archive,
    ]);
    assert.deepEqual(readApkEntries(archive).sort(), [
      "assets/public/index.html",
      "classes.dex",
    ]);
    const payload = extractApkWebPayload(archive);
    try {
      assert.equal(
        fs.readFileSync(path.join(payload.public, "index.html"), "utf8"),
        "<p>",
      );
    } finally {
      fs.rmSync(payload.root, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
