import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
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
  factoryBootPayloadPaths,
  type InstalledBootConfiguration,
  renderInstalledGrubConfiguration,
} from "./boot-config";
import type { LinuxRecoveryStorage } from "./linux-native-disk";
import {
  assertUnusedFactoryFstab,
  type InstalledRootConfiguration,
  renderInstalledFstab,
} from "./system-config";
import type { PlannedPartition } from "./types";

/** Expected bytes from the trusted, authenticated factory artifact producer.
 * This reference does not itself establish publisher authenticity. The source
 * must already be staged as <sha256>.img in the independent recovery store. */
export interface FilesystemImageSource {
  sha256: string;
  sizeBytes: number;
  storageStableId: string;
}

export interface FilesystemImageArtifact {
  sha256: string;
  sizeBytes: number;
  filesystem: "fat32" | "ext4";
  uuid: string;
  sourceSha256?: string;
  storageStableId: string;
}

export class FilesystemImageError extends Error {
  readonly code = "ELIZAOS_FILESYSTEM_IMAGE_ERROR";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FilesystemImageError";
  }
}

/** Fixed trusted system tools; no command or pathname is accepted from IPC. */
async function runTool(
  command: string,
  args: string[],
  descriptor: number | number[],
  signal?: AbortSignal,
  mtoolsConfig = false,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: "/",
      env: {
        LC_ALL: "C",
        ...(mtoolsConfig ? { MTOOLSRC: "/proc/self/fd/5" } : {}),
      },
      detached: true,
      stdio: [
        "ignore",
        "pipe",
        "pipe",
        ...(Array.isArray(descriptor) ? descriptor : [descriptor]),
      ],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (killError) {
          if ((killError as NodeJS.ErrnoException).code !== "ESRCH") {
            failure = new AggregateError(
              [failure, killError],
              "Unable to stop filesystem tool.",
            );
          }
        }
      }
    };
    const abort = () =>
      stop(
        new FilesystemImageError("Filesystem preparation cancelled.", {
          cause: signal?.reason,
        }),
      );
    const timer = setTimeout(
      () =>
        stop(
          new FilesystemImageError(
            "Filesystem tool exceeded its ten-minute deadline.",
          ),
        ),
      600_000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) {
        stop(
          new FilesystemImageError(
            "Filesystem tool output pipe is unavailable.",
          ),
        );
        continue;
      }
      stream.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024)
          stop(
            new FilesystemImageError(
              "Filesystem tool exceeded its 1 MiB output limit.",
            ),
          );
        else chunks.push(Buffer.from(chunk));
      });
    }
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, terminated) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const output = Buffer.concat(chunks).toString("utf8");
      if (failure)
        reject(
          new FilesystemImageError(
            `${command} failed; child settled. ${output}`,
            { cause: failure },
          ),
        );
      else if (code !== 0 || terminated)
        reject(
          new FilesystemImageError(
            `${command} exited ${code ?? terminated}: ${output}`,
          ),
        );
      else resolve(output);
    });
  });
}

/** Copy exact authenticated source bytes into a private staging file. Preserve
 * sparse zero regions without relying on pathname-based reflink/copy helpers. */
async function copySourceImage(
  directory: FileHandle,
  destination: FileHandle,
  source: FilesystemImageSource,
  signal?: AbortSignal,
): Promise<void> {
  const path = `/proc/self/fd/${directory.fd}/${source.sha256}.img`;
  const input = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  const errors: unknown[] = [];
  try {
    const original = await input.stat({ bigint: true });
    const parent = await directory.stat({ bigint: true });
    if (
      !original.isFile() ||
      original.uid !== 0n ||
      original.gid !== 0n ||
      (original.mode & 0o7777n) !== 0o600n ||
      original.nlink !== 1n ||
      original.dev !== parent.dev ||
      original.size !== BigInt(source.sizeBytes)
    ) {
      throw new FilesystemImageError(
        "Factory source has unsafe metadata or the wrong byte size.",
      );
    }
    const hash = createHash("sha256");
    const bytes = Buffer.alloc(4 * 1024 * 1024);
    const zeroes = Buffer.alloc(bytes.length);
    for (let offset = 0; offset < source.sizeBytes; ) {
      signal?.throwIfAborted();
      const { bytesRead } = await input.read(
        bytes,
        0,
        Math.min(bytes.length, source.sizeBytes - offset),
        offset,
      );
      if (!bytesRead)
        throw new FilesystemImageError(
          "Factory source ended before its declared size.",
        );
      const chunk = bytes.subarray(0, bytesRead);
      hash.update(chunk);
      if (!chunk.equals(zeroes.subarray(0, bytesRead))) {
        let used = 0;
        while (used < bytesRead) {
          signal?.throwIfAborted();
          const { bytesWritten } = await destination.write(
            chunk,
            used,
            bytesRead - used,
            offset + used,
          );
          if (!bytesWritten)
            throw new FilesystemImageError(
              "Factory payload copy made no progress.",
            );
          used += bytesWritten;
        }
      }
      offset += bytesRead;
    }
    const current = await input.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (
      hash.digest("hex") !== source.sha256 ||
      named.ino !== original.ino ||
      named.dev !== original.dev ||
      current.size !== original.size ||
      current.mtimeNs !== original.mtimeNs ||
      current.ctimeNs !== original.ctimeNs ||
      current.mode !== original.mode ||
      current.uid !== original.uid ||
      current.gid !== original.gid ||
      current.nlink !== original.nlink
    ) {
      throw new FilesystemImageError(
        "Factory source bytes or identity changed during preparation.",
      );
    }
  } catch (error) {
    errors.push(error);
  }
  try {
    await input.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new FilesystemImageError("Factory source copy failed.", {
      cause: new AggregateError(errors),
    });
}

/** Populate a new ESP through private regular-file descriptors. The factory
 * image is copied and hash-checked before mtools parses it. */
async function populateFatImage(
  directory: FileHandle,
  destination: FileHandle,
  source: FilesystemImageSource,
  boot: InstalledBootConfiguration,
  signal?: AbortSignal,
): Promise<void> {
  const menu = renderInstalledGrubConfiguration(boot);
  const handles: FileHandle[] = [];
  const paths: string[] = [];
  const errors: unknown[] = [];
  const scratch = async (suffix: string) => {
    const path = `/proc/self/fd/${directory.fd}/.efi-${randomUUID()}.${suffix}`;
    const file = await open(
      path,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    paths.push(path);
    handles.push(file);
    return file;
  };
  try {
    const input = await scratch("source");
    await input.truncate(source.sizeBytes);
    await copySourceImage(directory, input, source, signal);
    await runTool(
      "/usr/sbin/fsck.fat",
      ["-n", "/proc/self/fd/3"],
      input.fd,
      signal,
    );
    const mapping = await scratch("mtools");
    await mapping.writeFile(
      'drive S: file="/proc/self/fd/4"\ndrive D: file="/proc/self/fd/3"\n',
    );
    await runTool(
      "/usr/bin/mcopy",
      ["-s", "-p", "-m", "S:", "D:/"],
      [destination.fd, input.fd, mapping.fd],
      signal,
      true,
    );
    const vendorConfig = await runTool(
      "/usr/bin/mtype",
      ["-i", "/proc/self/fd/3", "::/EFI/debian/grub.cfg"],
      input.fd,
      signal,
    );
    if (vendorConfig.trim() !== "configfile /grub/grub.cfg")
      throw new FilesystemImageError(
        "Factory EFI loader does not use the supported external GRUB menu.",
      );
    const payloadPaths = factoryBootPayloadPaths(boot);
    const captured = await scratch("readback");
    const hashPayload = async (image: FileHandle, path: string) => {
      await captured.truncate(0);
      await runTool(
        "/usr/bin/mcopy",
        ["-o", "-i", "/proc/self/fd/3", `::${path}`, "/proc/self/fd/4"],
        [image.fd, captured.fd],
        signal,
      );
      const { size } = await captured.stat();
      if (!Number.isSafeInteger(size) || size <= 0)
        throw new FilesystemImageError(
          "Factory boot payload is empty or has an invalid size.",
        );
      const hash = createHash("sha256");
      const bytes = Buffer.alloc(4 * 1024 * 1024);
      for (let offset = 0; offset < size; ) {
        signal?.throwIfAborted();
        const { bytesRead } = await captured.read(
          bytes,
          0,
          Math.min(bytes.length, size - offset),
          offset,
        );
        if (!bytesRead)
          throw new FilesystemImageError("Boot payload readback ended early.");
        hash.update(bytes.subarray(0, bytesRead));
        offset += bytesRead;
      }
      return hash.digest("hex");
    };
    for (const path of payloadPaths) {
      if (
        (await hashPayload(input, path)) !==
        (await hashPayload(destination, path))
      ) {
        throw new FilesystemImageError(
          `Boot payload copy did not verify: ${path}`,
        );
      }
    }
    const config = await scratch("grub");
    await config.writeFile(menu);
    await runTool(
      "/usr/bin/mcopy",
      ["-o", "-i", "/proc/self/fd/3", "/proc/self/fd/4", "::/grub/grub.cfg"],
      [destination.fd, config.fd],
      signal,
    );
    const readback = await runTool(
      "/usr/bin/mtype",
      ["-i", "/proc/self/fd/3", "::/grub/grub.cfg"],
      destination.fd,
      signal,
    );
    if (readback !== menu)
      throw new FilesystemImageError(
        "Installed GRUB configuration did not read back exactly.",
      );
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
  if (!errors.length) {
    for (const path of paths) {
      try {
        await unlink(path);
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length)
    throw new FilesystemImageError(
      "EFI preparation failed; retain private .efi-* staging files.",
      { cause: new AggregateError(errors) },
    );
}

export async function configureInstalledRoot(
  directory: FileHandle,
  image: FileHandle,
  fstab: string,
  signal?: AbortSignal,
): Promise<void> {
  for (const path of ["/etc", "/home", "/efi"]) {
    const info = await runTool(
      "/usr/sbin/debugfs",
      ["-R", `stat ${path}`, "/proc/self/fd/3"],
      image.fd,
      signal,
    );
    if (!/Type:\s+directory\b/.test(info))
      throw new FilesystemImageError(
        `Factory system is missing the canonical ${path} directory.`,
      );
  }
  await replaceImageConfiguration(
    directory,
    image,
    "/etc/fstab",
    fstab,
    assertUnusedFactoryFstab,
    signal,
  );
  // Preserve systemd first-boot initialization; D-Bus supplies a fresh ID
  // when present instead of carrying the factory machine identity forward.
  const machineId = `${randomUUID().replaceAll("-", "")}\n`;
  await replaceImageConfiguration(
    directory,
    image,
    "/etc/machine-id",
    "uninitialized\n",
    undefined,
    signal,
  );
  const dbus = await runTool(
    "/usr/sbin/debugfs",
    ["-R", "stat /var/lib/dbus", "/proc/self/fd/3"],
    image.fd,
    signal,
  );
  if (!dbus.includes("File not found by ext2_lookup")) {
    if (!/Type:\s+directory\b/.test(dbus))
      throw new FilesystemImageError(
        "Factory D-Bus state path is not a directory.",
      );
    await replaceImageConfiguration(
      directory,
      image,
      "/var/lib/dbus/machine-id",
      machineId,
      undefined,
      signal,
    );
  }
}

async function replaceImageConfiguration(
  directory: FileHandle,
  image: FileHandle,
  target: string,
  content: string,
  validateExisting: ((content: Uint8Array) => void) | undefined,
  signal?: AbortSignal,
) {
  const temporary = `/proc/self/fd/${directory.fd}/.system-config-${randomUUID()}.partial`;
  const config = await open(
    temporary,
    constants.O_RDWR |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const errors: unknown[] = [];
  try {
    const existing = await runTool(
      "/usr/sbin/debugfs",
      ["-R", `stat ${target}`, "/proc/self/fd/3"],
      image.fd,
      signal,
    );
    if (!existing.includes("File not found by ext2_lookup")) {
      const symlink = !validateExisting && /Type:\s+symlink\b/.test(existing);
      const size = Number(/\bSize:\s+(\d+)/.exec(existing)?.[1]);
      if (
        (!/Type:\s+regular\b/.test(existing) && !symlink) ||
        !/User:\s+0\s+Group:\s+0\b/.test(existing) ||
        !/Links:\s+1\b/.test(existing) ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > 1024 * 1024
      )
        throw new FilesystemImageError(
          "Factory configuration has an unsupported inode type, ownership, link count, or size.",
        );
      if (validateExisting) {
        await runTool(
          "/usr/sbin/debugfs",
          ["-R", `dump ${target} /proc/self/fd/4`, "/proc/self/fd/3"],
          [image.fd, config.fd],
          signal,
        );
        const previous = await config.readFile();
        if (previous.length !== size)
          throw new FilesystemImageError(
            "Factory configuration readback size did not verify.",
          );
        validateExisting(previous);
      }
      await runTool(
        "/usr/sbin/debugfs",
        ["-w", "-R", `rm ${target}`, "/proc/self/fd/3"],
        image.fd,
        signal,
      );
      await config.truncate(0);
    }
    // Inspecting the existing configuration can advance the temporary descriptor.
    const replacement = Buffer.from(content);
    const { bytesWritten } = await config.write(
      replacement,
      0,
      replacement.length,
      0,
    );
    if (bytesWritten !== replacement.length)
      throw new FilesystemImageError(
        "Installed configuration staging write was incomplete.",
      );
    await config.sync();
    // debugfs refuses an existing inode, including one whose removal failed.
    const result = await runTool(
      "/usr/sbin/debugfs",
      ["-w", "-R", `write /proc/self/fd/4 ${target}`, "/proc/self/fd/3"],
      [image.fd, config.fd],
      signal,
    );
    if (!/Allocated inode:\s+\d+/.test(result))
      throw new FilesystemImageError(
        "Factory configuration already exists or could not be created; explicit migration is required.",
      );
    await runTool(
      "/usr/sbin/debugfs",
      ["-w", "-R", `set_inode_field ${target} mode 0100644`, "/proc/self/fd/3"],
      image.fd,
      signal,
    );
    const info = await runTool(
      "/usr/sbin/debugfs",
      ["-R", `stat ${target}`, "/proc/self/fd/3"],
      image.fd,
      signal,
    );
    if (
      !/Type:\s+regular\s+Mode:\s+0644\b/.test(info) ||
      !/User:\s+0\s+Group:\s+0\b/.test(info) ||
      !/Links:\s+1\b/.test(info)
    )
      throw new FilesystemImageError(
        "Installed configuration metadata did not verify.",
      );
    await config.truncate(0);
    await runTool(
      "/usr/sbin/debugfs",
      ["-R", `dump ${target} /proc/self/fd/4`, "/proc/self/fd/3"],
      [image.fd, config.fd],
      signal,
    );
    const readback = Buffer.alloc(Buffer.byteLength(content) + 1);
    const { bytesRead } = await config.read(readback, 0, readback.length, 0);
    if (
      bytesRead !== Buffer.byteLength(content) ||
      readback.subarray(0, bytesRead).toString("utf8") !== content
    )
      throw new FilesystemImageError(
        "Installed configuration content did not verify.",
      );
  } catch (error) {
    errors.push(error);
  }
  try {
    await config.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length)
    throw new FilesystemImageError(
      "Installed system configuration failed; retain the private partial files.",
      { cause: new AggregateError(errors) },
    );
  await unlink(temporary);
}

/** Prepare a filesystem on independent storage while the service retains
 * its target session. Failed partials are retained for explicit recovery. The
 * caller separately authenticates the plan and writes only via the native held
 * target descriptor. This function never opens a block device. */
export async function buildFilesystemImage(
  storage: LinuxRecoveryStorage,
  partition: PlannedPartition,
  logicalSectorBytes: number,
  signal?: AbortSignal,
  sourceImage?: FilesystemImageSource,
  bootConfiguration?: InstalledBootConfiguration,
  systemMounts?: InstalledRootConfiguration,
): Promise<FilesystemImageArtifact> {
  signal?.throwIfAborted();
  storage = structuredClone(storage);
  partition = structuredClone(partition);
  sourceImage =
    sourceImage === undefined ? undefined : structuredClone(sourceImage);
  bootConfiguration =
    bootConfiguration === undefined
      ? undefined
      : structuredClone(bootConfiguration);
  systemMounts =
    systemMounts === undefined ? undefined : structuredClone(systemMounts);
  if (
    systemMounts &&
    (!sourceImage ||
      partition.role !== "root" ||
      partition.filesystem !== "ext4")
  )
    throw new FilesystemImageError(
      "Installed mount configuration requires a factory-seeded ext4 root image.",
    );
  if (bootConfiguration) renderInstalledGrubConfiguration(bootConfiguration);
  if (
    (bootConfiguration && (!sourceImage || partition.filesystem !== "fat32")) ||
    (sourceImage && partition.filesystem === "fat32" && !bootConfiguration)
  ) {
    throw new FilesystemImageError(
      "Factory ESP preparation requires an explicit installed boot configuration.",
    );
  }
  const size = partition.endBytes - partition.startBytes;
  if (
    process.geteuid?.() !== 0 ||
    ![512, 4096].includes(logicalSectorBytes) ||
    !Number.isSafeInteger(size) ||
    size <
      (partition.filesystem === "fat32"
        ? logicalSectorBytes * 131072
        : 32 * 1024 ** 2) ||
    size % 1024 ** 2 !== 0 ||
    (partition.role === "esp"
      ? partition.filesystem !== "fat32"
      : partition.filesystem !== "ext4")
  ) {
    throw new FilesystemImageError(
      "Filesystem preparation requires root and exact supported partition geometry.",
    );
  }
  if (
    sourceImage &&
    (!/^[a-f0-9]{64}$/.test(sourceImage.sha256) ||
      !Number.isSafeInteger(sourceImage.sizeBytes) ||
      sourceImage.sizeBytes < 32 * 1024 ** 2 ||
      sourceImage.sizeBytes > size ||
      sourceImage.sizeBytes % 4096 !== 0 ||
      sourceImage.storageStableId !== storage.disk.stableId)
  ) {
    throw new FilesystemImageError(
      "Factory source requires a bound filesystem image that fits the reviewed partition.",
    );
  }
  const directory = await open(
    storage.directoryPath,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  let file: Awaited<ReturnType<typeof open>> | undefined;
  const temporaryName = `.filesystem-${randomUUID()}.partial`;
  const temporary = `/proc/self/fd/${directory.fd}/${temporaryName}`;
  let artifact: FilesystemImageArtifact | undefined;
  const errors: unknown[] = [];
  try {
    const parent = await directory.stat();
    const filesystem = await statfs(`/proc/self/fd/${directory.fd}`, {
      bigint: true,
    });
    if (
      !parent.isDirectory() ||
      parent.uid !== 0 ||
      parent.gid !== 0 ||
      (parent.mode & 0o7777) !== 0o700 ||
      filesystem.type !== 0xef53n
    ) {
      throw new FilesystemImageError(
        "Filesystem staging requires a root-owned 0700 ext-family directory.",
      );
    }
    const checkDirectory = async () => {
      signal?.throwIfAborted();
      const named = await lstat(storage.directoryPath);
      if (
        !named.isDirectory() ||
        named.ino !== parent.ino ||
        named.dev !== parent.dev ||
        named.uid !== 0 ||
        named.gid !== 0 ||
        (named.mode & 0o7777) !== 0o700
      ) {
        throw new FilesystemImageError("Filesystem staging directory changed.");
      }
    };
    await checkDirectory();
    file = await open(
      temporary,
      constants.O_RDWR |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const original = await file.stat();
    if (
      !original.isFile() ||
      original.uid !== 0 ||
      original.gid !== 0 ||
      original.dev !== parent.dev ||
      original.nlink !== 1
    ) {
      throw new FilesystemImageError(
        "Filesystem staging file has unsafe ownership or backing.",
      );
    }
    await file.truncate(size);
    const device = "/proc/self/fd/3";
    const expectedUuid =
      sourceImage && partition.filesystem === "ext4"
        ? (systemMounts?.rootUuid ?? randomUUID())
        : undefined;
    const fstab =
      systemMounts && expectedUuid
        ? renderInstalledFstab(expectedUuid, systemMounts)
        : undefined;
    if (partition.filesystem === "ext4") {
      const labels = {
        esp: "elizaos-esp",
        recovery: "elizaos-recovery",
        root: "elizaos-system",
        state: "elizaos-home",
      };
      if (sourceImage) {
        await copySourceImage(directory, file, sourceImage, signal);
        await checkDirectory();
        await runTool(
          "/usr/sbin/e2fsck",
          ["-f", "-n", device],
          file.fd,
          signal,
        );
        const sourceType = await runTool(
          "/usr/sbin/blkid",
          ["-p", "-s", "TYPE", "-o", "value", device],
          file.fd,
          signal,
        );
        if (sourceType.trim() !== "ext4")
          throw new FilesystemImageError("Factory source is not ext4.");
        const header = await runTool(
          "/usr/sbin/dumpe2fs",
          ["-h", device],
          file.fd,
          signal,
        );
        const blockSize = Number(/^Block size:\s+(\d+)$/m.exec(header)?.[1]);
        if (
          ![1024, 2048, 4096].includes(blockSize) ||
          blockSize < logicalSectorBytes
        )
          throw new FilesystemImageError(
            "Factory ext4 block size is incompatible with the target logical sector size.",
          );
        const sourceUuid = await runTool(
          "/usr/sbin/blkid",
          ["-p", "-s", "UUID", "-o", "value", device],
          file.fd,
          signal,
        );
        if (sourceUuid.trim() === expectedUuid)
          throw new FilesystemImageError(
            "Installed filesystem UUID must differ from the factory source.",
          );
        await runTool(
          "/usr/sbin/tune2fs",
          ["-U", expectedUuid as string, "-L", labels[partition.role], device],
          file.fd,
          signal,
        );
        await runTool("/usr/sbin/resize2fs", [device], file.fd, signal);
      } else {
        await runTool(
          "/usr/sbin/mkfs.ext4",
          ["-q", "-F", "-b", "4096", "-L", labels[partition.role], device],
          file.fd,
          signal,
        );
      }
      if (fstab) await configureInstalledRoot(directory, file, fstab, signal);
      await runTool("/usr/sbin/e2fsck", ["-f", "-n", device], file.fd, signal);
    } else {
      await runTool(
        "/usr/sbin/mkfs.vfat",
        [
          "-F",
          "32",
          "-s",
          "1",
          "-S",
          String(logicalSectorBytes),
          "-n",
          "ELIZAOS_EFI",
          "-i",
          randomBytes(4).toString("hex"),
          device,
        ],
        file.fd,
        signal,
      );
      if (sourceImage && bootConfiguration) {
        await populateFatImage(
          directory,
          file,
          sourceImage,
          bootConfiguration,
          signal,
        );
      }
      await runTool("/usr/sbin/fsck.fat", ["-n", device], file.fd, signal);
    }
    const probe = await runTool(
      "/usr/sbin/blkid",
      ["-p", "-o", "export", device],
      file.fd,
      signal,
    );
    const values = new Map(
      probe
        .trim()
        .split("\n")
        .map((line) => {
          const split = line.indexOf("=");
          return [line.slice(0, split), line.slice(split + 1)];
        }),
    );
    const uuid = values.get("UUID");
    if (
      values.get("TYPE") !==
        (partition.filesystem === "fat32" ? "vfat" : "ext4") ||
      !uuid ||
      (expectedUuid !== undefined && uuid !== expectedUuid) ||
      !(
        partition.filesystem === "fat32"
          ? /^[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}$/
          : /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/
      ).test(uuid)
    ) {
      throw new FilesystemImageError(
        "Prepared filesystem type or UUID did not verify.",
      );
    }
    await file.sync();
    const hash = createHash("sha256");
    const bytes = Buffer.alloc(4 * 1024 * 1024);
    for (let offset = 0; offset < size; ) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(
        bytes,
        0,
        Math.min(bytes.length, size - offset),
        offset,
      );
      if (!bytesRead)
        throw new FilesystemImageError(
          "Prepared filesystem image ended early.",
        );
      hash.update(bytes.subarray(0, bytesRead));
      offset += bytesRead;
    }
    await checkDirectory();
    const current = await file.stat();
    const named = await lstat(temporary);
    if (
      named.ino !== original.ino ||
      named.dev !== original.dev ||
      current.size !== size ||
      current.nlink !== 1 ||
      current.uid !== 0 ||
      current.gid !== 0 ||
      (current.mode & 0o7777) !== 0o600
    ) {
      throw new FilesystemImageError(
        "Prepared filesystem file changed before publication.",
      );
    }
    const sha256 = hash.digest("hex");
    await link(temporary, `/proc/self/fd/${directory.fd}/${sha256}.img`);
    await unlink(temporary);
    await directory.sync();
    artifact = {
      sha256,
      sizeBytes: size,
      filesystem: partition.filesystem,
      uuid,
      storageStableId: storage.disk.stableId,
      ...(sourceImage ? { sourceSha256: sourceImage.sha256 } : {}),
    };
  } catch (error) {
    errors.push(error);
  }
  for (const handle of [file, directory]) {
    try {
      await handle?.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length || !artifact) {
    throw new FilesystemImageError(
      `Filesystem preparation failed; retain any partial artifact named ${temporaryName} in the staging directory.`,
      { cause: new AggregateError(errors) },
    );
  }
  return artifact;
}
