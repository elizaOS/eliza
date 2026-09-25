import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

test("staged ELF checks reject inspection failures and malformed load alignment", (t) => {
  const root = mkdtempSync(join(tmpdir(), "aosp-elf-alignment-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const library = join(root, "product/system/priv-app/Eliza/lib/libfixture.so");
  mkdirSync(dirname(library), { recursive: true });
  writeFileSync(library, "fixture");
  const readelf = join(
    root,
    "prebuilts/clang/host/linux-x86/llvm-binutils-stable/llvm-readelf",
  );
  mkdirSync(dirname(readelf), { recursive: true });
  const module = new URL(
    "../distro-android/verify-grizzly-artifacts.mjs",
    import.meta.url,
  ).href;
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const {checkElfAlignment}=await import(${JSON.stringify(module)});checkElfAlignment(process.argv[1],process.argv[2]);`,
        root,
        join(root, "product"),
      ],
      { encoding: "utf8", timeout: 5000 },
    );
  assert.notEqual(run().status, 0, "missing readelf must fail");
  for (const [output, status, expected] of [
    ["LOAD 0x0 0x0 0x0 0x100 0x100 R E 0x4000", 0, 0],
    ["LOAD 0x0 0x0 0x0 0x100 0x100 R E 0x1000", 0, 1],
    ["LOAD 0x0 0x0 0x0 0x100 0x100 R E invalid", 0, 1],
    ["LOAD 0x0 0x0 0x0 0x100 0x100 R E 0x5000", 0, 1],
    ["No program headers", 0, 1],
    ["LOAD 0x0 0x0 0x0 0x100 0x100 R E 0x4000", 17, 1],
  ]) {
    writeFileSync(
      readelf,
      `#!/bin/sh\n[ "$1" = -W ] && [ "$2" = -l ] || exit 19\nprintf '%s\\n' '${output}'\nexit ${status}\n`,
    );
    chmodSync(readelf, 0o755);
    const result = run();
    assert.equal(result.error, undefined);
    assert.equal(result.status, expected, result.stderr);
  }
});
