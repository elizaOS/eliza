import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  closeAospBuildEnvironment,
  prepareAospBuildEnvironment,
  revalidateAospBuildEnvironment,
} from "../distro-android/build-aosp.ts";

test("prepared AOSP outputs remain relative for Siso and resolve to the validated directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aosp-siso-env-"));
  const external = await mkdtemp(path.join(tmpdir(), "aosp-siso-output-"));
  try {
    for (const env of [
      {},
      { OUT_DIR: "custom" },
      { OUT_DIR: external },
      { OUT_DIR_COMMON_BASE: external },
    ]) {
      const prepared = prepareAospBuildEnvironment(root, env);
      try {
        assert.equal(path.isAbsolute(prepared.env.OUT_DIR), false);
        assert.equal(
          path.resolve(fs.realpathSync(root), prepared.env.OUT_DIR),
          prepared.canonicalOutputRoot,
        );
        assert.equal(
          prepared.env.TMPDIR,
          path.join(prepared.canonicalOutputRoot, ".elizaos-tmp"),
        );
        revalidateAospBuildEnvironment(prepared);
      } finally {
        closeAospBuildEnvironment(prepared);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(external, { recursive: true, force: true });
  }
});

test("AOSP environment retains validated directories until explicit cleanup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aosp-env-"));
  try {
    const prepared = prepareAospBuildEnvironment(root, {});
    revalidateAospBuildEnvironment(prepared);
    const descriptors = [
      prepared.tempFd,
      ...prepared.outputPathHandles.map(({ fd }) => fd),
    ];
    closeAospBuildEnvironment(prepared);
    for (const fd of descriptors)
      assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AOSP cleanup attempts every close and retains each original failure", () => {
  const original = fs.closeSync;
  const calls = [];
  const errors = new Map([
    [101, new Error("temp close")],
    [102, new Error("parent close")],
    [103, new Error("child close")],
  ]);
  fs.closeSync = (fd) => {
    calls.push(fd);
    throw errors.get(fd);
  };
  try {
    assert.throws(
      () =>
        closeAospBuildEnvironment({
          tempFd: 101,
          outputPathHandles: [{ fd: 102 }, { fd: 103 }],
        }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors[0], errors.get(101));
        assert.deepEqual(error.errors[1].errors, [
          errors.get(103),
          errors.get(102),
        ]);
        return true;
      },
    );
    assert.deepEqual(calls, [101, 103, 102]);
  } finally {
    fs.closeSync = original;
  }
});

test("AOSP preparation retains its failure when cleanup also fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "aosp-env-errors-"));
  const chmod = fs.fchmodSync;
  const close = fs.closeSync;
  const primary = new Error("temporary directory mode failed");
  const cleanup = new Error("temporary descriptor close failed");
  const closed = [];
  fs.fchmodSync = () => {
    throw primary;
  };
  fs.closeSync = (fd) => {
    close(fd);
    closed.push(fd);
    if (closed.length === 1) throw cleanup;
  };
  try {
    assert.throws(
      () => prepareAospBuildEnvironment(root, {}),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [primary, cleanup]);
        return true;
      },
    );
    assert.ok(closed.length > 1);
    for (const fd of closed)
      assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
  } finally {
    fs.fchmodSync = chmod;
    fs.closeSync = close;
    await rm(root, { recursive: true, force: true });
  }
});
