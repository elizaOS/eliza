/** Exercises the preparation CLI against hash-checked source fixtures, not a Chromium build. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assetNames, pin } from "../../browser/scripts/chromium-component.mjs";

const browser = fileURLToPath(new URL("../../browser/", import.meta.url));
const script = fileURLToPath(
  new URL("../android/prepare-chromium-browser.ts", import.meta.url),
);
const certificate = "a".repeat(64);

function fixture(t, application) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "chromium-host-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const extension = path.join(root, "extension");
  fs.mkdirSync(source);
  fs.mkdirSync(extension);
  execFileSync("git", ["init", "--quiet", source]);
  // Synthetic HEAD plus the exact reviewed source fixtures allows the real
  // generator/apply path to run without downloading an entire Chromium tree.
  fs.writeFileSync(path.join(source, ".git/HEAD"), `${pin.revision}\n`);
  for (const name of Object.keys(pin.sha256)) {
    const output = path.join(source, name);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.copyFileSync(
      path.join(browser, "scripts/chromium/fixtures", name),
      output,
    );
  }
  for (const name of assetNames)
    fs.writeFileSync(path.join(extension, name), "// fixture\n");
  const identity = JSON.parse(
    fs.readFileSync(path.join(browser, "identity.json"), "utf8"),
  );
  fs.writeFileSync(
    path.join(extension, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      name: "Test",
      version: "1.0",
      key: identity.chromeDevManifestKey,
      permissions: [
        "tabs",
        "scripting",
        "webNavigation",
        "storage",
        "nativeMessaging",
        "alarms",
      ],
      host_permissions: ["http://*/*", "https://*/*"],
      background: { service_worker: "background.mjs", type: "module" },
    }),
  );
  const host = {
    application,
    androidCertificates: [certificate.toUpperCase()],
  };
  fs.writeFileSync(
    path.join(extension, "runtime-config.mjs"),
    `export const nativeHost = ${JSON.stringify(host)};\n`,
  );
  const out = path.join(root, "overlay");
  return {
    source,
    out,
    host,
    args: [
      script,
      "--source",
      source,
      "--extension",
      extension,
      "--out",
      out,
      "--certificate",
      certificate,
    ],
  };
}

for (const application of ["ai.elizaos.app", "org.example.helper"]) {
  test(`preparation preserves ${application} through generation and patch application`, (t) => {
    const f = fixture(t, application);
    if (application !== "ai.elizaos.app")
      f.args.push("--application", application);
    const report = JSON.parse(
      execFileSync(process.execPath, f.args, { encoding: "utf8" }),
    );
    assert.deepEqual(report.nativeHost, f.host);
    assert.equal(report.releaseQualified, false);
    const applied = fs.readFileSync(
      path.join(
        f.source,
        "chrome/browser/resources/eliza_browser/runtime-config.mjs",
      ),
      "utf8",
    );
    assert.equal(
      applied,
      `export const nativeHost = ${JSON.stringify(f.host)};\n`,
    );
  });
}

test("invalid application rejects before producing or applying an overlay", (t) => {
  const f = fixture(t, "ai.elizaos.app");
  const run = spawnSync(
    process.execPath,
    [...f.args, "--application", "../escape"],
    { encoding: "utf8" },
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /valid application ID/);
  assert.equal(fs.existsSync(f.out), false);
  assert.equal(
    fs.existsSync(
      path.join(f.source, "chrome/browser/resources/eliza_browser"),
    ),
    false,
  );
});

test("assets for another application cannot be applied under the requested host", (t) => {
  const f = fixture(t, "ai.elizaos.app");
  const run = spawnSync(
    process.execPath,
    [...f.args, "--application", "org.example.helper"],
    { encoding: "utf8" },
  );
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Native host configuration/);
  assert.equal(fs.existsSync(f.out), false);
  assert.equal(
    fs.existsSync(
      path.join(f.source, "chrome/browser/resources/eliza_browser"),
    ),
    false,
  );
});
