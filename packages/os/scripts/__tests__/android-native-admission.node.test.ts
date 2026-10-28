import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  elizaNativeAdmission,
  finalizeAndroidNative,
  stageAndroidNative,
} from "../android/android-native-admission.mjs";
import { composePixel10aProduct } from "../android/pixel10a-product.ts";
import { renderOverlay } from "../android/stage-launcher-overlay.ts";

const fixtureScript = fileURLToPath(
  new URL("./android-native-admission.test.py", import.meta.url),
);
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-admission-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("Python source, pin, byte-integrity and packaging regressions", () => {
  execFileSync("python3", [fixtureScript], { stdio: "pipe" });
});

test("Eliza admission uses the reviewed commit's Bun pin despite local modifications", (t) => {
  const root = temporary(t);
  const pinFile = path.join(
    root,
    "packages/app/scripts/lib/android-bun-artifacts.lock.json",
  );
  fs.mkdirSync(path.dirname(pinFile), { recursive: true });
  const pin = {
    version: "1.4.2",
    revision: "1".repeat(40),
    artifacts: { aarch64: { binarySha256: "2".repeat(64) } },
  };
  fs.writeFileSync(
    pinFile,
    JSON.stringify({
      channels: { stable: pin },
      targets: { android: { stable: pin } },
    }),
  );
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "pin",
  );
  const sourceCommit = git("rev-parse", "HEAD");
  fs.writeFileSync(pinFile, "changed checkout bytes");
  const admission = elizaNativeAdmission({
    sourceRoot: root,
    sourceCommit,
    packageName: "ai.elizaos.app",
  });
  assert.deepEqual(admission.bunPin, pin);
  assert.equal(admission.source.commit, sourceCommit);
  assert.equal(admission.source.package, "ai.elizaos.app");
  assert.deepEqual(
    elizaNativeAdmission({
      sourceRoot: root,
      sourceCommit,
      packageName: "ai.elizaos.app",
      bunTarget: "android",
    }).bunPin,
    pin,
  );
  assert.throws(
    () =>
      elizaNativeAdmission({
        sourceRoot: root,
        sourceCommit: "HEAD",
        packageName: "ai.elizaos.app",
      }),
    /full reviewed/,
  );
});

function stagedFixture(t, options = {}) {
  const output = path.join(temporary(t), "overlay");
  execFileSync("python3", [fixtureScript, "--fixture", output]);
  const apk = path.join(output, "Launcher.apk");
  fs.renameSync(path.join(output, "launcher.apk"), apk);
  const launcher = {
    schemaVersion: 1,
    brand: "eliza",
    moduleName: "Eliza",
    packageName: "ai.elizaos.app",
    apkSha256: createHash("sha256").update(fs.readFileSync(apk)).digest("hex"),
    certificateSha256: "b".repeat(64),
    ...options,
  };
  fs.writeFileSync(
    path.join(output, "Android.bp"),
    renderOverlay(launcher).blueprint,
  );
  const admission = JSON.parse(
    fs.readFileSync(path.join(output, "admission.json"), "utf8"),
  );
  const evidence = stageAndroidNative({
    apk,
    output,
    moduleName: launcher.moduleName,
    launcher,
    admission,
  });
  return { output, launcher, evidence, admission, apk };
}

test("common native staging preserves admitted companion and revocable permission definitions", (t) => {
  const { output, evidence } = stagedFixture(t, {
    defaultPermissions: ["android.permission.RECORD_AUDIO"],
    companions: [
      {
        moduleName: "Companion",
        packageName: "ai.elizaos.companion",
        apkSha256: "c".repeat(64),
      },
    ],
  });
  assert.equal(evidence.nativeLibrariesStaged, true);
  assert.equal(evidence.residentAgentIncluded, true);
  const blueprint = fs.readFileSync(path.join(output, "Android.bp"), "utf8");
  assert.match(blueprint, /name: "Companion"/);
  assert.match(blueprint, /ElizaDefaultPermissions/);
  assert.doesNotMatch(blueprint, /privileged: true/);
});

test("product composition requires bound native evidence and rechecks copied native bytes", (t) => {
  const f = stagedFixture(t);
  const product = JSON.parse(
    fs.readFileSync(
      new URL("../../android/products/pixel10a-eliza.json", import.meta.url),
      "utf8",
    ),
  );
  assert.throws(
    () =>
      composePixel10aProduct({
        ...f,
        product,
        nativeStagingEvidence: { ...f.evidence, apkSha256: "0".repeat(64) },
      }),
    /differs from the admitted launcher/,
  );
  fs.appendFileSync(
    path.join(f.output, "native-arm64/libeliza_bun.so"),
    "changed",
  );
  assert.throws(
    () =>
      composePixel10aProduct({
        ...f,
        product,
        nativeStagingEvidence: f.evidence,
      }),
    /staged bytes differ/,
  );
  assert.equal(fs.existsSync(path.join(f.output, "stallion")), false);
});

for (const brand of ["alpha", "eliza"]) {
  test(`${brand} composes native payloads and converts to Soong without changing admitted bytes`, (t) => {
    const product = JSON.parse(
      fs.readFileSync(
        new URL(
          `../../android/products/pixel10a-${brand}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const f = stagedFixture(t, {
      brand,
      ...product.launcher,
      defaultPermissions: ["android.permission.RECORD_AUDIO"],
      companions: [
        {
          moduleName: "Companion",
          packageName: "ai.elizaos.companion",
          apkSha256: "c".repeat(64),
        },
      ],
    });
    const report = composePixel10aProduct({
      ...f,
      product,
      nativeStagingEvidence: f.evidence,
    });
    const final = finalizeAndroidNative({
      ...f,
      moduleName: f.launcher.moduleName,
    });
    assert.deepEqual(final, f.evidence);
    assert.equal(report.nativeLibrariesStaged, true);
    assert.equal(report.imageBuilt, false);
    assert.equal(report.releaseQualified, false);
    assert.equal(final.runtimeVerified, false);
    assert.equal(fs.existsSync(path.join(f.output, "Android.mk")), false);
    const blueprint = fs.readFileSync(
      path.join(f.output, "Android.bp"),
      "utf8",
    );
    assert.equal(
      blueprint.match(/prebuilt_app_native \{/g)?.length,
      final.libraries.length,
    );
    assert.match(blueprint, /name: "Companion"/);
    assert.match(blueprint, /DefaultPermissions/);
    assert.doesNotMatch(blueprint, /privileged: true/);
    for (const entry of final.libraries) {
      assert.equal(
        createHash("sha256")
          .update(fs.readFileSync(path.join(f.output, entry.path)))
          .digest("hex"),
        entry.sha256,
      );
      assert.ok(
        blueprint.includes(
          `relative_install_path: "${f.launcher.moduleName}/lib/arm64"`,
        ),
      );
    }
    assert.ok(
      fs
        .readFileSync(path.join(f.output, "product.mk"), "utf8")
        .includes("config.fs"),
    );
  });
}

test("Soong conversion refuses changed APK, library or launcher definitions before replacing the Makefile", (t) => {
  for (const changed of [
    "Launcher.apk",
    "native-arm64/libeliza_bun.so",
    "Android.bp",
  ]) {
    const f = stagedFixture(t);
    fs.appendFileSync(path.join(f.output, changed), "changed");
    assert.throws(() =>
      finalizeAndroidNative({ ...f, moduleName: f.launcher.moduleName }),
    );
    assert.equal(fs.existsSync(path.join(f.output, "Android.mk")), true);
  }
});

test("native configuration mismatch refuses the whole pipeline before product publication", (t) => {
  const f = stagedFixture(t);
  const product = JSON.parse(
    fs.readFileSync(
      new URL("../../android/products/pixel10a-eliza.json", import.meta.url),
      "utf8",
    ),
  );
  const file = path.join(f.output, "config.fs");
  const original = fs.readFileSync(file, "utf8");
  const changed = original.replace("mode: 0755", "mode: 0777");
  assert.notEqual(changed, original);
  fs.writeFileSync(file, changed);
  assert.throws(() => {
    composePixel10aProduct({
      ...f,
      product,
      nativeStagingEvidence: f.evidence,
    });
    finalizeAndroidNative({ ...f, moduleName: f.launcher.moduleName });
  }, /filesystem configuration differs/);
  assert.equal(fs.existsSync(path.join(f.output, "stallion")), false);
  assert.equal(
    fs.existsSync(path.join(f.output, "physical-product.json")),
    false,
  );
  assert.equal(fs.existsSync(path.join(f.output, "Android.mk")), true);
});

test("native receipt must retain its unique APK entries, installation paths and modes", (t) => {
  const f = stagedFixture(t);
  const product = JSON.parse(
    fs.readFileSync(
      new URL("../../android/products/pixel10a-eliza.json", import.meta.url),
      "utf8",
    ),
  );
  for (const mutation of [
    (libraries) => {
      libraries[0].apkEntry = "lib/x86_64/libeliza_bun.so";
    },
    (libraries) => {
      libraries[0].installPath = "/product/app/Other/lib/arm64/libeliza_bun.so";
    },
    (libraries) => {
      libraries[0].mode = "0777";
    },
    (libraries) => {
      libraries.push({ ...libraries[0] });
    },
  ]) {
    const changed = structuredClone(f.evidence);
    mutation(changed.libraries);
    fs.writeFileSync(
      path.join(f.output, "native-libraries.json"),
      JSON.stringify(changed),
    );
    assert.throws(
      () =>
        composePixel10aProduct({
          ...f,
          product,
          nativeStagingEvidence: changed,
        }),
      /Invalid native staging entry/,
    );
    assert.equal(fs.existsSync(path.join(f.output, "stallion")), false);
    assert.equal(
      fs.existsSync(path.join(f.output, "physical-product.json")),
      false,
    );
  }
});
