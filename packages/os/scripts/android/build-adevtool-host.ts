#!/usr/bin/env node
/** Build only the Linux executables used by the pinned Pixel extraction tool. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { withSisoCompatibility } from "./siso-env.ts";

const { values } = parseArgs({
  options: {
    "aosp-root": { type: "string" },
    jobs: { type: "string", default: "2" },
  },
});
if (!values["aosp-root"] || !/^[1-9][0-9]*$/.test(values.jobs)) {
  throw new Error("Use --aosp-root DIRECTORY [--jobs POSITIVE_INTEGER]");
}
const root = path.resolve(values["aosp-root"]);
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("Pixel extraction host tools require Linux x86_64");
}
if (!fs.existsSync(path.join(root, "build/envsetup.sh"))) {
  throw new Error("A complete, pinned AOSP checkout is required");
}
const result = spawnSync(
  "bash",
  [
    "-c",
    `set -eo pipefail
export OUT_DIR=out_adevtool_deps ANDROID_QUIET_BUILD=true
source build/envsetup.sh
lunch sdk_phone64_x86_64
tools=(aapt2 apksigner aprotoc arsclib debugfs dispol fsck.erofs lpdump lpunpack lz4 ota_extractor simg2img sqlite3 toybox)
targets=()
for name in "\${tools[@]}"; do targets+=("$OUT_DIR/host/linux-x86/bin/$name"); done
# Module names also build Windows/device variants; output paths select Linux only.
m -j"$1" "\${targets[@]}"
for target in "\${targets[@]}"; do test -f "$target"; done
git -C vendor/adevtool rev-parse HEAD > "$OUT_DIR/adevtool_revision"
`,
    "build-adevtool-host",
    values.jobs,
  ],
  { cwd: root, env: withSisoCompatibility(), stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) throw new Error(`Host build terminated by ${result.signal}`);
process.exitCode = result.status ?? 1;
