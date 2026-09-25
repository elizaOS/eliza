import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  link,
  lstat,
  open,
  statfs,
  unlink,
} from "node:fs/promises";
import {
  type FactoryManifestPolicy,
  verifyFactoryManifest,
} from "./factory-manifest";
import type { FilesystemImageSource } from "./filesystem-image";
import type { LinuxRecoveryStorage } from "./linux-native-disk";

export interface FactorySourceExtent {
  /** Service-owned read handle to the boot disk, partition, or release image.
   * The caller retains and closes it after staging settles. Never IPC input. */
  file: FileHandle;
  offsetBytes: number;
}

export interface FactorySourceOptions {
  manifest: Uint8Array;
  signature: Uint8Array;
  policy: FactoryManifestPolicy;
  sources: { esp: FactorySourceExtent; recovery: FactorySourceExtent };
  /** Keep the qualified native storage session open during this operation. */
  storage: LinuxRecoveryStorage;
  signal?: AbortSignal;
}

export class FactorySourceError extends Error {
  readonly code = "ELIZAOS_FACTORY_SOURCE_ERROR";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FactorySourceError";
  }
}

/** Authenticate before reading payloads, then publish verified filesystem
 * images in the existing independent staging store. Reads source handles only;
 * does not select devices or establish their physical identity. Exact signed
 * hashes bind the bytes even if source paths or device incarnations change.
 * Failed partial files remain private for explicit cleanup. */
export async function stageFactorySources(options: FactorySourceOptions) {
  const handles: FileHandle[] = [];
  const errors: unknown[] = [];
  let receipt:
    | Readonly<
        ReturnType<typeof verifyFactoryManifest> & {
          sources: Readonly<
            Record<"esp" | "recovery", Readonly<FilesystemImageSource>>
          >;
        }
      >
    | undefined;
  try {
    const verified = verifyFactoryManifest(
      options.manifest,
      options.signature,
      options.policy,
    );
    const signal = options.signal;
    const storage = structuredClone(options.storage);
    const sources = {
      esp: { ...options.sources.esp },
      recovery: { ...options.sources.recovery },
    };
    signal?.throwIfAborted();
    if (
      process.platform !== "linux" ||
      process.geteuid?.() !== 0 ||
      !storage.disk.stableId
    )
      throw new FactorySourceError(
        "Factory staging requires a privileged Linux storage session.",
      );
    for (const role of ["esp", "recovery"] as const) {
      const source = sources[role];
      const end = source.offsetBytes + verified.manifest[role].sizeBytes;
      if (
        !Number.isSafeInteger(source.offsetBytes) ||
        source.offsetBytes < 0 ||
        source.offsetBytes % 512 !== 0 ||
        !Number.isSafeInteger(end)
      )
        throw new FactorySourceError("Factory source extent is invalid.");
      const info = await source.file.stat();
      if (
        (!info.isFile() && !info.isBlockDevice()) ||
        (info.isFile() && end > info.size)
      )
        throw new FactorySourceError(
          "Factory source must contain the complete authenticated extent.",
        );
    }
    const directory = await open(
      storage.directoryPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    handles.push(directory);
    const parent = await directory.stat({ bigint: true });
    const base = `/proc/self/fd/${directory.fd}`;
    const filesystem = await statfs(base, { bigint: true });
    if (
      parent.uid !== 0n ||
      parent.gid !== 0n ||
      (parent.mode & 0o7777n) !== 0o700n ||
      filesystem.type !== 0xef53n
    )
      throw new FactorySourceError(
        "Factory staging requires a root-owned 0700 ext-family directory.",
      );
    const checkDirectory = async () => {
      signal?.throwIfAborted();
      const named = await lstat(storage.directoryPath, { bigint: true });
      if (
        !named.isDirectory() ||
        named.dev !== parent.dev ||
        named.ino !== parent.ino ||
        named.uid !== 0n ||
        named.gid !== 0n ||
        (named.mode & 0o7777n) !== 0o700n
      )
        throw new FactorySourceError("Factory staging directory changed.");
    };
    const staged = {} as Record<"esp" | "recovery", FilesystemImageSource>;
    const bytes = Buffer.alloc(4 * 1024 * 1024);
    const zeros = Buffer.alloc(bytes.length);
    for (const role of ["esp", "recovery"] as const) {
      await checkDirectory();
      const expected = verified.manifest[role];
      const source = sources[role];
      const temporary = `${base}/.factory-${randomUUID()}.partial`;
      const output = await open(
        temporary,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      handles.push(output);
      const original = await output.stat({ bigint: true });
      if (
        !original.isFile() ||
        original.dev !== parent.dev ||
        original.uid !== 0n ||
        original.gid !== 0n ||
        original.nlink !== 1n ||
        (original.mode & 0o7777n) !== 0o600n
      )
        throw new FactorySourceError(
          "Factory staging file has unsafe metadata.",
        );
      await output.truncate(expected.sizeBytes);
      const hash = createHash("sha256");
      for (let offset = 0; offset < expected.sizeBytes; ) {
        signal?.throwIfAborted();
        const { bytesRead } = await source.file.read(
          bytes,
          0,
          Math.min(bytes.length, expected.sizeBytes - offset),
          source.offsetBytes + offset,
        );
        if (!bytesRead)
          throw new FactorySourceError(
            "Factory source ended before its authenticated size.",
          );
        const chunk = bytes.subarray(0, bytesRead);
        hash.update(chunk);
        if (!chunk.equals(zeros.subarray(0, bytesRead))) {
          for (let written = 0; written < bytesRead; ) {
            signal?.throwIfAborted();
            const result = await output.write(
              bytes,
              written,
              bytesRead - written,
              offset + written,
            );
            if (!result.bytesWritten)
              throw new FactorySourceError(
                "Factory staging write made no progress.",
              );
            written += result.bytesWritten;
          }
        }
        offset += bytesRead;
      }
      if (hash.digest("hex") !== expected.sha256)
        throw new FactorySourceError(
          "Factory source does not match the authenticated partition hash.",
        );
      await output.sync();
      const readback = createHash("sha256");
      for (let offset = 0; offset < expected.sizeBytes; ) {
        signal?.throwIfAborted();
        const { bytesRead } = await output.read(
          bytes,
          0,
          Math.min(bytes.length, expected.sizeBytes - offset),
          offset,
        );
        if (!bytesRead)
          throw new FactorySourceError("Staged factory image ended early.");
        readback.update(bytes.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (readback.digest("hex") !== expected.sha256)
        throw new FactorySourceError(
          "Staged factory image readback did not verify.",
        );
      await checkDirectory();
      const current = await output.stat({ bigint: true });
      const named = await lstat(temporary, { bigint: true });
      if (
        named.dev !== original.dev ||
        named.ino !== original.ino ||
        current.size !== BigInt(expected.sizeBytes) ||
        current.nlink !== 1n ||
        current.uid !== 0n ||
        current.gid !== 0n ||
        (current.mode & 0o7777n) !== 0o600n
      )
        throw new FactorySourceError(
          "Factory staging file changed before publication.",
        );
      // Never replace an existing store object, even on a retry.
      await link(temporary, `${base}/${expected.sha256}.img`);
      await unlink(temporary);
      await directory.sync();
      staged[role] = Object.freeze({
        ...expected,
        storageStableId: storage.disk.stableId,
      });
    }
    await checkDirectory();
    receipt = Object.freeze({ ...verified, sources: Object.freeze(staged) });
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
    throw new FactorySourceError(
      "Factory source staging failed; retain partial files and any already published images.",
      { cause: new AggregateError(errors) },
    );
  return receipt;
}
