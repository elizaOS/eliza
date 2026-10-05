import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const verifier = fileURLToPath(
  new URL("../verify-riscv64-elf.sh", import.meta.url),
);
function elf(machine = 243, flags = 4, type = 1) {
  const bytes = Buffer.alloc(64);
  bytes.set([0x7f, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(type, 16);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeUInt32LE(1, 20);
  bytes.writeUInt32LE(flags, 48);
  bytes.writeUInt16LE(64, 52);
  return bytes;
}
function archive(members) {
  return Buffer.concat([
    Buffer.from("!<arch>\n"),
    ...members.flatMap(([name, bytes]) => {
      const header = `${`${name}/`.padEnd(16)}${"0".padEnd(12)}${"0".padEnd(6)}${"0".padEnd(6)}${"100644".padEnd(8)}${String(bytes.length).padEnd(10)}\x60\n`;
      return [Buffer.from(header), bytes, Buffer.alloc(bytes.length % 2, 10)];
    }),
  ]);
}
test("RISC-V ELF checks inspect every archive member without extraction", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "riscv-elf-"));
  try {
    const inputs = [
      ["valid.o", elf(), true],
      ["valid.so", elf(243, 4, 3), true],
      ["renamed-object.so", elf(), false],
      ["renamed-executable.so.1", elf(243, 4, 2), false],
      ["renamed-archive.so", archive([["member.o", elf(243, 4, 3)]]), false],
      ["host.o", elf(62), false],
      ["soft.o", elf(243, 0), false],
      ["empty.a", archive([]), false],
      [
        "valid.a",
        archive([
          ["first.o", elf()],
          ["second.bin", elf()],
        ]),
        true,
      ],
      [
        "mixed.a",
        archive([
          ["first.o", elf()],
          ["second.bin", elf(62)],
        ]),
        false,
      ],
      [
        "text.a",
        archive([
          ["first.o", elf()],
          ["second.bin", Buffer.from("invalid")],
        ]),
        false,
      ],
      [
        "duplicate.a",
        archive([
          ["same.o", elf(62)],
          ["same.o", elf()],
        ]),
        false,
      ],
      ["truncated.o", elf().subarray(0, 30), false],
    ];
    for (const [name, bytes, valid] of inputs) {
      const file = path.join(directory, name);
      await writeFile(file, bytes);
      const result = spawnSync("bash", [verifier, file], { encoding: "utf8" });
      assert.equal(result.status === 0, valid, `${name}: ${result.stderr}`);
    }
    assert.deepEqual(
      (await readdir(directory)).sort(),
      inputs.map(([name]) => name).sort(),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
