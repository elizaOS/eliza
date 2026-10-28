import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { renderSensePermissions } from "./pixel10a-product.ts";
import {
  checkListenerPermissions,
  checkListenerSpeechBundle,
  checkListenerSpeechModels,
  checkListenerSpeechNatives,
  stageSenseListener,
  validateSenseProduct,
} from "./sense-listener.mjs";
import {
  prepareListenerSystemui,
  senseSystemuiPatch,
  verifyListenerSystemui,
} from "./sense-systemui.mjs";

const root = path.resolve(import.meta.dirname, "../../../..");
const load = (brand) =>
  JSON.parse(
    fs.readFileSync(
      path.join(root, `packages/os/android/products/pixel10a-${brand}.json`),
    ),
  );
const hash = (data) => createHash("sha256").update(data).digest("hex");
const signer = "a".repeat(64);
const requested = [
  "CAPTURE_AUDIO_HOTWORD",
  "START_ACTIVITIES_FROM_BACKGROUND",
  "RECORD_AUDIO",
  "FOREGROUND_SERVICE",
  "FOREGROUND_SERVICE_MICROPHONE",
  "POST_NOTIFICATIONS",
  "HIDE_OVERLAY_WINDOWS",
].map((name) => `android.permission.${name}`);
for (const brand of ["alpha", "eliza"])
  test(`${brand} uses shared source with its own stable identities and minimal privileges`, (t) => {
    const product = load(brand),
      config = validateSenseProduct(product);
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sense-stage-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const apk = path.join(temp, "input.apk");
    execFileSync("python3", [
      path.join(
        root,
        "packages/app/test/android/sense-fixtures/write-listener-apk.py",
      ),
      apk,
    ]);
    fs.writeFileSync(path.join(temp, "product.mk"), "# main launcher\n");
    const dump = [
      `package: ${config.packageName}`,
      ...requested.map((name) => `uses-permission: name='${name}'`),
    ].join("\n");
    const args = {
      output: temp,
      apk,
      dump,
      signer,
      launcherSigner: signer,
      product,
      hashEntry: () => hash(fs.readFileSync(apk)),
    };
    assert.throws(
      () => stageSenseListener({ ...args, launcherSigner: "b".repeat(64) }),
      /share/,
    );
    assert.equal(fs.existsSync(path.join(temp, "listener")), false);
    assert.throws(
      () => stageSenseListener({ ...args, production: true }),
      /reviewed.*descriptor/,
    );
    assert.equal(fs.existsSync(path.join(temp, "listener")), false);
    const result = stageSenseListener(args);
    assert.equal(result.packageName, `${product.launcher.packageName}.sense`);
    assert.equal(result.releaseQualified, false);
    assert.equal(result.speechIncluded, false);
    const overlay = fs.readFileSync(
      path.join(
        temp,
        "listener/systemui/chip/overlay/frameworks/base/packages/SystemUI/res/values/sense-listener.xml",
      ),
      "utf8",
    );
    assert.ok(overlay.includes(config.receiverClass));
    assert.ok(overlay.includes(config.hostPackage));
    assert.ok(overlay.includes(signer));
    const permission = fs.readFileSync(
      path.join(
        temp,
        `listener/permissions/privapp-permissions-${config.packageName}.xml`,
      ),
      "utf8",
    );
    assert.equal([...permission.matchAll(/<permission /g)].length, 2);
    assert.throws(
      () =>
        checkListenerPermissions(
          `${dump}\nuses-permission: name='android.permission.INTERNET'`,
          renderSensePermissions(config.hostPackage),
          config.packageName,
        ),
      /must not request/,
    );
    assert.throws(() => stageSenseListener(args), /already exists/);
  });
test("declarative configuration rejects unsafe names and cross-host assist components", () => {
  const base = load("eliza");
  for (const sense of [
    { ...base.sense, wakeNames: [] },
    { ...base.sense, wakeNames: ["eliza", "eliza"] },
    { ...base.sense, storageName: "../other" },
    { ...base.sense, assistActivity: "other.app.Assist" },
  ])
    assert.throws(() => validateSenseProduct({ ...base, sense }), /Invalid/);
});
test("production admission requires a bound descriptor and packaged, pinned ASR engine", () => {
  const record = {
    asrSlot: { paths: ["asr/phonon-2-fv5.gguf"] },
    abis: [
      {
        abi: "arm64-v8a",
        libraries: [{ name: "libelizainference.so", sha256: signer }],
      },
    ],
  };
  const entries = [
    "assets/paradee-voice/v1/manifest.json",
    "lib/arm64-v8a/libelizainference.so",
    "lib/arm64-v8a/libparadeevoicejni.so",
  ];
  assert.deepEqual(
    checkListenerSpeechBundle(entries, record, () =>
      JSON.stringify({ files: [{ path: "asr/phonon-2-fv5.gguf" }] }),
    ),
    ["arm64-v8a"],
  );
  assert.throws(
    () =>
      checkListenerSpeechBundle(entries, record, () =>
        JSON.stringify({ files: [] }),
      ),
    /ASR|phonon/,
  );
  assert.throws(
    () =>
      checkListenerSpeechNatives(["arm64-v8a"], record, () => "b".repeat(64)),
    /differs/,
  );
});
test("exact shared SystemUI patch stages only into a new overlay and retains all preimage fences", (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "sense-patch-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const source = path.join(temp, "source");
  fs.mkdirSync(source);
  fs.cpSync(
    path.join(root, "packages/os/test/fixtures/sense-systemui"),
    path.join(source, "frameworks/base"),
    { recursive: true },
  );
  const envelope = senseSystemuiPatch();
  assert.equal(envelope.manifest.files.length, 9);
  assert.equal(
    envelope.manifest.baselineLockSha256,
    "760a7184c62c93aeac40595cf5733f8089aa16ccd28eb7a5f5ce41d4dae741d3",
  );
  const output = path.join(temp, "overlay");
  const result = prepareListenerSystemui(source, output, "chip");
  assert.equal(result.systemUiCompiled, false);
  assert.equal(result.imageBuilt, false);
  assert.equal(verifyListenerSystemui(output, "after", "chip").files.length, 9);
  const generated = path.join(
    output,
    "frameworks/base",
    envelope.manifest.files[0].path,
  );
  const saved = `${generated}.saved`;
  fs.renameSync(generated, saved);
  fs.symlinkSync(saved, generated);
  assert.throws(
    () => verifyListenerSystemui(output, "after", "chip"),
    /regular, non-symlink/,
  );
  fs.unlinkSync(generated);
  fs.renameSync(saved, generated);
  assert.throws(
    () => prepareListenerSystemui(source, path.join(source, "unsafe"), "chip"),
    /outside/,
  );
  const entry = envelope.manifest.files[0];
  fs.appendFileSync(
    path.join(output, "frameworks/base", entry.path),
    "\nmutated",
  );
  assert.throws(
    () => verifyListenerSystemui(output, "after", "chip"),
    /mismatch/,
  );
  fs.appendFileSync(
    path.join(
      source,
      "frameworks/base",
      envelope.manifest.files.find((e) => e.beforeSha256).path,
    ),
    "\nmutated",
  );
  assert.throws(
    () => prepareListenerSystemui(source, path.join(temp, "refused"), "chip"),
    /mismatch/,
  );
});

test("Sense models bind the canonical Phonon, VAD and Paradee pins", () => {
  const pins = JSON.parse(
    fs.readFileSync(
      path.join(
        root,
        "plugins/plugin-local-inference/native/android/inputs.json",
      ),
    ),
  );
  const models = ["asr", "vad", "paradee", "lexicon"].map((key) => pins[key]);
  const entries = models.map((pin) => `assets/paradee-voice/v1/${pin.path}`);
  const hashes = new Map(models.map((pin, i) => [entries[i], pin.sha256]));
  assert.equal(
    checkListenerSpeechModels(entries, (entry) => hashes.get(entry)),
    true,
  );
  for (const entry of entries)
    assert.throws(
      () =>
        checkListenerSpeechModels(entries, (key) =>
          key === entry ? "b".repeat(64) : hashes.get(key),
        ),
      /canonical/,
    );
});
