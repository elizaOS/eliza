// Invoked only inside the named disposable QEMU qualification VM.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { writeCanonicalRawImageToLinuxDevice } from "../src/backend/linux-backend";
import {
  createArtifactSignaturePayload,
  type RawImageWriteReceipt,
  writeVerifiedRawImage,
} from "../src/backend/raw-image-pipeline";
import type { ElizaOsImage, RemovableDrive } from "../src/backend/types";

assert.equal(process.geteuid?.(), 0);
assert.equal(
  readFileSync("/sys/class/dmi/id/sys_vendor", "utf8").trim(),
  "QEMU",
);
const names = readdirSync("/sys/class/block").filter((name) => {
  try {
    return (
      readFileSync(`/sys/class/block/${name}/serial`, "utf8").trim() ===
      "ELIZAOS-RAW-QUALIFY"
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
});
assert.equal(names.length, 1);
const name = names[0];
const attribute = (key: string) =>
  readFileSync(`/sys/class/block/${name}/${key}`, "utf8").trim();
const drive: RemovableDrive = {
  id: String(name),
  name: "Disposable QEMU fixture",
  devicePath: `/dev/${name}`,
  sizeBytes: Number(attribute("size")) * 512,
  bus: "virtual",
  platform: "linux",
  safety: "safe-removable",
  stableId: "vm:ELIZAOS-RAW-QUALIFY",
  kernelDeviceIdentity: `${attribute("dev")}:${attribute("diskseq")}:${attribute("queue/logical_block_size")}`,
};
assert.equal(drive.sizeBytes, 128 * 1024 ** 2);
const expanded = Buffer.alloc(
  8 * 1024 ** 2,
  "elizaOS retained device pipeline\0",
);
const compressed = zstdCompressSync(expanded);
const hash = (data: Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const image: ElizaOsImage = {
  id: "vm-fixture",
  label: "VM fixture",
  version: "0.0.0",
  channel: "nightly",
  architecture: "x86_64",
  buildId: "vm-test",
  publishedAt: "2026-09-23T00:00:00.000Z",
  url: "https://example.test/image.raw.zst",
  signatureUrl: "https://example.test/image.raw.zst.sig",
  checksumSha256: hash(compressed),
  sizeBytes: compressed.length,
  minUsbSizeBytes: expanded.length,
  manifestVersion: 1,
  schemaVersion: 1,
  product: "elizaOS",
  sequence: 1,
  compressedSize: compressed.length,
  expandedSize: expanded.length,
  sha256Compressed: hash(compressed),
  sha256Expanded: hash(expanded),
  minDeviceBytes: expanded.length,
  format: "raw.zst",
};
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const signature = sign(null, createArtifactSignaturePayload(image), privateKey);
const children: ReturnType<typeof spawn>[] = [];
const start: typeof spawn = ((
  command: string,
  args: string[],
  options: object,
) => {
  const child = spawn(command, args, options);
  children.push(child);
  return child;
}) as typeof spawn;
let receipt: RawImageWriteReceipt | undefined;
await writeCanonicalRawImageToLinuxDevice(
  image,
  drive,
  { command: "/usr/bin/env", argsPrefix: [] },
  (command, args, options) => start(command, [...args], options ?? {}),
  () => {},
  async (source, target, options) => {
    receipt = await writeVerifiedRawImage(source, target, {
      ...options,
      publicKey,
      fetcher: async (input) =>
        new Response(String(input).endsWith(".sig") ? signature : compressed),
    });
    return receipt;
  },
  {},
  "/usr/libexec/elizaos-linux-raw-writer",
);
assert.equal(
  children.length,
  1,
  "write and readback must use one privileged process",
);
assert.equal(children[0]?.exitCode, 0);
assert.equal(receipt?.sha256Readback, hash(expanded));
for (const phase of ["write", "verify"] as const) {
  const controller = new AbortController();
  const before: number = children.length;
  await assert.rejects(
    writeCanonicalRawImageToLinuxDevice(
      image,
      drive,
      { command: "/usr/bin/env", argsPrefix: [] },
      (command, args, options) => start(command, [...args], options ?? {}),
      (step, progress) => {
        if (step === phase && progress > 0.1) controller.abort();
      },
      (source, target, options) =>
        writeVerifiedRawImage(source, target, {
          ...options,
          publicKey,
          fetcher: async (input) =>
            new Response(
              String(input).endsWith(".sig") ? signature : compressed,
            ),
        }),
      { signal: controller.signal },
      "/usr/libexec/elizaos-linux-raw-writer",
    ),
    { name: "WriteCancelledError" },
  );
  assert.equal(children.length, before + 1);
  const child = children.at(-1);
  assert.ok(
    child && (child.exitCode !== null || child.signalCode !== null),
    "cancel returned before privileged writer exited",
  );
}
writeFileSync(
  "/evidence/pipeline.json",
  JSON.stringify(
    {
      success: true,
      successfulWriteChildCount: 1,
      totalChildCount: children.length,
      cancellationPhases: ["write", "verify"],
      receipt,
    },
    null,
    2,
  ),
);
