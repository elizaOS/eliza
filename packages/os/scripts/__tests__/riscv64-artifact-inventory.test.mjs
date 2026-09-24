import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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
  assert.match(checker, /^    libelizainference\.so$/m);
  assert.match(checker, /^    libllama\.so$/m);
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
          /packages\/native\/plugins\/([\w-]+)\/build\/riscv64\//g,
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
