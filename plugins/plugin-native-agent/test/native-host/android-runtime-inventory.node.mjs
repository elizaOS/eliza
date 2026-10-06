import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ANDROID_RUNTIME_INVENTORY_ASSET,
  DEFAULT_ANDROID_RUNTIME_INVENTORY_FORMAT,
  stageAndroidRuntimeInventory,
} from "../../native-host/android-runtime-inventory.mjs";

const plugin = fileURLToPath(new URL("../..", import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetsDirectory = path.join(root, "assets"),
    nativeLibraryDirectory = path.join(root, "native");
  fs.mkdirSync(path.join(assetsDirectory, "agent/gateway"), {
    recursive: true,
  });
  fs.mkdirSync(nativeLibraryDirectory);
  for (const [name, bytes] of [
    ["agent-bundle.js", "synthetic agent fixture"],
    ["gateway/bootstrap.mjs", "synthetic bootstrap"],
    ["gateway/local-agent-gateway.mjs", "synthetic gateway"],
    ["extension.tar", "synthetic tar fixture"],
  ])
    fs.writeFileSync(path.join(assetsDirectory, "agent", name), bytes);
  for (const name of ["libeliza_bun.so", "libeliza_ld_musl_aarch64.so"])
    fs.writeFileSync(
      path.join(nativeLibraryDirectory, name),
      "synthetic native bytes; no execution",
    );
  return { root, assetsDirectory, nativeLibraryDirectory };
}
test("Node inventory interoperates with immutable Java extraction, restart and integrity checks", (t) => {
  const f = fixture(t),
    first = stageAndroidRuntimeInventory(f),
    second = stageAndroidRuntimeInventory(f);
  assert.deepEqual(second, first);
  const classes = path.join(f.root, "classes");
  fs.mkdirSync(classes);
  const bin = (name) =>
    process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", name)
      : name;
  execFileSync(
    bin("javac"),
    [
      "-d",
      classes,
      path.join(
        plugin,
        "android/src/main/java/ai/eliza/plugins/agent/runtime/RuntimeBundleStore.java",
      ),
      path.join(
        plugin,
        "android/src/main/java/ai/eliza/plugins/agent/runtime/RuntimeAssets.java",
      ),
      path.join(plugin, "test/native-host/RuntimeInventoryInterop.java"),
    ],
    { timeout: 60000 },
  );
  assert.match(
    execFileSync(
      bin("java"),
      [
        "-cp",
        classes,
        "ai.eliza.plugins.agent.runtime.test.RuntimeInventoryInterop",
        f.root,
      ],
      { encoding: "utf8", timeout: 60000 },
    ),
    /tamper rejection passed/,
  );
});
test("unsafe inputs and incomplete inventories cannot replace the admitted manifest", (t) => {
  const f = fixture(t),
    first = stageAndroidRuntimeInventory(f),
    manifest = fs.readFileSync(first.manifestPath);
  const link = path.join(f.assetsDirectory, "agent/link");
  fs.symlinkSync("/etc/hosts", link);
  assert.throws(() => stageAndroidRuntimeInventory(f), /symlinks/);
  fs.unlinkSync(link);
  fs.unlinkSync(path.join(f.nativeLibraryDirectory, "libeliza_bun.so"));
  assert.throws(
    () => stageAndroidRuntimeInventory(f),
    /Incomplete runtime native/,
  );
  assert.deepEqual(fs.readFileSync(first.manifestPath), manifest);
});
test("archive destination collisions and altered existing blobs fail closed", (t) => {
  const f = fixture(t),
    first = stageAndroidRuntimeInventory(f);
  fs.mkdirSync(path.join(f.assetsDirectory, "agent/nested"));
  const collision = path.join(f.assetsDirectory, "agent/nested/extension.tar");
  fs.writeFileSync(collision, "different archive");
  assert.throws(
    () => stageAndroidRuntimeInventory(f),
    /Duplicate runtime destination/,
  );
  fs.unlinkSync(collision);
  const blobs = path.join(f.assetsDirectory, "runtime-blobs");
  fs.writeFileSync(path.join(blobs, fs.readdirSync(blobs)[0]), "changed");
  assert.throws(
    () => stageAndroidRuntimeInventory(f),
    /Existing runtime blob changed/,
  );
  assert.ok(fs.existsSync(first.manifestPath));
});
test("host exclusions apply to exact directories, without skipping sibling assets", (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.assetsDirectory, "agent/models"));
  fs.writeFileSync(
    path.join(f.assetsDirectory, "agent/models/model.bin"),
    "excluded",
  );
  fs.writeFileSync(
    path.join(f.assetsDirectory, "agent/models.txt"),
    "included",
  );
  const result = stageAndroidRuntimeInventory({
    ...f,
    excludedAgentDirectories: ["models"],
  });
  const text = fs.readFileSync(result.manifestPath, "utf8");
  assert.match(text, /bundle\/models.txt/);
  assert.doesNotMatch(text, /bundle\/models\//);
  assert.throws(
    () =>
      stageAndroidRuntimeInventory({
        ...f,
        excludedAgentDirectories: ["../agent"],
      }),
    /Invalid runtime asset exclusions/,
  );
});

test("archive names match Java admission and existing blob directories become private", (t) => {
  const f = fixture(t),
    blobs = path.join(f.assetsDirectory, "runtime-blobs");
  fs.mkdirSync(blobs);
  fs.chmodSync(blobs, 0o777);
  const first = stageAndroidRuntimeInventory(f);
  assert.equal(fs.statSync(blobs).mode & 0o777, 0o700);
  const original = fs.readFileSync(first.manifestPath);
  fs.writeFileSync(
    path.join(f.assetsDirectory, "agent/pglite@0.3.tar"),
    "synthetic tar fixture",
  );
  assert.throws(
    () => stageAndroidRuntimeInventory(f),
    /Invalid runtime archive destination/,
  );
  assert.deepEqual(fs.readFileSync(first.manifestPath), original);
});

test("host-supplied inventory formats are validated and written as the first line", (t) => {
  const f = fixture(t),
    result = stageAndroidRuntimeInventory({ ...f, format: "host-runtime-v2" });
  assert.equal(
    result.manifestPath,
    path.join(f.assetsDirectory, ANDROID_RUNTIME_INVENTORY_ASSET),
  );
  assert.match(
    fs.readFileSync(result.manifestPath, "utf8"),
    /^host-runtime-v2\n/,
  );
  for (const format of ["", "bad\nheader", "../x", 1])
    assert.throws(
      () => stageAndroidRuntimeInventory({ ...f, format }),
      /Invalid runtime inventory format/,
    );
});

// The Go OTA verifier (packages/os/native/ota-trust) admits this packager output.
// Regenerate its testdata with stageAndroidRuntimeInventory when the format changes.
test("ota-trust verifier fixture is exactly what the packager writes", (t) => {
  const golden = fileURLToPath(
    new URL(
      "../../../../packages/os/native/ota-trust/testdata/runtime-apk",
      import.meta.url,
    ),
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-inventory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const assetsDirectory = path.join(root, "assets"),
    nativeLibraryDirectory = path.join(root, "lib/arm64-v8a");
  fs.cpSync(
    path.join(golden, "assets/agent"),
    path.join(assetsDirectory, "agent"),
    {
      recursive: true,
    },
  );
  fs.cpSync(path.join(golden, "lib/arm64-v8a"), nativeLibraryDirectory, {
    recursive: true,
  });
  const [blob] = fs.readdirSync(path.join(golden, "assets/runtime-blobs"));
  // Ignored packager inputs that the Go fixture restores the same way.
  fs.copyFileSync(
    path.join(golden, "assets/runtime-blobs", blob),
    path.join(assetsDirectory, "agent/extension.tar.gz"),
  );
  fs.mkdirSync(path.join(assetsDirectory, "agent/models"));
  fs.writeFileSync(
    path.join(assetsDirectory, "agent/models/model.bin"),
    "excluded synthetic model read directly from assets\n",
  );
  const result = stageAndroidRuntimeInventory({
    assetsDirectory,
    nativeLibraryDirectory,
    excludedAgentDirectories: ["models"],
  });
  const expected = fs.readFileSync(
    path.join(golden, "assets", ANDROID_RUNTIME_INVENTORY_ASSET),
  );
  assert.deepEqual(fs.readFileSync(result.manifestPath), expected);
  assert.ok(
    expected
      .toString("utf8")
      .startsWith(`${DEFAULT_ANDROID_RUNTIME_INVENTORY_FORMAT}\n`),
  );
  assert.deepEqual(
    fs.readdirSync(path.join(assetsDirectory, "runtime-blobs")),
    [blob],
  );
});
