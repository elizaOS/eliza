import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  installPinnedPlatformTools,
  resolvePlatformTools,
} from "../../setup/vendor/platform-tools-installer.mjs";

function fixture(t, names = ["adb", "fastboot", "lib64/helper.so"]) {
  const root = mkdtempSync(join(tmpdir(), "platform-tools-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source");
  mkdirSync(source);
  for (const name of names) {
    const path = join(source, "platform-tools", name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "verified payload");
  }
  execFileSync("zip", ["-qr", join(root, "fixture.zip"), "platform-tools"], {
    cwd: source,
  });
  const archive = readFileSync(join(root, "fixture.zip"));
  const vendorRoot = join(root, "vendor");
  mkdirSync(join(vendorRoot, "platform-tools"), { recursive: true });
  writeFileSync(
    join(vendorRoot, "platform-tools", "old"),
    "working installation",
  );
  return {
    vendorRoot,
    platform: "linux",
    config: {
      linux: {
        url: "https://dl.google.com/android/repository/platform-tools-test-linux.zip",
        sha256: createHash("sha256").update(archive).digest("hex"),
        size: archive.length,
      },
    },
    fetchImpl: async () => new Response(archive),
  };
}

function preserved(options) {
  assert.equal(
    readFileSync(join(options.vendorRoot, "platform-tools/old"), "utf8"),
    "working installation",
  );
  assert.deepEqual(readdirSync(options.vendorRoot), ["platform-tools"]);
}

test("publishes the complete verified directory and removes staging", async (t) => {
  const options = fixture(t);
  const destination = await installPinnedPlatformTools(options);
  assert.equal(
    readFileSync(join(destination, "lib64/helper.so"), "utf8"),
    "verified payload",
  );
  assert.deepEqual(readdirSync(destination).sort(), [
    "adb",
    "fastboot",
    "lib64",
  ]);
  assert.deepEqual(readdirSync(options.vendorRoot), ["platform-tools"]);
});

test("rejects missing pins before fetching", async (t) => {
  const options = fixture(t);
  options.config.linux.sha256 = null;
  options.fetchImpl = () => assert.fail("must not fetch");
  await assert.rejects(installPinnedPlatformTools(options), /Invalid pinned/);
  preserved(options);
});

for (const mismatch of ["sha256", "size"]) {
  test(`preserves installed tools on ${mismatch} mismatch`, async (t) => {
    const options = fixture(t);
    options.config.linux[mismatch] = mismatch === "sha256" ? "0".repeat(64) : 1;
    await assert.rejects(
      installPinnedPlatformTools(options),
      /does not match pinned/,
    );
    preserved(options);
  });
}

test("rejects an incomplete extracted tool set without replacing existing tools", async (t) => {
  const options = fixture(t, ["adb"]);
  await assert.rejects(installPinnedPlatformTools(options), /ENOENT/);
  preserved(options);
});

test("cleans up an interrupted download and leaves installed tools intact", async (t) => {
  const options = fixture(t);
  options.fetchImpl = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3]));
          controller.error(new Error("connection interrupted"));
        },
      }),
    );
  await assert.rejects(
    installPinnedPlatformTools(options),
    /connection interrupted/,
  );
  preserved(options);
});

test("concurrent installer cannot remove the current installer's lock", async (t) => {
  const options = fixture(t);
  mkdirSync(join(options.vendorRoot, ".platform-tools-install.lock"));
  await assert.rejects(installPinnedPlatformTools(options), /EEXIST/);
  assert.deepEqual(readdirSync(options.vendorRoot).sort(), [
    ".platform-tools-install.lock",
    "platform-tools",
  ]);
});

test("rejects redirects and non-Google download metadata", () => {
  for (const url of [
    "http://dl.google.com/android/repository/platform-tools-linux.zip",
    "https://example.com/platform-tools-linux.zip",
  ]) {
    assert.throws(
      () =>
        resolvePlatformTools(
          { linux: { url, sha256: "a".repeat(64) } },
          "linux",
        ),
      /Invalid pinned/,
    );
  }
});
