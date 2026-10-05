import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareAndroidConsumerInputs } from "./android-consumer-inputs.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-consumer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  fs.mkdirSync(source);
  const put = (name, text) => {
    const dest = path.join(source, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  };
  put(".gitignore", "packages/os/browser/dist/\n");
  put(
    "packages/os/browser/scripts/build.mjs",
    `import fs from 'node:fs';fs.mkdirSync('packages/os/browser/dist/android',{recursive:true});fs.writeFileSync('packages/os/browser/dist/android/identity.json',JSON.stringify({application:process.env.ELIZA_BROWSER_ANDROID_APPLICATION,certificate:process.env.ELIZA_BROWSER_ANDROID_CERTIFICATE}));`,
  );
  put(
    "packages/os/browser/scripts/chromium-component.mjs",
    `export const assetNames=['identity.json'];export const pin={revision:'fixture-revision'};export function validateAssets(assets,platform,certificate,application){const value=JSON.parse(assets['identity.json']);if(platform!=='android'||value.application!==application||value.certificate!==certificate)throw new Error('identity mismatch');}`,
  );
  const git = (...args) =>
    execFileSync("git", ["-C", source, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "fixture",
  );
  const apksigner = path.join(root, "signer");
  fs.writeFileSync(
    apksigner,
    `#!/bin/sh\nprintf 'Signer #1 certificate SHA-256 digest: ${"a".repeat(64)}\\n'\n`,
    { mode: 0o700 },
  );
  const apk = path.join(root, "app.apk");
  fs.writeFileSync(apk, "fixture APK");
  return {
    root,
    source,
    apk,
    apksigner,
    options: {
      source,
      expectedCommit: git("rev-parse", "HEAD"),
      apk,
      output: path.join(root, "output"),
      application: "example.consumer",
      apksigner,
    },
  };
}

test("builds identity-bound assets and composes host policy without claiming a browser build", async (t) => {
  const f = fixture(t);
  const result = await prepareAndroidConsumerInputs({
    ...f.options,
    composeAssets: async ({ assets }) => ({
      assets: { ...assets, "policy.mjs": Buffer.from("// host policy") },
      provenance: { host: true },
    }),
  });
  assert.equal(result.certificateSha256, "a".repeat(64));
  assert.equal(result.sourceCommit, f.options.expectedCommit);
  assert.deepEqual(result.composition, { host: true });
  assert.equal(Object.keys(result.resources).length, 2);
  assert.equal(
    fs.readFileSync(
      path.join(f.options.output, "extension/policy.mjs"),
      "utf8",
    ),
    "// host policy",
  );
  await assert.rejects(prepareAndroidConsumerInputs(f.options), /must be new/);
});

test("rejects wrong source, multiple signers and identity drift", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    prepareAndroidConsumerInputs({
      ...f.options,
      expectedCommit: "b".repeat(40),
    }),
    /reviewed commit/,
  );
  fs.appendFileSync(
    f.apksigner,
    `printf 'Signer #2 certificate SHA-256 digest: ${"b".repeat(64)}\\n'\n`,
  );
  await assert.rejects(prepareAndroidConsumerInputs(f.options), /Exactly one/);
  assert.equal(fs.existsSync(f.options.output), false);
});

test("post-build admission rejects changed APK/source, invalid identity and escaping asset names", async (t) => {
  for (const scenario of ["apk", "source", "identity", "escape"]) {
    const f = fixture(t);
    await assert.rejects(
      prepareAndroidConsumerInputs({
        ...f.options,
        composeAssets: async ({ assets }) => {
          if (scenario === "apk") fs.appendFileSync(f.apk, "changed");
          if (scenario === "source")
            fs.writeFileSync(
              path.join(f.source, "packages/os/browser/unreviewed.mjs"),
              "changed",
            );
          if (scenario === "identity")
            assets["identity.json"] = Buffer.from("{}");
          if (scenario === "escape") assets["../escape"] = Buffer.from("bad");
          return { assets };
        },
      }),
      /APK changed|must be clean|identity mismatch|asset name/,
    );
    assert.equal(fs.existsSync(path.join(f.options.output, "escape")), false);
  }
});
