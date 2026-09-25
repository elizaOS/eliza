import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  parseSubArgs,
  startCuttlefish,
  stopCuttlefish,
  systemImgPath,
} from "../distro-android/sim.mjs";

const brand = {
  productName: "eliza_cf_x86_64",
  aospDeviceTreePaths: [
    "device/google/cuttlefish/vsoc_x86_64_only/phone/aosp_cf.mk",
  ],
};
test("sim rejects shell syntax, escaped output paths and invalid timeout values", () => {
  for (const flag of ["--product", "--variant", "--device-dir"]) {
    for (const value of [
      "$(touch injected)",
      "a;false",
      "a\nb",
      "../outside",
      "..",
    ]) {
      assert.throws(() => parseSubArgs([flag, value], brand), {
        code: "ELIZAOS_SIMULATOR_ERROR",
      });
    }
  }
  for (const value of ["0", "-1", "10ms", "1.5", "NaN", "Infinity"]) {
    assert.throws(
      () => parseSubArgs(["--boot-timeout-ms", value], brand),
      /positive integer/,
    );
  }
  const options = parseSubArgs([], brand);
  assert.equal(options.deviceDir, "vsoc_x86_64_only");
  assert.ok(options.outDir.endsWith("/test-results/os-aosp-sim"));
});

async function fixture(t, modern) {
  const dir = await mkdtemp(join(tmpdir(), "aosp-sim-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "build"));
  await mkdir(join(dir, "bin"));
  await writeFile(
    join(dir, "build/envsetup.sh"),
    'export PATH="$PWD/bin:/usr/bin:/bin"\ncommand() { if [[ "$1" == -v && "$2" == cvd ]]; then [[ -x "$PWD/bin/cvd" ]]; else builtin command "$@"; fi; }\nlunch() { printf "%s\\n" "$1" >> "$PWD/lunch.log"; }\n',
  );
  const tool = async (name, body) => {
    const path = join(dir, "bin", name);
    await writeFile(path, `#!/bin/bash\n${body}\n`);
    await chmod(path, 0o755);
  };
  if (modern)
    await tool("cvd", 'printf "%s\\n" "$*" >> "$PWD/cvd.log"\nexit 17');
  await tool("launch_cvd", 'printf "%s\\n" "$*" >> "$PWD/legacy.log"');
  await tool("stop_cvd", 'printf "stop\\n" >> "$PWD/legacy.log"');
  return { dir, args: parseSubArgs(["--aosp-root", dir], brand) };
}

test("a real modern launcher failure is propagated without stopping or trying another launcher", async (t) => {
  const { dir, args } = await fixture(t, true);
  assert.throws(() => startCuttlefish(args, brand), /failed \(17\)/);
  assert.match(
    await readFile(join(dir, "cvd.log"), "utf8"),
    /^start --daemon --gpu_mode=gfxstream\n$/,
  );
  await assert.rejects(readFile(join(dir, "legacy.log")), { code: "ENOENT" });
  assert.throws(() => stopCuttlefish(args), /failed \(17\)/);
  assert.match(await readFile(join(dir, "cvd.log"), "utf8"), /\nstop\n$/);
  await assert.rejects(readFile(join(dir, "legacy.log")), { code: "ENOENT" });
});

test("legacy launchers are selected only when cvd is unavailable", async (t) => {
  const { dir, args } = await fixture(t, false);
  startCuttlefish(args, brand);
  stopCuttlefish(args);
  assert.equal(
    await readFile(join(dir, "legacy.log"), "utf8"),
    "--daemon --gpu_mode=gfxstream\nstop\n",
  );
});

test("image discovery shares configured AOSP output resolution", () => {
  const args = parseSubArgs(["--aosp-root", "/build/aosp"], brand);
  const image = "target/product/vsoc_x86_64_only/system.img";
  for (const [env, output] of [
    [{}, "/build/aosp/out"],
    [{ OUT_DIR: "custom" }, "/build/aosp/custom"],
    [{ OUT_DIR: "/external/out" }, "/external/out"],
    [{ OUT_DIR_COMMON_BASE: "../outputs" }, "/build/outputs/aosp"],
    [{ OUT_DIR_COMMON_BASE: "/outputs" }, "/outputs/aosp"],
    [
      { OUT_DIR: "chosen", OUT_DIR_COMMON_BASE: "/unused" },
      "/build/aosp/chosen",
    ],
  ])
    assert.equal(systemImgPath(args, env), join(output, image));
  assert.throws(() => systemImgPath(args, { OUT_DIR: "" }), /OUT_DIR must be/);
});

test("launcher and stop command receive the same absolute output used for image discovery", async (t) => {
  const { dir, args } = await fixture(t, false);
  for (const name of ["launch_cvd", "stop_cvd"]) {
    await writeFile(
      join(dir, "bin", name),
      '#!/bin/bash\nprintf "%s\\n" "$OUT_DIR" >> "$PWD/outputs.log"\n',
    );
  }
  const env = { ...process.env, OUT_DIR: "custom-output" };
  startCuttlefish(args, brand, env);
  stopCuttlefish(args, env);
  const expected = join(dir, "custom-output");
  assert.equal(
    await readFile(join(dir, "outputs.log"), "utf8"),
    `${expected}\n${expected}\n`,
  );
  assert.equal(
    systemImgPath(args, env),
    join(expected, "target/product/vsoc_x86_64_only/system.img"),
  );
});
