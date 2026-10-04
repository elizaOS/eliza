import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("Bun wrapper rejects invalid jobs and mounts the canonical patch inputs", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "bun wrapper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const toolchain = path.join(root, "os/toolchains/bun-riscv64");
  const bin = path.join(root, "bin");
  await mkdir(toolchain, { recursive: true });
  await mkdir(bin);
  await mkdir(path.join(root, "scripts"));
  await writeFile(path.join(root, "scripts/rm-path-recursive.ts"), "");
  await cp(
    new URL("../../toolchains/bun-riscv64/", import.meta.url),
    toolchain,
    {
      recursive: true,
      filter: (source) => path.basename(source) !== "dist",
    },
  );
  await mkdir(path.join(root, "scripts/lib"));
  await cp(
    new URL("../../../scripts/lib/test-output.ts", import.meta.url),
    path.join(root, "scripts/lib/test-output.ts"),
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
  {
    await writeFile(log, "");
    const result = spawnSync("bash", [path.join(toolchain, "run-build.sh")], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DOCKER_LOG: log,
      },
      encoding: "utf8",
      timeout: 5000,
    });
    // Mock Docker creates no artifact; the wrapper must still report failure.
    assert.equal(result.status, 1);
    assert.match(result.stdout, /FAILED — no artifact/);
    const args = (await readFile(log, "utf8")).split("\n");
    assert.ok(
      args.includes(`${toolchain}/webkit-patches:/opt/webkit-patches:ro`),
    );
    assert.ok(args.includes(`${toolchain}/bun-patches:/opt/bun-patches:ro`));
  }
  const pins = JSON.parse(
    await readFile(path.join(toolchain, "bun-version.json"), "utf8"),
  );
  const patch = Object.keys(pins.patches.bun)[0];
  await writeFile(path.join(toolchain, "bun-patches", patch), "tampered");
  await writeFile(log, "");
  const invalid = spawnSync(
    "bash",
    [path.join(toolchain, "run-build.sh"), "--image-only"],
    {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        DOCKER_LOG: log,
      },
      encoding: "utf8",
      timeout: 15000,
    },
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Patch digest mismatch/);
  assert.equal(await readFile(log, "utf8"), "");
});
