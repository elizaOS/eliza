import assert from "node:assert/strict";
import test from "node:test";
import { chromiumBuildPlan } from "../android/build-chromium-browser.ts";

const gnArgs =
  'target_os = "android"\ntarget_cpu = "arm64"\nis_desktop_android = true\nchrome_public_manifest_package = "ai.elizaos.chromium"\n';
const input = {
  source: "/tmp/chromium",
  build: "/tmp/chromium/out/Owned",
  gnArgs,
  jobs: 4,
};
test("owned browser build uses bounded GN/Ninja commands without signing or installation", () => {
  assert.deepEqual(chromiumBuildPlan(input).commands, [
    ["gn", ["gen", "out/Owned"]],
    ["autoninja", ["-C", "out/Owned", "-j", "4", "chrome_public_apk"]],
  ]);
  for (const invalid of [
    { build: "/tmp/elsewhere" },
    { jobs: 0 },
    { jobs: 1.5 },
    { gnArgs: `${gnArgs}target_os = "linux"\n` },
    {
      gnArgs: gnArgs.replace('"ai.elizaos.chromium"', '"org.chromium.chrome"'),
    },
    {
      gnArgs: gnArgs.replace(
        "is_desktop_android = true",
        "is_desktop_android = false",
      ),
    },
  ])
    assert.throws(() => chromiumBuildPlan({ ...input, ...invalid }));
});
