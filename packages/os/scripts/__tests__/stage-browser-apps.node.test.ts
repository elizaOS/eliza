/** Exercises artifact admission and preservation using real temporary vendor trees; APK signature qualification runs against the downloaded upstream artifacts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import {
  assertBrowserAppsStaged,
  readBrowserAppPins,
  sha256File,
  stageBrowserApps,
  stageBrowserOverlay,
} from "../android/stage-browser-apps.ts";

function fixture(t) {
  const root = testOutputPath("browser-app-staging");
  fs.mkdirSync(root, { recursive: true });
  const vendorDir = fs.mkdtempSync(path.join(root, "case-"));
  t.after(() => fs.rmSync(vendorDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(vendorDir, "manifests"));
  fs.copyFileSync(
    new URL(
      "../../android/vendor/eliza/manifests/browser-apps.json",
      import.meta.url,
    ),
    path.join(vendorDir, "manifests/browser-apps.json"),
  );
  const manifest = path.join(vendorDir, "manifests/browser-apps.json");
  const legacy = JSON.parse(fs.readFileSync(manifest, "utf8"));
  legacy.schemaVersion = 1;
  legacy.chromium = legacy.chromium.variants.x86_64;
  fs.writeFileSync(manifest, JSON.stringify(legacy));
  fs.mkdirSync(path.join(vendorDir, "apps/Chromium"), { recursive: true });
  fs.writeFileSync(
    path.join(vendorDir, "apps/Chromium/Chromium.apk"),
    "previous staged browser",
  );
  const candidate = path.join(vendorDir, "candidate.apk");
  fs.writeFileSync(candidate, "untrusted replacement");
  return {
    vendorDir,
    chromiumApk: candidate,
    bitwardenApk: candidate,
    arch: "x86_64",
  };
}

test("development Chromium needs an explicit development-image choice", (t) => {
  const options = fixture(t);
  assert.throws(() => stageBrowserApps(options), /development snapshot/);
  assert.equal(
    fs.readFileSync(
      path.join(options.vendorDir, "apps/Chromium/Chromium.apk"),
      "utf8",
    ),
    "previous staged browser",
  );
});

test("architecture variants admit independent bytes and never fall back to another ABI", (t) => {
  const options = fixture(t);
  const manifest = path.join(options.vendorDir, "manifests/browser-apps.json");
  const pins = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const x64 = pins.chromium;
  const arm64 = { ...x64, architectures: ["arm64"] };
  pins.schemaVersion = 2;
  pins.chromium = { variants: { x86_64: x64, arm64 } };
  for (const [arch, pin] of Object.entries(pins.chromium.variants)) {
    const dir = path.join(options.vendorDir, "apps/Chromium", arch);
    fs.mkdirSync(dir);
    const file = path.join(dir, "Chromium.apk");
    fs.writeFileSync(file, `${arch} independent fixture`);
    pin.sha256 = sha256File(file);
  }
  const vault = path.join(options.vendorDir, "apps/Bitwarden/Bitwarden.apk");
  fs.mkdirSync(path.dirname(vault));
  fs.writeFileSync(vault, "universal vault fixture");
  pins.bitwarden.sha256 = sha256File(vault);
  fs.writeFileSync(manifest, JSON.stringify(pins));
  assertBrowserAppsStaged(options.vendorDir, "arm64", {
    allowDevelopmentBrowser: true,
  });
  assertBrowserAppsStaged(options.vendorDir, "x86_64", {
    allowDevelopmentBrowser: true,
  });
  fs.copyFileSync(
    path.join(options.vendorDir, "apps/Chromium/x86_64/Chromium.apk"),
    path.join(options.vendorDir, "apps/Chromium/arm64/Chromium.apk"),
  );
  assert.throws(
    () =>
      assertBrowserAppsStaged(options.vendorDir, "arm64", {
        allowDevelopmentBrowser: true,
      }),
    /unverified chromium/,
  );
  assertBrowserAppsStaged(options.vendorDir, "x86_64", {
    allowDevelopmentBrowser: true,
  });
  assert.throws(
    () =>
      assertBrowserAppsStaged(options.vendorDir, undefined, {
        allowDevelopmentBrowser: true,
      }),
    /unspecified architecture/,
  );
  pins.chromium.variants.arm64.architectures = ["x86_64"];
  fs.writeFileSync(manifest, JSON.stringify(pins));
  assert.throws(
    () => readBrowserAppPins(options.vendorDir),
    /variant architecture/,
  );
});

test("mismatched content never replaces a staged browser", (t) => {
  const options = fixture(t);
  assert.throws(
    () => stageBrowserApps({ ...options, allowDevelopmentBrowser: true }),
    /checksum mismatch/,
  );
  assert.equal(
    fs.readFileSync(
      path.join(options.vendorDir, "apps/Chromium/Chromium.apk"),
      "utf8",
    ),
    "previous staged browser",
  );
  assert.equal(
    fs
      .readdirSync(options.vendorDir)
      .some((name) => name.startsWith(".browser-apps-")),
    false,
  );
});

test("an unqualified architecture cannot inherit the x86 browser", (t) => {
  const options = fixture(t);
  assert.throws(
    () =>
      stageBrowserApps({
        ...options,
        arch: "arm64",
        allowDevelopmentBrowser: true,
      }),
    /No verified chromium artifact/,
  );
});

test("AOSP sync admission refuses missing or changed staged artifacts", (t) => {
  const options = fixture(t);
  assert.throws(
    () =>
      assertBrowserAppsStaged(options.vendorDir, undefined, {
        allowDevelopmentBrowser: true,
      }),
    /Missing or unverified chromium APK/,
  );
});

test("AOSP sync refuses an artifact pinned for a different product architecture", (t) => {
  const options = fixture(t);
  assert.throws(
    () =>
      assertBrowserAppsStaged(options.vendorDir, "arm64", {
        allowDevelopmentBrowser: true,
      }),
    /No verified chromium artifact for arm64/,
  );
});

test("an unrelated download host cannot become an upstream pin", (t) => {
  const options = fixture(t);
  const filename = path.join(options.vendorDir, "manifests/browser-apps.json");
  const pins = JSON.parse(fs.readFileSync(filename, "utf8"));
  pins.bitwarden.sourceUrl = "https://example.com/vault.apk";
  fs.writeFileSync(filename, JSON.stringify(pins));
  assert.throws(
    () => readBrowserAppPins(options.vendorDir),
    /Unrecognized upstream source/,
  );
});

function overlayFixture(t) {
  const root = testOutputPath("browser-overlay-staging");
  fs.mkdirSync(root, { recursive: true });
  const work = fs.mkdtempSync(path.join(root, "case-"));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const signer = "a".repeat(64);
  const apps = {
    "OwnedChromium.apk": ["ai.elizaos.chromium", "156.0.8073.5", signer],
    "WebViewProvider.apk": [
      "com.android.webview",
      "141.0.7390.1",
      "b".repeat(64),
    ],
  };
  // One fake tool answers both apksigner and aapt, keyed by the staged copy's name.
  const tool = path.join(work, "apk-tool.cjs");
  fs.writeFileSync(
    tool,
    `#!${process.execPath}\nconst apps=${JSON.stringify(apps)};const a=process.argv.slice(2);const [name,version,signer]=apps[require('node:path').basename(a.at(-1))];if(a[0]==='verify')console.log('Signer #1 certificate SHA-256 digest: '+(process.env.FAULT_SIGNER??signer));else console.log("package: name='"+name+"' versionCode='1' versionName='"+version+"'");\n`,
    { mode: 0o700 },
  );
  const browserApk = path.join(work, "ChromePublic.apk");
  const webviewApk = path.join(work, "SystemWebView.apk");
  fs.writeFileSync(browserApk, "owned browser bytes");
  fs.writeFileSync(webviewApk, "webview provider bytes");
  const output = path.join(work, "vendor");
  fs.mkdirSync(output);
  const descriptor = {
    vendor: "vendor/acme",
    modulePrefix: "Acme",
    browser: {
      packageName: "ai.elizaos.chromium",
      sha256: sha256File(browserApk),
      signerSha256: signer,
    },
    webview: {
      packageName: "com.android.webview",
      sha256: sha256File(webviewApk),
      signerSha256: "b".repeat(64),
    },
  };
  return {
    descriptor,
    browserApk,
    webviewApk,
    output,
    apksigner: tool,
    aapt: tool,
  };
}

test("a caller descriptor stages its browser and the pinned WebView provider without Bitwarden", (t) => {
  const options = overlayFixture(t);
  const staged = stageBrowserOverlay(options);
  const directory = path.join(options.output, "browser");
  assert.deepEqual(staged.modules, {
    browser: "AcmeOwnedChromium",
    webview: "AcmeWebViewProvider",
  });
  const read = (name) => fs.readFileSync(path.join(directory, name), "utf8");
  const blueprint = read("Android.bp");
  assert.equal(blueprint.match(/android_app_import \{/g).length, 2);
  assert.equal(blueprint.match(/product_specific: true/g).length, 2);
  assert.match(
    blueprint,
    /name: "AcmeWebViewProvider",\n {4}apk: "WebViewProvider.apk"[\s\S]*overrides: \["webview"\][\s\S]*required: \["libwebviewchromium_loader", "libwebviewchromium_plat_support"\]/,
  );
  assert.match(blueprint, /ai\.elizaos\.chromium 156\.0\.8073\.5/);
  assert.equal(
    read("browser.mk"),
    "# Generated by stage-browser-apps.ts. Include it from the product makefile.\nPRODUCT_PACKAGES += AcmeOwnedChromium AcmeWebViewProvider\nPRODUCT_PACKAGE_OVERLAYS += vendor/acme/browser/overlay\n",
  );
  const config = read(
    "overlay/frameworks/base/core/res/res/xml/config_webview_packages.xml",
  );
  assert.equal(config.match(/<webviewprovider /g).length, 1);
  assert.match(
    config,
    /packageName="com\.android\.webview" availableByDefault="true"/,
  );
  assert.equal(read("OwnedChromium.apk"), "owned browser bytes");
  assert.equal(read("WebViewProvider.apk"), "webview provider bytes");
  assert.throws(() => stageBrowserOverlay(options), /already exists/);
});

test("a descriptor APK with another signer or hash leaves no browser overlay", (t) => {
  const options = overlayFixture(t);
  process.env.FAULT_SIGNER = "c".repeat(64);
  t.after(() => delete process.env.FAULT_SIGNER);
  assert.throws(() => stageBrowserOverlay(options), /signer mismatch/);
  delete process.env.FAULT_SIGNER;
  fs.writeFileSync(options.webviewApk, "replaced provider bytes");
  assert.throws(() => stageBrowserOverlay(options), /checksum mismatch/);
  assert.deepEqual(fs.readdirSync(options.output), []);
  assert.throws(
    () => stageBrowserOverlay({ ...options, webviewApk: undefined }),
    /exactly when the descriptor pins one/,
  );
  // A system-partition browser without a WebView provider stages no framework overlay.
  const { webview: _unused, ...browserOnly } = options.descriptor;
  stageBrowserOverlay({
    ...options,
    webviewApk: undefined,
    descriptor: { ...browserOnly, partition: "system" },
  });
  const directory = path.join(options.output, "browser");
  assert.deepEqual(fs.readdirSync(directory).sort(), [
    "Android.bp",
    "OwnedChromium.apk",
    "browser.mk",
  ]);
  assert.doesNotMatch(
    fs.readFileSync(path.join(directory, "Android.bp"), "utf8"),
    /product_specific|overrides/,
  );
});
