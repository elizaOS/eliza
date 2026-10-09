import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const android = fileURLToPath(new URL("../../android", import.meta.url));
test("Android make rejects unsupported targets before build or provisioning", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "android make-"));
  try {
    await writeFile(
      path.join(directory, "node"),
      '#!/bin/sh\nprintf "NODE_STARTED %s\\n" "$@"\ncase "$1" in *build-aosp.ts) printf "RISCV_OPTIONAL=%s\\n" "${ELIZA_BUN_RISCV64_OPTIONAL-unset}";; esac\n',
      { mode: 0o700 },
    );
    const run = (target, arch) =>
      spawnSync(
        "make",
        [
          "--no-print-directory",
          "-j2",
          "-C",
          android,
          target,
          `ARCH=${arch}`,
          `ELIZAOS_ELIZA_ROOT=${directory}`,
          `AOSP_ROOT=${directory}`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            ELIZA_BUN_RISCV64_OPTIONAL: undefined,
            PATH: `${directory}:${process.env.PATH}`,
          },
        },
      );
    for (const arch of ["x86_64", "arm64", "", "riscv64;echo injected"]) {
      const result = run("build-e1", arch);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /E1 simulator requires ARCH=riscv64/);
      assert.doesNotMatch(result.stdout, /NODE_STARTED/);
    }
    for (const arch of ["", "x86_64 arm64", "%", "x86_64;echo injected"]) {
      const result = run("build", arch);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unsupported ARCH/);
      assert.doesNotMatch(result.stdout, /NODE_STARTED/);
    }
    for (const target of ["bootstrap", "build", "sim"]) {
      const result = run(target, "arm64");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout
          .split("\n")
          .filter((line) => line === `NODE_STARTED ${directory}`).length,
        1,
        target,
      );
    }
    const valid = run("build-e1", "riscv64");
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /NODE_STARTED .*compile-libllama/);
    assert.match(valid.stdout, /NODE_STARTED .*provision-cuttlefish-e1/);
    assert.match(valid.stdout, /NODE_STARTED .*build-aosp/);
    assert.match(valid.stdout, /RISCV_OPTIONAL=unset/);
    assert.equal(
      valid.stdout
        .split("\n")
        .filter((line) => line === `NODE_STARTED ${directory}`).length,
      2,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
