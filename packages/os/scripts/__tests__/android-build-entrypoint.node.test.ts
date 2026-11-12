import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const android = fileURLToPath(new URL("../../android", import.meta.url));
test("Android make rejects unsupported targets before build or provisioning", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "android make-"));
  // Make target names cannot contain spaces, so the launcher lives apart from
  // the space-containing directory that exercises recipe quoting.
  const launcherDirectory = await mkdtemp(path.join(tmpdir(), "android-repo-"));
  try {
    await writeFile(
      path.join(directory, "node"),
      '#!/bin/sh\nprintf "NODE_STARTED %s\\n" "$@"\n',
      { mode: 0o700 },
    );
    // A pre-provisioned launcher keeps this test offline: the digest-pinned
    // download in provision-repo.sh is release provisioning, not entrypoint
    // validation, and must not run here.
    const repoLauncher = path.join(launcherDirectory, "repo");
    await writeFile(repoLauncher, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const run = (target, arch) =>
      spawnSync(
        "make",
        [
          "--no-print-directory",
          "-j2",
          "-C",
          android,
          target,
          `ARCH=${arch}`,
          `ELIZAOS_ELIZA_ROOT=${directory}`,
          `AOSP_ROOT=${directory}`,
          `REPO_LAUNCHER=${repoLauncher}`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${directory}:${process.env.PATH}`,
          },
        },
      );
    for (const arch of [
      "",
      "riscv64",
      "x86_64 arm64",
      "%",
      "x86_64;echo injected",
    ]) {
      const result = run("build", arch);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unsupported ARCH/);
      assert.doesNotMatch(result.stdout, /NODE_STARTED/);
    }
    for (const target of ["bootstrap", "build", "sim"]) {
      const result = run(target, "arm64");
      assert.equal(result.status, 0, result.stderr);
      assert.equal(
        result.stdout
          .split("\n")
          .filter((line) => line === `NODE_STARTED ${directory}`).length,
        1,
        target,
      );
      if (target === "bootstrap") {
        assert.ok(
          result.stdout.split("\n").includes(`NODE_STARTED ${repoLauncher}`),
          "bootstrap uses the provisioned repo launcher",
        );
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(launcherDirectory, { recursive: true, force: true });
  }
});
