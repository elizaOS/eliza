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
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../linux/qemu_virt_boot_riscv64.sh", import.meta.url),
);

test("RISC-V boot harness cleans private runtime files and rejects drive option injection", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "riscv-boot-"));
  try {
    const bin = path.join(directory, "bin");
    const temporary = path.join(directory, "temporary");
    await mkdir(bin);
    await mkdir(temporary);
    for (const name of [
      "image.iso",
      "code.fd",
      "vars.fd",
      "image,readonly=off.iso",
    ]) {
      await writeFile(path.join(directory, name), "fixture");
    }
    await writeFile(
      path.join(bin, "isoinfo"),
      `#!/bin/sh
printf '%s\\n' /efi/boot/bootriscv64.efi /boot/grub/grub.cfg /live/vmlinux-test-riscv64 /live/initrd.img-test-riscv64
`,
      { mode: 0o700 },
    );
    await writeFile(
      path.join(bin, "qemu-system-riscv64"),
      `#!/usr/bin/env python3
import os, signal, sys, time
if '-netdev' in sys.argv and 'help' in sys.argv:
    print('user')
    sys.exit(0)
with open(os.environ['MOCK_PID'], 'w') as output:
    output.write(str(os.getpid()))
if os.environ['MOCK_MODE'] == 'interrupted':
    os.kill(os.getppid(), signal.SIGTERM)
if os.environ['MOCK_MODE'] in ('ready', 'failed-after-markers'):
    print('Linux version\\nelizaos-firstboot-ready\\nelizaos-curl-health-ready\\nelizaos-agent-ready', flush=True)
if os.environ['MOCK_MODE'] == 'failed-after-markers':
    sys.exit(23)
time.sleep(60)
`,
      { mode: 0o700 },
    );
    const evidence = path.join(directory, "report.json");
    const pidFile = path.join(directory, "pid");
    const run = (mode, iso = "image.iso") =>
      spawnSync(
        "bash",
        [
          script,
          "--iso",
          path.join(directory, iso),
          "--timeout",
          mode === "timeout" ? "1" : "5",
          "--evidence",
          evidence,
          "--transcript",
          path.join(directory, "transcript.log"),
        ],
        {
          encoding: "utf8",
          timeout: 15000,
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            TMPDIR: temporary,
            ELIZAOS_QEMU_EFI_CODE: path.join(directory, "code.fd"),
            ELIZAOS_QEMU_EFI_VARS: path.join(directory, "vars.fd"),
            MOCK_PID: pidFile,
            MOCK_MODE: mode,
          },
        },
      );
    for (const mode of ["ready", "timeout", "failed-after-markers"]) {
      const result = run(mode);
      assert.equal(result.error, undefined);
      assert.equal(result.status, mode === "ready" ? 0 : 1, result.stderr);
      const report = JSON.parse(await readFile(evidence, "utf8"));
      assert.equal(report.boot_completed, mode === "ready");
      assert.equal(
        report.qemu_exit_code,
        mode === "ready" ? 0 : mode === "timeout" ? 124 : 23,
      );
      assert.deepEqual(await readdir(temporary), []);
      const pid = Number(await readFile(pidFile, "utf8"));
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    }
    await rm(evidence);
    const interrupted = run("interrupted");
    assert.equal(interrupted.status, 143, interrupted.stderr);
    assert.deepEqual(await readdir(temporary), []);
    await assert.rejects(readFile(evidence), { code: "ENOENT" });
    const interruptedPid = Number(await readFile(pidFile, "utf8"));
    assert.throws(() => process.kill(interruptedPid, 0), { code: "ESRCH" });
    await rm(pidFile);
    const invalid = run("ready", "image,readonly=off.iso");
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /drive paths cannot contain commas/);
    await assert.rejects(readFile(pidFile), { code: "ENOENT" });
    assert.deepEqual(await readdir(temporary), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
