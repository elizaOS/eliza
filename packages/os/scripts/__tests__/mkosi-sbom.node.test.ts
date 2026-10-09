import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../linux/generate-mkosi-sbom.sh", import.meta.url),
);

test("SBOM publication rejects failed scans and invalid output without overwriting releases", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "mkosi-sbom-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, "bin");
  await mkdir(bin);
  const executable = (name, body) =>
    writeFile(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o700 });
  await executable("id", "echo 0");
  await executable(
    "losetup",
    'if [[ "$1" == --detach ]]; then exit "$DETACH_STATUS"; fi; echo /dev/fixture-loop',
  );
  await executable(
    "lsblk",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    'echo "/dev/fixture-root elizaos-system"; exit "${SCAN_STATUS:-0}"',
  );
  await executable("umount", 'exit "$UNMOUNT_STATUS"');
  for (const name of ["mount", "udevadm"]) await executable(name, "exit 0");
  await executable(
    "syft",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
    'printf "%s" "$SBOM_JSON" > "${3#spdx-json=}"; if [[ -n "$RACE_OUTPUT" ]]; then printf "concurrent release" > "$RACE_OUTPUT"; fi; exit "${SYFT_STATUS:-0}"',
  );
  // Mock only the fixture block-device check; no real mount or device is used.
  const environment = join(directory, "bash-env");
  await writeFile(
    environment,
    '[() { if [[ "$1" == ! && "$2" == -b && "$3" == /dev/fixture-root ]]; then return 1; fi; builtin [ "$@"; }\n',
  );
  const image = join(directory, "image.raw");
  const output = join(directory, "release.spdx.json");
  await writeFile(image, "fixture");
  const run = (extra = {}) =>
    spawnSync("bash", [script, image, output, join(bin, "syft")], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        BASH_ENV: environment,
        SCAN_STATUS: "0",
        SYFT_STATUS: "0",
        RACE_OUTPUT: "",
        UNMOUNT_STATUS: "0",
        DETACH_STATUS: "0",
        SBOM_JSON: JSON.stringify({
          spdxVersion: "SPDX-2.3",
          packages: [{ name: "fixture" }],
        }),
        ...extra,
      },
    });
  for (const extra of [
    { SCAN_STATUS: "17" },
    { UNMOUNT_STATUS: "18" },
    { DETACH_STATUS: "20" },
    { SBOM_JSON: "invalid" },
    { SYFT_STATUS: "19" },
    { SBOM_JSON: '{"spdxVersion":"SPDX-2.3","packages":[]}' },
  ]) {
    const result = run(extra);
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0, result.stderr);
    if (extra.SCAN_STATUS) assert.equal(result.status, 17, result.stderr);
    assert.equal(
      (await readdir(directory)).includes("release.spdx.json"),
      false,
    );
    assert.equal(
      (await readdir(directory)).some((name) =>
        name.startsWith(".elizaos-sbom."),
      ),
      false,
    );
  }
  const race = run({ RACE_OUTPUT: output });
  assert.notEqual(race.status, 0);
  assert.equal(await readFile(output, "utf8"), "concurrent release");
  await rm(output);
  const success = run();
  assert.equal(success.status, 0, success.stderr);
  const original = await readFile(output, "utf8");
  assert.equal(JSON.parse(original).packages[0].name, "fixture");
  const repeat = run();
  assert.notEqual(repeat.status, 0);
  assert.match(repeat.stderr, /output already exists/);
  assert.equal(await readFile(output, "utf8"), original);
});
