import { constants, type Stats } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

type PathError = (message: string, cause?: unknown) => Error;

/** Retain each ancestor while opening its child, rejecting links and directories
 * replaceable by another user. Callers must use the returned descriptor for I/O. */
export async function openTrustedInstallDirectory(
  directory: string,
  fail: PathError,
): Promise<FileHandle> {
  const uid = process.geteuid?.();
  if (
    uid === undefined ||
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    directory === "/"
  ) {
    throw fail(
      "Storage requires an exact private absolute path and an effective user identity.",
    );
  }
  const flags =
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let current: FileHandle;
  try {
    current = await open("/", flags);
  } catch (error) {
    throw fail("could not open the filesystem root safely.", error);
  }
  try {
    const filesystemOwnerUid = (await current.stat()).uid;
    const components = directory.split("/").filter(Boolean);
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index] as string;
      let next: FileHandle;
      try {
        next = await open(`/proc/self/fd/${current.fd}/${component}`, flags);
      } catch (error) {
        throw fail(
          "a storage-path component could not be opened without following links.",
          error,
        );
      }
      try {
        const stats = await next.stat();
        const final = index === components.length - 1;
        assertTrustedDirectoryStats(
          stats,
          filesystemOwnerUid,
          final,
          uid,
          fail,
        );
        await current.close();
      } catch (error) {
        try {
          await next.close();
        } catch (cleanupError) {
          throw fail(
            "path validation and child handle cleanup failed.",
            new AggregateError([error, cleanupError]),
          );
        }
        throw error;
      }
      current = next;
    }
    if (components.length === 0) {
      throw fail(
        "directory must be a private service-owned directory below the filesystem root.",
      );
    }
    return current;
  } catch (error) {
    try {
      await current.close();
    } catch (cleanupError) {
      throw fail(
        "path validation and ancestor handle cleanup failed.",
        new AggregateError([error, cleanupError]),
      );
    }
    throw error;
  }
}

function assertTrustedDirectoryStats(
  stats: Stats,
  filesystemOwnerUid: number,
  final: boolean,
  uid: number,
  fail: PathError,
): void {
  const writableByOthers = (stats.mode & 0o022) !== 0;
  const trustedStickyDirectory =
    stats.isDirectory() &&
    stats.uid === filesystemOwnerUid &&
    (stats.mode & 0o1000) !== 0;
  if (
    !stats.isDirectory() ||
    (stats.uid !== uid && stats.uid !== filesystemOwnerUid) ||
    (writableByOthers && !trustedStickyDirectory)
  ) {
    throw fail(
      "storage-path ancestors must be trusted real directories that cannot be replaced by another user.",
    );
  }
  if (final && (stats.uid !== uid || (stats.mode & 0o777) !== 0o700)) {
    throw fail(
      "directory must be service-owned and inaccessible to group/other users.",
    );
  }
}
