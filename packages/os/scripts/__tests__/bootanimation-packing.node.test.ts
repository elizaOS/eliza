import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs as parseBranded } from "../android/build-eliza-bootanimation.ts";
import { parseArgs as parseGeneric } from "../distro-android/build-bootanimation.ts";

const script = fileURLToPath(
  new URL("../distro-android/build-bootanimation.ts", import.meta.url),
);
const branded = fileURLToPath(
  new URL("../android/build-eliza-bootanimation.ts", import.meta.url),
);

test("shared argument parsing preserves brand defaults and explicit overrides", () => {
  assert.throws(() => parseGeneric([]), /--frames is required/);
  const defaults = parseBranded([]);
  assert.equal(
    defaults.framesDir,
    fileURLToPath(
      new URL("../../android/vendor/eliza/bootanimation", import.meta.url),
    ),
  );
  assert.equal(
    defaults.outPath,
    path.join(defaults.framesDir, "bootanimation.zip"),
  );
  const argv = ["--frames", "custom frames", "--out", "custom.zip", "--check"];
  assert.deepEqual(parseBranded(argv), parseGeneric(argv));
  for (const parse of [parseGeneric, parseBranded]) {
    assert.throws(() => parse(["--frames"]), /requires a value/);
    assert.throws(() => parse(["--unknown"]), /Unknown argument/);
  }
});

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "bootanimation packing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frames = path.join(root, "frames");
  await mkdir(path.join(frames, "part0"), { recursive: true });
  await writeFile(path.join(frames, "desc.txt"), "100 100 30\np 1 0 part0\n");
  await writeFile(path.join(frames, "part0", "000.png"), "fixture frame");
  const out = path.join(root, "bootanimation.zip");
  await writeFile(out, "previous archive");
  return { root, frames, out };
}

function run(entrypoint, frames, out, options = {}) {
  return spawnSync(
    process.execPath,
    [entrypoint, "--frames", frames, "--out", out, ...(options.args ?? [])],
    {
      encoding: "utf8",
      env: options.env ?? process.env,
    },
  );
}

test("failed packing preserves the previous archive and removes private staging", async (t) => {
  const { root, frames, out } = await fixture(t);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "zip"),
    '#!/bin/sh\nprintf partial > "$3"\nexit 17\n',
    { mode: 0o700 },
  );
  const before = (await readdir(root)).sort();
  const result = run(script, frames, out, {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /code 17/);
  assert.equal(await readFile(out, "utf8"), "previous archive");
  assert.deepEqual((await readdir(root)).sort(), before);
});

test("packing rejects escaping or linked inputs before replacing output", async (t) => {
  const { root, frames, out } = await fixture(t);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.png"), "outside content");
  for (const part of ["../outside", outside, "part0/../part0"]) {
    await writeFile(
      path.join(frames, "desc.txt"),
      `100 100 30\np 1 0 ${part}\n`,
    );
    assert.notEqual(run(script, frames, out).status, 0, part);
    assert.equal(await readFile(out, "utf8"), "previous archive");
  }
  await writeFile(path.join(frames, "desc.txt"), "100 100 30\np 1 0 linked\n");
  await symlink(outside, path.join(frames, "linked"));
  assert.notEqual(run(script, frames, out).status, 0);
  await writeFile(path.join(frames, "desc.txt"), "100 100 30\np 1 0 part0\n");
  await symlink(
    path.join(outside, "secret.png"),
    path.join(frames, "part0", "linked.png"),
  );
  assert.notEqual(run(script, frames, out).status, 0);
  assert.equal(await readFile(out, "utf8"), "previous archive");
});

test("packing reads the documented part field and stores frames in name order", async (t) => {
  const { frames, out } = await fixture(t);
  await writeFile(path.join(frames, "part0", "002.png"), "second");
  await writeFile(path.join(frames, "part0", "001.png"), "first");
  await writeFile(
    path.join(frames, "desc.txt"),
    "100 100 30\nc 1 0 part0 #000000\nf 1 0 part0 10\n",
  );
  const result = run(script, frames, out);
  assert.equal(result.status, 0, result.stderr);
  const inspect = spawnSync(
    "python3",
    [
      "-c",
      "import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))",
      out,
    ],
    { encoding: "utf8" },
  );
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.deepEqual(JSON.parse(inspect.stdout), [
    "desc.txt",
    "part0/000.png",
    "part0/001.png",
    "part0/002.png",
  ]);
});

test("output cannot overwrite the descriptor or pollute a frame directory", async (t) => {
  const { frames } = await fixture(t);
  const descriptor = path.join(frames, "desc.txt");
  const original = await readFile(descriptor);
  for (const out of [descriptor, path.join(frames, "part0", "output.zip")]) {
    const result = run(script, frames, out);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not overwrite or reside inside/);
  }
  assert.deepEqual(await readFile(descriptor), original);
  assert.deepEqual(await readdir(path.join(frames, "part0")), ["000.png"]);
});

test("generic and branded packers retain check mode and create store-only archives", async (t) => {
  const { root, frames, out } = await fixture(t);
  for (const entrypoint of [script, branded]) {
    const check = run(entrypoint, frames, out, { args: ["--check"] });
    assert.equal(check.status, 0, check.stderr);
    const packed = run(entrypoint, frames, out);
    assert.equal(packed.status, 0, packed.stderr);
    assert.notDeepEqual(await readFile(out), Buffer.from("previous archive"));
    const inspect = spawnSync(
      "python3",
      [
        "-c",
        "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({x.filename:x.compress_type for x in z.infolist()})); assert z.read('part0/000.png') == b'fixture frame'",
        out,
      ],
      { encoding: "utf8" },
    );
    assert.equal(inspect.status, 0, inspect.stderr);
    assert.deepEqual(JSON.parse(inspect.stdout), {
      "desc.txt": 0,
      "part0/000.png": 0,
    });
    const unchanged = await readFile(out);
    assert.equal(run(entrypoint, frames, out, { args: ["--check"] }).status, 0);
    assert.deepEqual(await readFile(out), unchanged);
  }
  assert.deepEqual((await readdir(root)).sort(), [
    "bootanimation.zip",
    "frames",
  ]);
});
