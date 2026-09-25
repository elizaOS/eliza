import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../linux/boot-qemu.sh", import.meta.url));

test("RISC-V launcher discovers firmware installed by the Debian builder", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "boot-riscv-firmware-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const firmware = join(dir, "usr/share/qemu-efi-riscv64");
  const scripts = join(dir, "scripts/linux");
  await mkdir(firmware, { recursive: true });
  await mkdir(scripts, { recursive: true });
  await mkdir(join(dir, "linux/elizaos"), { recursive: true });
  for (const name of ["RISCV_VIRT_CODE.fd", "RISCV_VIRT_VARS.fd"])
    await writeFile(join(firmware, name), "fixture firmware");
  const image = join(dir, "image.iso");
  await writeFile(image, "fixture ISO");
  const relocated = join(scripts, "boot-qemu.sh");
  await writeFile(
    relocated,
    (await readFile(script, "utf8")).replaceAll(
      "/usr/share/",
      `${dir}/usr/share/`,
    ),
  );
  await writeFile(
    join(dir, "qemu-system-riscv64"),
    '#!/bin/sh\nprintf "%s\\n" "$@"\n',
    { mode: 0o700 },
  );
  const result = spawnSync(
    "bash",
    [relocated, "--arch", "riscv64", "--firmware", "uefi", image],
    {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        ELIZAOS_RISCV_CODE: "",
        ELIZAOS_RISCV_VARS: "",
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    result.stdout.includes(
      `if=pflash,format=raw,readonly=on,file=${firmware}/RISCV_VIRT_CODE.fd`,
    ),
  );
});

test("QEMU launcher validates options and preserves drive boundaries on each architecture", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "boot-qemu-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const image = join(dir, "image with spaces.iso");
  const firmware = join(dir, "firmware.fd");
  const capture = join(dir, "arguments.json");
  await writeFile(image, "fixture ISO");
  await writeFile(firmware, "fixture firmware");
  for (const target of ["x86_64", "aarch64", "riscv64"]) {
    await writeFile(
      join(dir, `qemu-system-${target}`),
      `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.QEMU_CAPTURE, JSON.stringify(process.argv.slice(2)));\n`,
      { mode: 0o700 },
    );
  }
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    QEMU_CAPTURE: capture,
    ELIZAOS_ARCH: "amd64",
    ELIZAOS_QEMU_FIRMWARE: "bios",
    ELIZAOS_QEMU_MEMORY: "2048",
    ELIZAOS_QEMU_CPUS: "2",
    ELIZAOS_QEMU_SSH_PORT: "2224",
  };
  for (const prefix of ["OVMF", "AAVMF", "RISCV"]) {
    env[`ELIZAOS_${prefix}_CODE`] = firmware;
    env[`ELIZAOS_${prefix}_VARS`] = firmware;
  }
  const run = (args, overrides = {}) =>
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      timeout: 5000,
      env: { ...env, ...overrides },
    });
  for (const arch of ["amd64", "arm64", "riscv64"]) {
    const result = run(["--arch", arch, "--firmware", "uefi", image]);
    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(await readFile(capture, "utf8"));
    assert.ok(
      args.includes(`file=${image},format=raw,media=cdrom,readonly=on`),
    );
    assert.ok(args.includes("user,id=net0,hostfwd=tcp:127.0.0.1:2224-:22"));
    assert.ok(
      args.includes(`if=pflash,format=raw,readonly=on,file=${firmware}`),
    );
  }
  await rm(capture);
  const unsafeImage = join(dir, "image,format=qcow2.iso");
  await writeFile(unsafeImage, "fixture");
  for (const args of [
    [unsafeImage],
    ["--cpus", "2,sockets=8", image],
    ["--memory", "0", image],
    ["--ssh-port", "65536", image],
    ["--ssh-port", "22,hostfwd=tcp::99-:99", image],
    ["--arch", "arm64", "--firmware", "bios", image],
    ["--arch", "invalid", image],
  ]) {
    const result = run(args);
    assert.equal(result.status, 64, result.stderr);
    await assert.rejects(readFile(capture), { code: "ENOENT" });
  }
  const invalidFirmware = run(["--firmware", "uefi", image], {
    ELIZAOS_OVMF_CODE: unsafeImage,
  });
  assert.equal(invalidFirmware.status, 64, invalidFirmware.stderr);
  await assert.rejects(readFile(capture), { code: "ENOENT" });
});
