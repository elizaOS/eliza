import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../../linux/build.sh", import.meta.url));
test("inner Linux wrapper accepts only documented build selectors", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "linux-inner-entry-"));
  try {
    await writeFile(
      path.join(directory, "make"),
      '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 17\n',
      { mode: 0o700 },
    );
    const run = (args) =>
      spawnSync(
        "bash",
        [path.join(path.dirname(script), "elizaos/build.sh"), ...args],
        {
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
          cwd: directory,
          encoding: "utf8",
        },
      );
    for (const args of [
      ["clean"],
      ["-f", "other.mk"],
      ["BUILDER_IMAGE=other"],
      ["--help", "clean"],
      ["ARCH="],
      ["PROFILE=unknown"],
    ]) {
      const result = run(args);
      assert.equal(result.status, 64, JSON.stringify(args));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /expected.*ARCH=.*PROFILE=/);
    }
    for (const flag of ["--help", "-h"]) {
      const result = run([flag]);
      assert.equal(result.status, 0);
      assert.match(result.stdout, /^usage:/);
    }
    const selected = run(["ARCH=arm64", "PROFILE=secure-gui"]);
    assert.equal(selected.status, 17);
    assert.match(selected.stdout, /ARCH=arm64\nPROFILE=secure-gui\n$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Linux entrypoint forwards mkosi builds and preserves make failures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "linux-build-entry-"));
  try {
    await writeFile(
      path.join(directory, "make"),
      '#!/bin/sh\nprintf "%s\\n" "$@"\nexit "$MAKE_EXIT"\n',
      { mode: 0o700 },
    );
    const env = { ...process.env, PATH: `${directory}:${process.env.PATH}` };
    for (const key of [
      "ELIZAOS_APP_ARTIFACT",
      "ELIZAOS_ARCH",
      "ELIZAOS_PROFILE",
      "MAKE_EXIT",
    ])
      delete env[key];
    const run = (args = [], overrides = {}) =>
      spawnSync("bash", [script, ...args], {
        env: { ...env, MAKE_EXIT: "0", ...overrides },
        cwd: directory,
        encoding: "utf8",
      });
    const built = run();
    assert.equal(built.status, 0, built.stderr);
    assert.deepEqual(built.stdout.trim().split("\n"), [
      "-C",
      path.join(path.dirname(script), "elizaos"),
      "build",
      "ARCH=amd64",
      "PROFILE=gui",
    ]);
    const alternate = run(["build"], {
      ELIZAOS_ARCH: "arm64",
      ELIZAOS_PROFILE: "secure-gui",
      MAKE_EXIT: "17",
    });
    assert.equal(alternate.status, 17);
    assert.match(alternate.stdout, /ARCH=arm64\nPROFILE=secure-gui/);
    for (const stage of ["config", "lint"]) {
      const result = run([stage]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /\nlint\n$/);
    }
    for (const args of [["unknown"], ["build", "ignored"]]) {
      const result = run(args);
      assert.equal(result.status, 64);
      assert.equal(result.stdout, "");
    }
    const legacy = run([], { ELIZAOS_APP_ARTIFACT: "/legacy/application" });
    assert.equal(legacy.status, 64);
    assert.match(legacy.stderr, /obsolete.*mkosi-linux-build.py/);
    assert.equal(legacy.stdout, "");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mkosi selectors fail before spawning a builder, including parallel make", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "mkosi-selectors-"));
  try {
    await writeFile(
      path.join(directory, "docker"),
      '#!/bin/sh\nprintf "BUILDER_STARTED\\n"\nexit 17\n',
      { mode: 0o700 },
    );
    const run = (selectors) =>
      spawnSync(
        "make",
        [
          "--no-print-directory",
          "-j2",
          "-C",
          path.join(path.dirname(script), "elizaos"),
          "mkosi-summary",
          ...selectors,
        ],
        {
          env: { ...process.env, PATH: `${directory}:${process.env.PATH}` },
          encoding: "utf8",
        },
      );
    for (const selector of [
      "ARCH=",
      "ARCH=amd64 arm64",
      "ARCH=amd64;echo injected",
      "ARCH=%",
      "PROFILE=",
      "PROFILE=gui secure",
      "PROFILE=gui;echo injected",
      "PROFILE=%",
    ]) {
      const result = run([selector]);
      assert.notEqual(result.status, 0, selector);
      assert.match(result.stderr, /Unsupported (ARCH|PROFILE)/);
      assert.doesNotMatch(result.stdout, /BUILDER_STARTED/);
    }
    const valid = run(["ARCH=arm64", "PROFILE=secure-gui"]);
    assert.equal(valid.status, 2);
    assert.match(valid.stdout, /BUILDER_STARTED/);
    assert.match(valid.stderr, /Error 17/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
