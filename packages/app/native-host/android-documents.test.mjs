import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as tar from "tar";
import {
  assertArm64Library,
  extractVerifiedPackage,
  verifyAndroidDocuments,
} from "./android-documents.mjs";

test("document archive integrity is checked before extraction and symlinks are refused", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "document-package-test-"));
  try {
    fs.mkdirSync(path.join(temp, "package"));
    fs.writeFileSync(path.join(temp, "package/index.js"), "export {};");
    const archive = path.join(temp, "package.tgz");
    tar.c({ file: archive, cwd: temp, gzip: true, sync: true }, ["package"]);
    const integrity = () =>
      `sha512-${createHash("sha512").update(fs.readFileSync(archive)).digest("base64")}`;
    const output = path.join(temp, "output");
    assert.throws(
      () => extractVerifiedPackage(archive, "sha512-AAAA", output),
      /integrity/,
    );
    assert.equal(fs.existsSync(output), false);
    extractVerifiedPackage(archive, integrity(), output);
    assert.equal(
      fs.readFileSync(path.join(output, "index.js"), "utf8"),
      "export {};",
    );
    fs.symlinkSync("/tmp", path.join(temp, "package/escape"));
    tar.c({ file: archive, cwd: temp, gzip: true, sync: true }, ["package"]);
    assert.throws(
      () =>
        extractVerifiedPackage(archive, integrity(), path.join(temp, "unsafe")),
      /Unsafe/,
    );
    assert.equal(fs.existsSync(path.join(temp, "unsafe")), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test("document library rejects host Mach-O and wrong ELF architecture", () => {
  const elf = Buffer.alloc(64);
  elf.write("7f454c46", 0, "hex");
  elf[4] = 2;
  elf[5] = 1;
  elf.writeUInt16LE(3, 16);
  elf.writeUInt16LE(183, 18);
  assert.doesNotThrow(() => assertArm64Library(elf));
  elf.writeUInt16LE(62, 18);
  assert.throws(() => assertArm64Library(elf), /AArch64/);
  assert.throws(
    () => assertArm64Library(Buffer.from("cffaedfe", "hex")),
    /AArch64/,
  );
});
test("optional Android documents fail closed when files lack a manifest", () => {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "document-manifest-test-"),
  );
  try {
    assert.equal(verifyAndroidDocuments(temp), null);
    const gateway = path.join(
      temp,
      "android/app/src/main/assets/agent/gateway",
    );
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(path.join(gateway, "document-services.mjs"), "export {};");
    assert.throws(() => verifyAndroidDocuments(temp), /manifest missing/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
test("Android document admission checks bytes and task source before packaging", () => {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "document-admission-test-"),
  );
  try {
    const main = path.join(temp, "android/app/src/main");
    const prefix = "assets/agent/gateway/";
    const commit = "a".repeat(40);
    const elf = Buffer.alloc(64);
    elf.write("7f454c46", 0, "hex");
    elf[4] = 2;
    elf[5] = 1;
    elf.writeUInt16LE(3, 16);
    elf.writeUInt16LE(183, 18);
    const contents = {
      [`${prefix}document-services.mjs`]: "export {};",
      [`${prefix}document-services.mjs.json`]: JSON.stringify({
        sourceCommit: commit,
      }),
      [`${prefix}node_modules/@napi-rs/canvas/package.json`]: "{}",
      "jniLibs/arm64-v8a/libeliza_canvas.so": elf,
    };
    const files = Object.entries(contents).map(([name, bytes]) => {
      fs.mkdirSync(path.dirname(path.join(main, name)), { recursive: true });
      fs.writeFileSync(path.join(main, name), bytes);
      return {
        path: name,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    fs.writeFileSync(
      path.join(main, prefix, "document-services.manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        target: "linux-arm64-musl",
        sourceCommit: commit,
        files,
      }),
    );
    const task = path.join(main, prefix, "task-runtime.mjs.json");
    fs.writeFileSync(task, JSON.stringify({ sourceCommit: commit }));
    assert.equal(verifyAndroidDocuments(temp).sourceCommit, commit);
    fs.writeFileSync(task, JSON.stringify({ sourceCommit: "b".repeat(40) }));
    assert.throws(() => verifyAndroidDocuments(temp), /source mismatch/);
    fs.writeFileSync(task, JSON.stringify({ sourceCommit: commit }));
    fs.appendFileSync(
      path.join(main, prefix, "document-services.mjs"),
      "changed",
    );
    assert.throws(() => verifyAndroidDocuments(temp), /file mismatch/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
