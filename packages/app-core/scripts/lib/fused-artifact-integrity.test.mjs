/** Exercises native-set reuse against real staged files, corruption and target changes. */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  nativeLibraryIntegrityProblems,
  nativeLibraryInventory,
  nativeSourceFingerprint,
} from "./fused-artifact-integrity.mjs";

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fused-set-"));
  const fusedName = "libelizainference.so";
  fs.writeFileSync(path.join(directory, fusedName), "fused artifact");
  fs.writeFileSync(path.join(directory, "libggml.so.0"), "dependency artifact");
  const target = {
    platform: "linux",
    arch: "arm64",
    backend: "cpu",
    fusedName,
  };
  const stamp = { ...target, libraries: nativeLibraryInventory(directory) };
  return { directory, target, stamp };
}

test("reuse rejects missing, altered, and unexpected companions even when the fused file is unchanged", () => {
  const { directory, target, stamp } = fixture();
  try {
    assert.deepEqual(
      nativeLibraryIntegrityProblems(directory, stamp, target),
      [],
    );
    fs.unlinkSync(path.join(directory, "libggml.so.0"));
    assert.match(
      nativeLibraryIntegrityProblems(directory, stamp, target).join("\n"),
      /libggml.so.0/,
    );
    fs.writeFileSync(
      path.join(directory, "libggml.so.0"),
      "changed dependency",
    );
    assert.match(
      nativeLibraryIntegrityProblems(directory, stamp, target).join("\n"),
      /libggml.so.0/,
    );
    fs.writeFileSync(
      path.join(directory, "libggml.so.0"),
      "dependency artifact",
    );
    assert.deepEqual(
      nativeLibraryIntegrityProblems(directory, stamp, target),
      [],
    );
    fs.writeFileSync(path.join(directory, "libggml-cuda.so"), "old backend");
    assert.match(
      nativeLibraryIntegrityProblems(directory, stamp, target).join("\n"),
      /libggml-cuda.so/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("reuse rejects another architecture, explicit backend, or legacy incomplete stamp", () => {
  const { directory, target, stamp } = fixture();
  try {
    assert.ok(
      nativeLibraryIntegrityProblems(directory, stamp, {
        ...target,
        arch: "x64",
      }).length,
    );
    assert.ok(
      nativeLibraryIntegrityProblems(directory, stamp, {
        ...target,
        backend: "cuda",
      }).length,
    );
    assert.ok(
      nativeLibraryIntegrityProblems(
        directory,
        { ...stamp, libraries: undefined },
        target,
      ).length,
    );
    assert.deepEqual(
      nativeLibraryIntegrityProblems(directory, stamp, {
        ...target,
        backend: "auto",
      }),
      [],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a second edit to an already-dirty native source invalidates reuse", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "fused-source-"));
  const git = (...args) =>
    execFileSync("git", ["-C", directory, ...args], { stdio: "pipe" });
  try {
    git("init");
    fs.mkdirSync(path.join(directory, "src"));
    const source = path.join(directory, "src", "engine.c");
    fs.writeFileSync(source, "original");
    git("add", ".");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    );
    assert.equal(nativeSourceFingerprint(directory), "");
    fs.writeFileSync(source, "first edit");
    const first = nativeSourceFingerprint(directory);
    fs.writeFileSync(source, "second edit");
    assert.notEqual(nativeSourceFingerprint(directory), first);
    fs.writeFileSync(source, "original");
    assert.equal(nativeSourceFingerprint(directory), "");
    fs.writeFileSync(
      path.join(directory, "src", "new.c"),
      "new implementation",
    );
    assert.notEqual(nativeSourceFingerprint(directory), "");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
