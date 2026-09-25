import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("Bun wrapper rejects invalid jobs and selects Rust WebKit overrides with shared recipes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bun wrapper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const toolchain = path.join(root, "toolchains/bun-riscv64");
  const bin = path.join(root, "bin");
  await mkdir(toolchain, { recursive: true });
  await mkdir(bin);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts/rm-path-recursive.mjs"), "");
  await cp(
    new URL("../../toolchains/bun-riscv64/run-build.sh", import.meta.url),
    path.join(toolchain, "run-build.sh"),
  );
  const replacement = "0007-restore-dropped-includes-and-llint-fwd-decl.patch";
  await mkdir(path.join(toolchain, "rust-core/webkit-patches"), {
    recursive: true,
  });
  await writeFile(
    path.join(toolchain, "rust-core/webkit-patches", replacement),
    "fixture",
  );
  const log = path.join(root, "docker-args");
  await writeFile(
    path.join(bin, "docker"),
    '#!/bin/sh\nprintf "%s\\n" "$@" >> "$DOCKER_LOG"\n',
    { mode: 0o700 },
  );
  for (const args of [
    ["--jobs"],
    ["--jobs", "0"],
    ["--jobs", "-1"],
    ["--jobs", "1.5"],
    ["--jobs", "--shell"],
  ]) {
    await writeFile(log, "");
    const result = spawnSync(
      "bash",
      [path.join(toolchain, "run-build.sh"), ...args],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DOCKER_LOG: log,
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--jobs requires a positive integer/);
    assert.equal(await readFile(log, "utf8"), "");
  }
  for (const rust of [false, true]) {
    await writeFile(log, "");
    const result = spawnSync(
      "bash",
      [path.join(toolchain, "run-build.sh"), ...(rust ? ["--rust-core"] : [])],
      {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          DOCKER_LOG: log,
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    // Mock Docker creates no artifact; the wrapper must still report failure.
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAILED — no artifact/);
    const args = (await readFile(log, "utf8")).split("\n");
    assert.ok(
      args.includes(`${toolchain}/webkit-patches:/opt/webkit-patches:ro`),
    );
    assert.equal(
      args.includes(
        `${toolchain}/rust-core/webkit-patches/${replacement}:/opt/webkit-patches/${replacement}:ro`,
      ),
      rust,
    );
  }
});
