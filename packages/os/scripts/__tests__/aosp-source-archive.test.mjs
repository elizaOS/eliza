import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadProfile,
  main,
  verifyArchive,
  verifyCheckout,
  verifyExtractedVendor,
} from "../aosp/verify-source-lock.mjs";

test("AOSP archive verification binds streamed bytes and rejects symlink inputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aosp-source-archive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 42);
  const archive = join(directory, "vendor.tgz");
  await writeFile(archive, bytes);
  const contract = {
    filename: "vendor.tgz",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  assert.deepEqual(verifyArchive({ proprietaryArchive: contract }, archive), {
    path: archive,
    sizeBytes: bytes.length,
    sha256: contract.sha256,
  });
  assert.throws(
    () =>
      verifyArchive(
        { proprietaryArchive: { ...contract, sizeBytes: 1 } },
        archive,
      ),
    /archive size/,
  );
  bytes[bytes.length - 1] = 43;
  await writeFile(archive, bytes);
  assert.throws(
    () => verifyArchive({ proprietaryArchive: contract }, archive),
    /SHA-256/,
  );
  await rm(archive);
  const source = join(directory, "source.tgz");
  await writeFile(source, bytes);
  await symlink(source, archive);
  assert.throws(
    () => verifyArchive({ proprietaryArchive: contract }, archive),
    { code: "ELOOP" },
  );
});

test("AOSP verification rejects incomplete CLI inputs and empty vendor contracts", async (t) => {
  for (const option of [
    "--profile",
    "--lock",
    "--aosp-root",
    "--vendor-archive",
  ]) {
    for (const tail of [[], ["--json"], [""]]) {
      assert.throws(() => main([option, ...tail]), /requires a value/);
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "aosp-source-lock-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const files of [
    undefined,
    [],
    ["../outside"],
    ["/absolute"],
    ["vendor/../outside"],
  ]) {
    assert.throws(
      () =>
        verifyExtractedVendor(
          { proprietaryArchive: { requiredExtractedFiles: files } },
          directory,
        ),
      /nonempty list of relative/,
    );
  }
  const contract = {
    proprietaryArchive: { requiredExtractedFiles: ["vendor.img"] },
  };
  await mkdir(join(directory, "vendor.img"));
  assert.throws(
    () => verifyExtractedVendor(contract, directory),
    /extraction is incomplete/,
  );
  await rm(join(directory, "vendor.img"), { recursive: true });
  await writeFile(join(directory, "vendor.img"), "fixture");
  assert.deepEqual(verifyExtractedVendor(contract, directory).files, [
    "vendor.img",
  ]);
  const lock = join(directory, "lock.json");
  for (const document of [
    null,
    { schemaVersion: 1, profiles: null },
    {
      schemaVersion: 1,
      profiles: {
        fixture: {
          kind: "virtual",
          manifest: {
            url: "https://example.com",
            tag: "release",
            commit: "abc",
            tagObject: "def",
          },
        },
      },
    },
  ]) {
    await writeFile(lock, JSON.stringify(document));
    assert.throws(
      () => loadProfile("fixture", lock),
      /AOSP lock|full Git object ID/,
    );
  }
  for (const name of ["cuttlefish", "pixel9a", "pixel11pro"])
    assert.equal(typeof loadProfile(name).manifest.commit, "string");
});

test("AOSP checkout verification requires real source files and reports profile-only scope", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "aosp-checkout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifests = join(directory, ".repo/manifests");
  await mkdir(manifests, { recursive: true });
  const git = (...args) =>
    execFileSync("git", ["-C", manifests, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "--quiet");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const commit = git("rev-parse", "HEAD");
  const profile = { manifest: { commit }, requiredSourceFiles: ["source.mk"] };
  await mkdir(join(directory, "source.mk"));
  assert.throws(
    () => verifyCheckout(profile, directory),
    /missing required source file/,
  );
  await rm(join(directory, "source.mk"), { recursive: true });
  await writeFile(join(directory, "source.mk"), "fixture");
  assert.equal(verifyCheckout(profile, directory).manifest, commit);
  assert.throws(
    () =>
      verifyCheckout(
        { ...profile, projects: [{ path: "../outside", commit }] },
        directory,
      ),
    /invalid locked project/,
  );
  assert.throws(
    () =>
      verifyCheckout(
        { ...profile, requiredSourceFiles: ["../outside"] },
        directory,
      ),
    /relative paths/,
  );
  const output = execFileSync(
    process.execPath,
    [
      new URL("../aosp/verify-source-lock.mjs", import.meta.url).pathname,
      "--profile",
      "cuttlefish",
    ],
    { encoding: "utf8" },
  );
  assert.match(output, /loaded profile only/);
  assert.doesNotMatch(output, /verified/);
});
