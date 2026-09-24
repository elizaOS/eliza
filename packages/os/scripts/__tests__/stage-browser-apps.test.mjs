/** Exercises artifact admission and preservation using real temporary vendor trees; APK signature qualification runs against the downloaded upstream artifacts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import {
  assertBrowserAppsStaged,
  readBrowserAppPins,
  stageBrowserApps,
} from "../distro-android/stage-browser-apps.mjs";

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
        arch: "riscv64",
        allowDevelopmentBrowser: true,
      }),
    /No verified chromium artifact/,
  );
});

test("AOSP sync admission refuses missing or changed staged artifacts", (t) => {
  const options = fixture(t);
  assert.throws(
    () => assertBrowserAppsStaged(options.vendorDir),
    /Missing or unverified chromium APK/,
  );
});

test("AOSP sync refuses an artifact pinned for a different product architecture", (t) => {
  const options = fixture(t);
  assert.throws(
    () => assertBrowserAppsStaged(options.vendorDir, "arm64"),
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
