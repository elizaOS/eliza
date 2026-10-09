import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("foreign binfmt selects all supported Linux guests and skips native registration", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "foreign-binfmt-"));
  try {
    const proc = path.join(directory, "binfmt");
    const bin = path.join(directory, "bin");
    await mkdir(proc);
    await mkdir(bin);
    await writeFile(
      path.join(bin, "dpkg"),
      '#!/bin/sh\nprintf "%s\\n" "$TEST_HOST_ARCH"\n',
      { mode: 0o700 },
    );
    // Never allow this test to mount or register anything on the host.
    await writeFile(
      path.join(bin, "mount"),
      '#!/bin/sh\necho "unexpected mount" >&2\nexit 99\n',
      { mode: 0o700 },
    );
    const original = await readFile(
      new URL("../linux/ensure-foreign-binfmt.sh", import.meta.url),
      "utf8",
    );
    const script = path.join(directory, "check.sh");
    await writeFile(
      script,
      original
        .replaceAll("/proc/sys/fs/binfmt_misc", proc)
        .replaceAll("/usr/lib/binfmt.d", path.join(directory, "config"))
        .replaceAll(
          "/usr/share/qemu/binfmt.d",
          path.join(directory, "fallback"),
        ),
    );
    const run = (arch, host) =>
      spawnSync("bash", [script], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          ELIZAOS_ARCH: arch,
          TEST_HOST_ARCH: host,
        },
      });
    for (const arch of ["amd64", "arm64", "riscv64"]) {
      const native = run(arch, arch);
      assert.equal(native.status, 0, native.stderr);
    }
    const unsupported = run("ppc64el", "ppc64el");
    assert.equal(unsupported.status, 64);
    assert.match(unsupported.stderr, /unsupported architecture/);
    await writeFile(path.join(proc, "register"), "unchanged");
    await writeFile(path.join(proc, "status"), "enabled\n");
    for (const [arch, handler] of [
      ["amd64", "qemu-x86_64"],
      ["arm64", "qemu-aarch64"],
      ["riscv64", "qemu-riscv64"],
    ]) {
      await writeFile(path.join(proc, handler), "enabled\nflags: POCF\n");
      const result = run(arch, arch === "amd64" ? "arm64" : "amd64");
      assert.equal(result.status, 0, result.stderr);
      await rm(path.join(proc, handler));
    }
    assert.equal(
      await readFile(path.join(proc, "register"), "utf8"),
      "unchanged",
    );
    const missing = run("amd64", "arm64");
    assert.equal(missing.status, 65);
    assert.match(
      missing.stderr,
      /no binfmt registration config for qemu-x86_64/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
