import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

test("RISC-V builds and requires the current fused inference runtime", () => {
  const builder = read("scripts/build-riscv64-artifacts.sh");
  const checker = read("scripts/check-riscv64-artifacts.sh");
  assert.match(builder, /--target android-riscv64-cpu-fused/);
  assert.match(builder, /if should_build "\$fused_sentinel"; then/);
  assert.match(
    builder,
    /fused_sentinel="\$libllama_assets_dir\/riscv64\/libelizainference.so"/,
  );
  assert.match(checker, /^ {4}libelizainference\.so$/m);
  assert.match(checker, /^ {4}libllama\.so$/m);
  assert.doesNotMatch(checker, /libeliza-llama-shim\.so/);
});

test("RISC-V builder and checker require the same maintained native plugins", () => {
  const builder = read("scripts/build-riscv64-artifacts.sh");
  const checker = read("scripts/check-riscv64-artifacts.sh");
  const expected = [
    "doctr-cpp",
    "face-cpp",
    "polarquant-cpu",
    "qjl-cpu",
    "silero-vad-cpp",
    "turboquant-cpu",
    "voice-classifier-cpp",
    "wakeword-cpp",
  ];
  const built = [...builder.matchAll(/^build_native_plugin ([\w-]+)/gm)]
    .map((match) => match[1])
    .sort();
  const checked = [
    ...new Set(
      [
        ...checker.matchAll(
          /plugins\/plugin-(?:local-inference|vision)\/native\/([\w-]+)\/build\/riscv64\//g,
        ),
      ].map((match) => match[1]),
    ),
  ].sort();
  assert.deepEqual(built, expected);
  assert.deepEqual(checked, expected);
  assert.doesNotMatch(builder + checker, /yolo-cpp|libyolo/);
  assert.match(
    builder,
    /CMakeLists\.txt" \]; then[\s\S]*?FAIL_N=\$\(\(FAIL_N\+1\)\)/,
  );
});

test("RISC-V builder handles CLI requests before resolving source or starting tools", () => {
  const script = fileURLToPath(
    new URL("scripts/build-riscv64-artifacts.sh", root),
  );
  const run = (args, env = {}) =>
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        JOBS: "1",
        ELIZA_RISCV64_SMOKE: "0",
        ELIZAOS_ELIZA_ROOT: "/nonexistent-eliza-source",
        NODE_BIN: "/nonexistent-node",
        ...env,
      },
    });
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);
  const disabled = run([]);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /nothing to do/);
  for (const args of [
    ["--jobs"],
    ["--jobs", "--force"],
    ["--jobs", "0"],
    ["--jobs", "-1"],
    ["--jobs", "1.5"],
    ["--jobs", "1;echo injected"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /--jobs requires a positive integer/);
    assert.doesNotMatch(result.stderr, /unbound variable/);
  }
  const invalidEnv = run([], { JOBS: "garbage" });
  assert.equal(invalidEnv.status, 2);
  assert.match(invalidEnv.stderr, /JOBS must be a positive integer/);
});

test("RISC-V imported builders use the explicitly selected Zig executable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "riscv-zig-selection-"));
  try {
    const scripts = path.join(directory, "os/scripts");
    const source = path.join(directory, "source");
    const bin = path.join(directory, "bin");
    for (const folder of [
      scripts,
      bin,
      path.join(source, "plugins/plugin-local-inference/native"),
      path.join(source, "packages/app/scripts/aosp"),
    ])
      await mkdir(folder, { recursive: true });
    const script = path.join(scripts, "build-riscv64-artifacts.sh");
    await writeFile(script, read("scripts/build-riscv64-artifacts.sh"));
    for (const name of ["compile-libllama.ts", "compile-shim.ts"])
      await writeFile(
        path.join(source, "packages/app/scripts/aosp", name),
        "fixture",
      );
    const selected = path.join(directory, "selected zig");
    await writeFile(
      selected,
      '#!/bin/sh\necho selected >> "$ZIG_LOG"\necho 0.13.0\n',
      { mode: 0o700 },
    );
    await writeFile(
      path.join(bin, "zig"),
      '#!/bin/sh\necho wrong >> "$ZIG_LOG"\nexit 99\n',
      { mode: 0o700 },
    );
    await writeFile(
      path.join(bin, "cmake"),
      '#!/bin/sh\necho "cmake version fixture"\n',
      { mode: 0o700 },
    );
    const node = path.join(bin, "node");
    await writeFile(
      node,
      '#!/bin/sh\ncase "$1" in --version) echo v24.15.0;; *eliza-source.ts) printf "%s\\n" "$FIXTURE_SOURCE";; *) zig version;; esac\n',
      { mode: 0o700 },
    );
    const log = path.join(directory, "zig.log");
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NODE_BIN: node,
        ZIG_BIN: selected,
        FIXTURE_SOURCE: source,
        ZIG_LOG: log,
        ELIZA_RISCV64_SMOKE: "1",
        JOBS: "1",
        HOME: directory,
      },
    });
    // No plugin sources or output artifacts exist: this fixture must fail its
    // build checks, while each imported compiler invocation uses selected Zig.
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "selected",
      "selected",
      "selected",
      "selected",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("RISC-V checker validates arguments and writes escaped reports", async () => {
  const script = fileURLToPath(
    new URL("scripts/check-riscv64-artifacts.sh", root),
  );
  const directory = await mkdtemp(path.join(tmpdir(), 'riscv-report-"-'));
  try {
    const output = path.join(directory, 'report".json');
    const run = (args, env = {}) =>
      spawnSync("bash", [script, ...args], {
        encoding: "utf8",
        env: {
          ...process.env,
          ELIZAOS_ELIZA_ROOT: fileURLToPath(new URL("../../", root)),
          ELIZA_RISCV64_SMOKE: 'disabled"\nvalue',
          ELIZA_RISCV64_QEMU_TIMEOUT: "60",
          ...env,
        },
      });
    const help = run(["--help"], { ELIZAOS_ELIZA_ROOT: "/missing" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage:/);
    for (const args of [
      ["--out"],
      ["--out", "--no-qemu"],
      ["--timeout"],
      ["--timeout", "0"],
      ["--timeout", "1.5"],
    ]) {
      const invalid = run(args, { ELIZAOS_ELIZA_ROOT: "/missing" });
      assert.equal(invalid.status, 2);
      assert.match(invalid.stderr, /requires/);
    }
    const result = run(["--out", output]);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.final_status, "SKIP");
    assert.equal(report.eliza_riscv64_smoke, 'disabled"\nvalue');
    assert.equal(report.qemu_timeout_seconds, 60);
    const strict = run(["--out", output, "--require-complete", "--no-qemu"]);
    assert.equal(strict.status, 1, strict.stderr);
    assert.equal(
      JSON.parse(await readFile(output, "utf8")).final_status,
      "FAIL",
    );
    assert.deepEqual(await readdir(directory), ['report".json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("RISC-V build verifier validates CLI before source setup", () => {
  const script = fileURLToPath(
    new URL("scripts/verify-riscv64-buildpaths.sh", root),
  );
  const run = (args, env = {}) =>
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        JOBS: "1",
        ELIZAOS_ELIZA_ROOT: "/nonexistent-eliza-source",
        ...env,
      },
    });
  const help = run(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:/);
  for (const args of [
    ["--jobs"],
    ["--jobs", "0"],
    ["--jobs", "--keep-build"],
    ["--jobs", "1.5"],
    ["--out"],
    ["--out", ""],
    ["--out", "--keep-build"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /requires/);
    assert.doesNotMatch(
      result.stderr,
      /eliza checkout|source root|not a valid/,
    );
  }
  const invalidEnvironment = run([], { JOBS: "-1" });
  assert.equal(invalidEnvironment.status, 2);
  assert.match(invalidEnvironment.stderr, /JOBS must be a positive integer/);
});
