/** Synthetic admission fixtures exercise real staging/copying; they never qualify an APK signature or runtime. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { parseSubArgs as parseBuildArgs } from "../distro-android/build-aosp.mjs";
import {
  assertBrowserAppsStaged,
  bindBrowserCertificate,
  readBrowserAppPins,
  stageBrowserApps,
} from "../distro-android/stage-browser-apps.mjs";
import { syncToAosp } from "../distro-android/sync-to-aosp.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const rootUrl = new URL("../../../browser-bridge-extension/", import.meta.url);
const reviewed = JSON.parse(
  fs.readFileSync(new URL("scripts/chromium/upstream.json", rootUrl), "utf8"),
);
const identity = JSON.parse(
  fs.readFileSync(new URL("identity.json", rootUrl), "utf8"),
);
function fixture(t) {
  const root = testOutputPath("owned-browser-staging");
  fs.mkdirSync(root, { recursive: true });
  const vendorDir = fs.mkdtempSync(path.join(root, "case-"));
  t.after(() => fs.rmSync(vendorDir, { recursive: true, force: true }));
  const pins = JSON.parse(
    fs.readFileSync(
      new URL(
        "../../android/vendor/eliza/manifests/browser-apps.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  pins.schemaVersion = 3;
  const pin = pins.chromium.variants.x86_64;
  pin.kind = "owned-component";
  pin.packageName = "ai.elizaos.chromium";
  delete pin.sourceUrl;
  pin.sha256 = hash("owned apk fixture");
  pins.bitwarden.sha256 = hash("vault fixture");
  const component = {
    schemaVersion: 1,
    chromiumRevision: reviewed.revision,
    extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
    launcherSignerSha256: "a".repeat(64),
    qualification: null,
  };
  pin.component = component;
  function write(relative, bytes) {
    const file = path.join(vendorDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  }
  function ref(name, bytes) {
    const relative = `manifests/browser-provenance/x86_64/${name}`;
    write(relative, bytes);
    return { path: relative, sha256: hash(bytes) };
  }
  const names = [
    "manifest.json",
    "background.mjs",
    "commands.mjs",
    "protocol.mjs",
    "runtime-config.mjs",
    "native-connection.mjs",
  ];
  const resources = {};
  const resourceHashes = {};
  for (const name of names) {
    let text = "// synthetic reviewed resource\n";
    if (name === "manifest.json")
      text = JSON.stringify({
        manifest_version: 3,
        key: identity.chromeDevManifestKey,
        background: { service_worker: "background.mjs", type: "module" },
      });
    if (name === "runtime-config.mjs")
      text = `export const nativeHost = ${JSON.stringify({ application: "ai.elizaos.app", androidCertificates: ["A".repeat(64)] })};\n`;
    resources[name] = ref(`resources/${name}`, text);
    resourceHashes[name] = {
      sha256: hash(text),
      bytes: Buffer.byteLength(text),
    };
  }
  const patch = ref("eliza-component.patch", "synthetic patch");
  const overlay = {
    chromiumRevision: reviewed.revision,
    extensionId: component.extensionId,
    platform: "android",
    unrestrictedAllowlistBypass: false,
    inputs: reviewed.sha256,
    outputs: { "chrome/fixture.cc": "b".repeat(64) },
    patchSha256: patch.sha256,
    resources: resourceHashes,
  };
  const binding = {
    sha256: pin.sha256,
    signerSha256: pin.signerSha256,
    packageName: pin.packageName,
    versionName: pin.versionName,
    versionCode: pin.versionCode,
    architecture: "x86_64",
  };
  const provenance = {
    schemaVersion: 1,
    repository: "https://chromium.googlesource.com/chromium/src",
    chromiumRevision: reviewed.revision,
    extensionId: component.extensionId,
    launcherSignerSha256: component.launcherSignerSha256,
    apk: binding,
    overlay: ref("overlay.json", JSON.stringify(overlay)),
    patch,
    resources,
    gnArgs: ref(
      "args.gn",
      'target_os = "android"\ntarget_cpu = "x64"\nis_desktop_android = true\nis_debug = true\nchrome_public_manifest_package = "ai.elizaos.chromium"\n',
    ),
  };
  function save() {
    component.provenance = ref("build.json", JSON.stringify(provenance));
    write("manifests/browser-apps.json", JSON.stringify(pins));
  }
  save();
  const chromiumApk = write("candidate-browser.apk", "owned apk fixture"),
    bitwardenApk = write("candidate-vault.apk", "vault fixture");
  write("apps/Chromium/x86_64/Chromium.apk", "owned apk fixture");
  write("apps/Bitwarden/Bitwarden.apk", "vault fixture");
  write("apps/Eliza/Eliza.apk", "launcher fixture");
  const tool = write(
    "apk-tool.mjs",
    `#!/usr/bin/env node\nimport fs from 'node:fs';import path from 'node:path';const pins=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(vendorDir, "manifests/browser-apps.json"))},'utf8'));const pin=process.argv.at(-1).endsWith('Chromium.apk')?pins.chromium.variants.x86_64:pins.bitwarden;let fault='';try{fault=fs.readFileSync(${JSON.stringify(path.join(vendorDir, "fault"))},'utf8')}catch{};if(process.argv[2]==='verify')console.log('Signer #1 certificate SHA-256 digest: '+(fault==='signer'?'f'.repeat(64):pin.signerSha256));else console.log("package: name='"+(fault==='package'?'wrong':pin.packageName)+"' versionCode='"+pin.versionCode+"' versionName='"+pin.versionName+"'\\nnative-code: '"+(fault==='abi'?'wrong':"x86_64' 'arm64-v8a")+"'");\n`,
  );
  fs.chmodSync(tool, 0o755);
  return {
    vendorDir,
    pins,
    pin,
    provenance,
    overlay,
    ref,
    save,
    write,
    options: {
      vendorDir,
      chromiumApk,
      bitwardenApk,
      arch: "x86_64",
      allowDevelopmentBrowser: true,
      apksigner: tool,
      aapt: tool,
    },
    brand: {
      brand: "eliza",
      appName: "Eliza",
      distroName: "elizaOS",
      architecture: "x86_64",
      productName: "eliza_cf_x86_64_phone",
      lunchTarget: "eliza_cf_x86_64_phone-trunk_staging-userdebug",
      buildAndroidSystemCmd: ["bun", "run", "build:android:system"],
    },
  };
}
test("owned component preserves exact APK admission and explicit development status", (t) => {
  const f = fixture(t);
  const result = stageBrowserApps(f.options);
  assert.equal(result.releaseQualified, false);
  assert.throws(
    () => assertBrowserAppsStaged(f.vendorDir, "x86_64"),
    /development snapshot/,
  );
  assertBrowserAppsStaged(f.vendorDir, "x86_64", {
    allowDevelopmentBrowser: true,
  });
});
test("owned and upstream browser package identities cannot be interchanged", (t) => {
  const f = fixture(t);
  f.pin.packageName = "org.chromium.chrome";
  f.save();
  assert.throws(
    () => readBrowserAppPins(f.vendorDir),
    /Invalid pinned chromium APK identity/,
  );
  f.pin.packageName = "ai.elizaos.chromium";
  f.pins.chromium.variants.arm64.packageName = "ai.elizaos.chromium";
  f.save();
  assert.throws(
    () => readBrowserAppPins(f.vendorDir),
    /Invalid pinned chromium APK identity/,
  );
});
test("owned GN package override must match the APK provenance", (t) => {
  const f = fixture(t);
  const base =
    'target_os = "android"\ntarget_cpu = "x64"\nis_desktop_android = true\n';
  for (const declaration of [
    "",
    'chrome_public_manifest_package = "org.chromium.chrome"\n',
    'chrome_public_manifest_package = "arbitrary.browser"\n',
  ]) {
    f.provenance.gnArgs = f.ref("args.gn", base + declaration);
    f.save();
    assert.throws(() => stageBrowserApps(f.options), /GN (argument|package)/);
  }
});
test("wrong signer, package, or ABI never replaces earlier staged APKs", (t) => {
  const f = fixture(t);
  for (const fault of ["signer", "package", "abi"]) {
    f.write("fault", fault);
    f.write("apps/Chromium/x86_64/Chromium.apk", "previous");
    assert.throws(() => stageBrowserApps(f.options), /mismatch/);
    assert.equal(
      fs.readFileSync(
        path.join(f.vendorDir, "apps/Chromium/x86_64/Chromium.apk"),
        "utf8",
      ),
      "previous",
    );
  }
});
test("malformed provenance, source revision, or launcher certificate is refused", (t) => {
  const f = fixture(t);
  f.provenance.apk.sha256 = "0".repeat(64);
  f.save();
  assert.throws(() => stageBrowserApps(f.options), /provenance binding/);
  f.provenance.apk.sha256 = f.pin.sha256;
  f.provenance.launcherSignerSha256 = "0".repeat(64);
  f.save();
  assert.throws(() => stageBrowserApps(f.options), /identity binding/);
});
test("source hashes and Desktop Android GN settings are checked", (t) => {
  const f = fixture(t);
  f.overlay.inputs = {};
  f.provenance.overlay = f.ref("overlay.json", JSON.stringify(f.overlay));
  f.save();
  assert.throws(() => stageBrowserApps(f.options), /source hashes/);
  f.overlay.inputs = reviewed.sha256;
  f.provenance.overlay = f.ref("overlay.json", JSON.stringify(f.overlay));
  f.provenance.gnArgs = f.ref(
    "args.gn",
    'target_os = "android"\ntarget_cpu = "arm64"\nis_desktop_android = true\n',
  );
  f.save();
  assert.throws(() => stageBrowserApps(f.options), /GN arguments mismatch/);
});
test("linked APKs and provenance cannot cross the vendor boundary", (t) => {
  const f = fixture(t);
  const file = path.join(f.vendorDir, f.pin.component.provenance.path);
  const text = fs.readFileSync(file);
  fs.unlinkSync(file);
  fs.symlinkSync(f.options.chromiumApk, file);
  assert.throws(() => stageBrowserApps(f.options), /symbolic link/);
  fs.unlinkSync(file);
  fs.writeFileSync(file, text);
  const apk = f.options.chromiumApk;
  fs.unlinkSync(apk);
  fs.symlinkSync(f.options.bitwardenApk, apk);
  assert.throws(() => stageBrowserApps(f.options), /non-symlink/);
});
test("linked destination directories cannot redirect APK staging", (t) => {
  const f = fixture(t);
  const chromium = path.join(f.vendorDir, "apps/Chromium");
  fs.rmSync(chromium, { recursive: true });
  fs.symlinkSync(path.join(f.vendorDir, "apps/Bitwarden"), chromium);
  assert.throws(() => stageBrowserApps(f.options), /real directories/);
  assert.equal(
    fs.readFileSync(
      path.join(f.vendorDir, "apps/Bitwarden/Bitwarden.apk"),
      "utf8",
    ),
    "vault fixture",
  );
});
test("owned kind cannot relabel Bitwarden or bless a public debug signer as release", (t) => {
  const f = fixture(t);
  f.pins.bitwarden.kind = "owned-component";
  f.save();
  assert.throws(() => readBrowserAppPins(f.vendorDir), /only valid.*Chromium/);
  delete f.pins.bitwarden.kind;
  f.pin.channel = "stable";
  f.save();
  assert.throws(() => readBrowserAppPins(f.vendorDir), /production signer/);
});
test("stable owned admission rejects public launcher keys and unsupported qualification claims", (t) => {
  const f = fixture(t);
  f.pin.channel = "stable";
  f.pin.signerSha256 = "b".repeat(64);
  f.pin.component.launcherSignerSha256 =
    "c8a2e9bccf597c2fb6dc66bee293fc13f2fc47ec77bc6b2b0d52c11f51192ab8";
  f.save();
  assert.throws(() => readBrowserAppPins(f.vendorDir), /production signer/);
  f.pin.component.launcherSignerSha256 = "a".repeat(64);
  for (const observations of [{ failed: true }, { foo: 1 }]) {
    f.pin.component.qualification = f.ref(
      "qualification.json",
      JSON.stringify({ observations }),
    );
    f.save();
    assert.throws(
      () => readBrowserAppPins(f.vendorDir),
      /qualification contract/,
    );
  }
  f.pin.channel = "development";
  f.save();
  assert.throws(() => readBrowserAppPins(f.vendorDir), /unvalidated claims/);
});
test("AOSP checks copied browser bytes before replacing the previous vendor tree", (t) => {
  const f = fixture(t);
  const aospRoot = fs.mkdtempSync(
    path.join(path.dirname(f.vendorDir), "aosp-"),
  );
  t.after(() => fs.rmSync(aospRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(aospRoot, "build"), { recursive: true });
  fs.writeFileSync(path.join(aospRoot, "build/envsetup.sh"), "fixture");
  const options = {
    sourceVendor: f.vendorDir,
    aospRoot,
    brand: f.brand,
    allowDevelopmentBrowser: true,
  };
  const target = syncToAosp(options);
  const browser = path.join(target, "apps/Chromium/x86_64/Chromium.apk");
  assert.equal(fs.readFileSync(browser, "utf8"), "owned apk fixture");
  const copy = fs.cpSync;
  const mocked = t.mock.method(
    fs,
    "cpSync",
    (source, destination, settings) => {
      copy(source, destination, settings);
      fs.writeFileSync(
        path.join(destination, "apps/Chromium/x86_64/Chromium.apk"),
        "mutated during copy",
      );
    },
  );
  assert.throws(() => syncToAosp(options), /unverified chromium/);
  mocked.mock.restore();
  assert.equal(fs.readFileSync(browser, "utf8"), "owned apk fixture");
});
test("browser identity is bound without accepting conflicting overrides", () => {
  const pin = {
    packageName: "org.chromium.chrome",
    signerSha256: "a".repeat(64),
  };
  assert.equal(
    bindBrowserCertificate({}, pin).ELIZA_CHROMIUM_CERT_SHA256,
    pin.signerSha256,
  );
  assert.equal(
    bindBrowserCertificate({}, pin).ELIZA_CHROMIUM_PACKAGE_NAME,
    pin.packageName,
  );
  const owned = {
    ...pin,
    kind: "owned-component",
    packageName: "ai.elizaos.chromium",
  };
  assert.equal(
    bindBrowserCertificate({}, owned).ELIZA_CHROMIUM_PACKAGE_NAME,
    owned.packageName,
  );
  assert.throws(
    () =>
      bindBrowserCertificate(
        { ELIZA_CHROMIUM_PACKAGE_NAME: pin.packageName },
        owned,
      ),
    /conflicts/,
  );
  assert.throws(
    () =>
      bindBrowserCertificate(
        { ELIZA_CHROMIUM_PACKAGE_NAME: "arbitrary.browser" },
        pin,
      ),
    /conflicts/,
  );
  assert.throws(
    () =>
      bindBrowserCertificate({}, { ...owned, packageName: pin.packageName }),
    /artifact kind/,
  );
  assert.throws(
    () =>
      bindBrowserCertificate(
        { ELIZA_CHROMIUM_CERT_SHA256: "b".repeat(64) },
        pin,
      ),
    /conflicts/,
  );
  assert.equal(
    parseBuildArgs(["--aosp-root", "/test", "--allow-development-browser"])
      .allowDevelopmentBrowser,
    true,
  );
});
test("AOSP release cannot inherit development browser admission", (t) => {
  const f = fixture(t);
  const aospRoot = fs.mkdtempSync(
    path.join(path.dirname(f.vendorDir), "aosp-"),
  );
  t.after(() => fs.rmSync(aospRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(aospRoot, "build"), { recursive: true });
  fs.writeFileSync(path.join(aospRoot, "build/envsetup.sh"), "fixture");
  assert.throws(
    () =>
      syncToAosp({
        sourceVendor: f.vendorDir,
        aospRoot,
        brand: { ...f.brand, lunchTarget: "target-trunk_staging-user" },
        allowDevelopmentBrowser: true,
      }),
    /requires an explicit userdebug/,
  );
});
test("preparation actual CLI rejects missing inputs instead of silently returning success", () => {
  const script = new URL(
    "../distro-android/prepare-chromium-browser.mjs",
    import.meta.url,
  );
  const run = spawnSync(
    process.execPath,
    [
      script.pathname,
      "--source",
      "/__missing_chromium_readonly__",
      "--revision",
      "0".repeat(40),
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /extension must be an absolute path/);
});

test("preparation CLI reaches the reviewed component generator revision guard", (t) => {
  const f = fixture(t);
  const script = new URL(
    "../distro-android/prepare-chromium-browser.mjs",
    import.meta.url,
  );
  const run = spawnSync(
    process.execPath,
    [
      script.pathname,
      "--source",
      f.vendorDir,
      "--extension",
      f.vendorDir,
      "--out",
      `${f.vendorDir}-overlay`,
      "--certificate",
      "a".repeat(64),
      "--revision",
      "0".repeat(40),
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /revision must match the reviewed component pin/);
  assert.equal(fs.existsSync(`${f.vendorDir}-overlay`), false);
});
