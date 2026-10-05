import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { dirname } from 'node:path';

async function syncDirectory(path: string) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function sameSource(path: string, source: string): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size !== Buffer.byteLength(source, 'utf8') ||
      (await handle.readFile('utf8')) !== source
    )
      throw Error('Workflow source publication identity mismatch');
    return true;
  } finally {
    await handle.close();
  }
}
/** Android app data denies hard links. All Android publishers reserve this name
 * before a complete-file rename; importers never observe a partial write. A
 * crashed reservation is preserved and cannot be stolen or used to overwrite
 * existing source. This is coordination inside the trusted app UID, not an
 * isolation boundary against arbitrary code already running under that UID. */
export async function publishAndroidWorkflowSource(
  sourcePath: string,
  source: string
): Promise<void> {
  const parent = dirname(sourcePath),
    reservation = `${sourcePath}.publication`;
  const parentStat = await lstat(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    parentStat.uid !== process.getuid?.() ||
    (parentStat.mode & 0o022) !== 0 ||
    (await realpath(parent)) !== parent
  )
    throw Error('Untrusted workflow source directory');
  if (await sameSource(sourcePath, source)) {
    await syncDirectory(parent);
    return;
  }
  const deadline = Date.now() + 5000;
  let identity: Stats;
  for (;;) {
    if (Date.now() >= deadline)
      throw Error('Workflow source publication unresolved; preserve reservation');
    try {
      await mkdir(reservation, { mode: 0o700 });
      identity = await lstat(reservation);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let existing: Stats;
      try {
        existing = await lstat(reservation);
      } catch (gone) {
        if ((gone as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw gone;
      }
      if (
        !existing.isDirectory() ||
        existing.isSymbolicLink() ||
        existing.uid !== process.getuid?.() ||
        (existing.mode & 0o077) !== 0
      )
        throw Error('Untrusted workflow source reservation');
      if (await sameSource(sourcePath, source)) {
        await syncDirectory(parent);
        return;
      }
      if (Date.now() >= deadline)
        throw Error('Workflow source publication unresolved; preserve reservation');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const temporary = `${sourcePath}.${randomUUID()}.pending`;
  const owned = async () => {
    const current = await lstat(reservation);
    if (
      !current.isDirectory() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.uid !== process.getuid?.() ||
      (current.mode & 0o077) !== 0
    )
      throw Error('Workflow source reservation changed; preserve it');
  };
  try {
    await syncDirectory(parent);
    if (await sameSource(sourcePath, source)) {
      await syncDirectory(parent);
      return;
    }
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(source, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await owned();
    if (!(await sameSource(sourcePath, source))) await rename(temporary, sourcePath);
    if (!(await sameSource(sourcePath, source))) throw Error('Workflow source publication missing');
    await syncDirectory(parent);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    await owned();
    await rmdir(reservation);
    await syncDirectory(parent);
  }
}
