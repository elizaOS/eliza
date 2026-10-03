import { spawnSync } from "node:child_process";
import { createHash, createPublicKey, type KeyObject, sign } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import {
  loadPinnedEd25519PublicKey,
  publicKeyFingerprint,
} from "../../../usb-installer/src/backend/ed25519-trust";
import { type FactoryBootLayout, factoryBootPayloadPaths } from "./boot-config";
import { verifyFactoryManifest } from "./factory-manifest";

export interface FactoryManifestProductionOptions {
  imagePath: string;
  outputDirectory: string;
  logicalSectorBytes: 512 | 4096;
  version: string;
  sequence: number;
  expires: string;
  boot: FactoryBootLayout;
  privateKey: KeyObject;
  publicKey?: KeyObject;
  signal?: AbortSignal;
}

export class FactoryManifestProductionError extends Error {
  readonly code = "ELIZAOS_FACTORY_MANIFEST_PRODUCTION_ERROR";
}

/** libfdisk may return success after falling back to one damaged GPT copy.
 * Reject its diagnostics as well as command failures; never silently repair. */
function imageTool(
  file: FileHandle,
  command: "sfdisk" | "blkid" | "mcopy" | "mtype",
  args: string[],
): string {
  const result = spawnSync(command, args, {
    env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LC_ALL: "C" },
    stdio: ["ignore", command === "mcopy" ? "ignore" : "pipe", "pipe", file.fd],
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  if (
    result.error ||
    result.status !== 0 ||
    (command === "sfdisk" && result.stderr.length !== 0)
  ) {
    throw new FactoryManifestProductionError(
      `Factory image inspection failed: ${result.stderr || result.error?.message || result.signal || result.status}`,
      { cause: result.error },
    );
  }
  return result.stdout ?? "";
}

interface Partition {
  name: string;
  type: string;
  start: number;
  size: number;
}

function selectedPartition(
  table: unknown,
  name: string,
  type: string,
  sector: number,
  imageBytes: number,
) {
  if (!table || typeof table !== "object" || !("partitiontable" in table))
    throw new FactoryManifestProductionError("Missing GPT inspection result.");
  const value = table.partitiontable as {
    label?: unknown;
    sectorsize?: unknown;
    partitions?: unknown;
  };
  if (
    value.label !== "gpt" ||
    value.sectorsize !== sector ||
    !Array.isArray(value.partitions)
  )
    throw new FactoryManifestProductionError(
      "Factory image is not the expected GPT layout.",
    );
  const matches = value.partitions.filter((part) => part?.name === name);
  if (matches.length !== 1)
    throw new FactoryManifestProductionError(
      `Factory image must contain exactly one ${name} partition.`,
    );
  const part = matches[0] as Partition;
  const offset = part.start * sector;
  const sizeBytes = part.size * sector;
  if (
    typeof part.type !== "string" ||
    part.type.toLowerCase() !== type ||
    !Number.isSafeInteger(part.start) ||
    !Number.isSafeInteger(part.size) ||
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(sizeBytes) ||
    offset <= 0 ||
    sizeBytes <= 0 ||
    offset > imageBytes - sizeBytes
  )
    throw new FactoryManifestProductionError(
      `Invalid factory ${name} extent or GPT type.`,
    );
  return { offset, sizeBytes, hash: createHash("sha256") };
}

/** Produce sidecars from a completed regular disk image. Does not edit the
 * image, publish a release, or establish boot qualification. The release
 * assembler must place the metadata outside the hashed ESP/recovery payloads. */
async function produce(options: FactoryManifestProductionOptions) {
  const {
    privateKey,
    publicKey = loadPinnedEd25519PublicKey(),
    signal,
  } = options;
  const config = structuredClone({
    imagePath: options.imagePath,
    outputDirectory: options.outputDirectory,
    logicalSectorBytes: options.logicalSectorBytes,
    version: options.version,
    sequence: options.sequence,
    expires: options.expires,
    boot: options.boot,
  });
  signal?.throwIfAborted();
  if (
    process.platform !== "linux" ||
    ![512, 4096].includes(config.logicalSectorBytes) ||
    privateKey.type !== "private" ||
    privateKey.asymmetricKeyType !== "ed25519" ||
    publicKeyFingerprint(createPublicKey(privateKey)) !==
      publicKeyFingerprint(publicKey)
  ) {
    throw new FactoryManifestProductionError(
      "Factory metadata production requires Linux, supported sectors, and the pinned Ed25519 signing key.",
    );
  }
  const imagePath = resolve(config.imagePath);
  const outputDirectory = resolve(config.outputDirectory);
  const handles: FileHandle[] = [];
  const errors: unknown[] = [];
  let receipt:
    | {
        outputDirectory: string;
        imageSha256: string;
        manifestSha256: string;
        releaseKeyFingerprint: string;
      }
    | undefined;
  try {
    const file = await open(
      imagePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    handles.push(file);
    const initial = await file.stat({ bigint: true });
    const imageBytes = Number(initial.size);
    if (
      !initial.isFile() ||
      initial.nlink !== 1n ||
      (initial.mode & 0o022n) !== 0n ||
      !Number.isSafeInteger(imageBytes) ||
      imageBytes < 64 * 1024 ** 2 ||
      imageBytes % config.logicalSectorBytes !== 0
    ) {
      throw new FactoryManifestProductionError(
        "Factory source must be a stable regular disk image with restricted write permissions.",
      );
    }
    const diskTool = (operation: "--verify" | "--json") =>
      imageTool(file, "sfdisk", [
        operation,
        "--sector-size",
        String(config.logicalSectorBytes),
        "/proc/self/fd/3",
      ]);
    diskTool("--verify");
    const table: unknown = JSON.parse(diskTool("--json"));
    const esp = selectedPartition(
      table,
      "elizaos-esp",
      "c12a7328-f81f-11d2-ba4b-00a0c93ec93b",
      config.logicalSectorBytes,
      imageBytes,
    );
    const recovery = selectedPartition(
      table,
      "elizaos-recovery",
      "0fc63daf-8483-4772-8e79-3d69d8477de4",
      config.logicalSectorBytes,
      imageBytes,
    );
    for (const [part, type] of [
      [esp, "vfat"],
      [recovery, "ext4"],
    ] as const) {
      const actual = imageTool(file, "blkid", [
        "-p",
        "-O",
        String(part.offset),
        "-S",
        String(part.sizeBytes),
        "-s",
        "TYPE",
        "-o",
        "value",
        "/proc/self/fd/3",
      ]);
      if (actual.trim() !== type)
        throw new FactoryManifestProductionError(
          `Factory partition must contain ${type}.`,
        );
    }
    const espImage = `/proc/self/fd/3@@${esp.offset}`;
    for (const path of factoryBootPayloadPaths(config.boot)) {
      imageTool(file, "mcopy", ["-i", espImage, `::${path}`, "-"]);
    }
    if (
      imageTool(file, "mtype", [
        "-i",
        espImage,
        "::/EFI/debian/grub.cfg",
      ]).trim() !== "configfile /grub/grub.cfg"
    ) {
      throw new FactoryManifestProductionError(
        "Factory EFI loader does not use the supported external GRUB menu.",
      );
    }
    const hash = createHash("sha256");
    const bytes = Buffer.alloc(4 * 1024 * 1024);
    for (let offset = 0; offset < imageBytes; ) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        bytes,
        0,
        Math.min(bytes.length, imageBytes - offset),
        offset,
      );
      if (!bytesRead)
        throw new FactoryManifestProductionError(
          "Factory disk image ended before its declared size.",
        );
      hash.update(bytes.subarray(0, bytesRead));
      for (const part of [esp, recovery]) {
        const start = Math.max(offset, part.offset);
        const end = Math.min(offset + bytesRead, part.offset + part.sizeBytes);
        if (start < end)
          part.hash.update(bytes.subarray(start - offset, end - offset));
      }
      offset += bytesRead;
    }
    const current = await file.stat({ bigint: true });
    const named = await lstat(imagePath, { bigint: true });
    if (
      current.size !== initial.size ||
      current.mode !== initial.mode ||
      current.nlink !== initial.nlink ||
      current.mtimeNs !== initial.mtimeNs ||
      current.ctimeNs !== initial.ctimeNs ||
      named.dev !== initial.dev ||
      named.ino !== initial.ino
    )
      throw new FactoryManifestProductionError(
        "Factory disk image changed during inspection.",
      );
    const { architecture, ...boot } = config.boot;
    const manifest = {
      schemaVersion: 1,
      product: "elizaOS",
      architecture,
      version: config.version,
      sequence: config.sequence,
      expires: config.expires,
      recovery: {
        sha256: recovery.hash.digest("hex"),
        sizeBytes: recovery.sizeBytes,
      },
      esp: { sha256: esp.hash.digest("hex"), sizeBytes: esp.sizeBytes },
      boot,
    };
    const encoded = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
    const signature = sign(null, encoded, privateKey);
    const verified = verifyFactoryManifest(encoded, signature, {
      architecture,
      minimumSequence: config.sequence,
      publicKey,
    });
    signal?.throwIfAborted();
    await mkdir(outputDirectory, { mode: 0o700 });
    const directory = await open(
      outputDirectory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    handles.push(directory);
    const directoryIdentity = await directory.stat({ bigint: true });
    for (const [name, data] of [
      ["factory-manifest.json", encoded],
      ["factory-manifest.json.sig", signature],
    ] as const) {
      const output = await open(
        `/proc/self/fd/${directory.fd}/${name}`,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      handles.push(output);
      await output.writeFile(data);
      await output.sync();
    }
    await directory.sync();
    const namedDirectory = await lstat(outputDirectory, { bigint: true });
    if (
      namedDirectory.dev !== directoryIdentity.dev ||
      namedDirectory.ino !== directoryIdentity.ino
    )
      throw new FactoryManifestProductionError(
        "Factory output directory changed during publication.",
      );
    receipt = {
      outputDirectory,
      imageSha256: hash.digest("hex"),
      manifestSha256: verified.sha256,
      releaseKeyFingerprint: verified.releaseKeyFingerprint,
    };
  } catch (error) {
    errors.push(error);
  }
  for (const handle of handles.reverse()) {
    try {
      await handle.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length || !receipt)
    throw new FactoryManifestProductionError(
      "Factory metadata production failed; retain any partial output directory.",
      { cause: new AggregateError(errors) },
    );
  return receipt;
}

export async function produceFactoryManifest(
  options: FactoryManifestProductionOptions,
) {
  try {
    return await produce(options);
  } catch (error) {
    if (error instanceof FactoryManifestProductionError) throw error;
    throw new FactoryManifestProductionError(
      "Factory metadata production could not start.",
      { cause: error },
    );
  }
}
