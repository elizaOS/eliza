import * as fs from 'node:fs';
import * as path from 'node:path';
import { digest, ownedDirectory, syncDirectory } from './workflow-worker-lease';

/**
 * Parent-side only. Kept out of workflow-worker-lease.ts so the generated
 * worker prelude never bundles the host package.
 */

/** Leave room for slash + the fixed 20-hex-character socket basename + .sock. */
const SOCKET_ROOT_BYTE_LIMIT = 100 - 1 - 20 - 5;

/** Stable across parent restarts, private to this UID and canonical home. */
export function resolveWorkerSocketRoot(
  home: string,
  platform: NodeJS.Platform | 'android' = process.env.ELIZA_PLATFORM?.trim() === 'android' ||
  process.env.ELIZA_MOBILE_PLATFORM === 'android'
    ? 'android'
    : process.platform
): string {
  const canonicalHome = fs.realpathSync(home);
  let selected = path.join(canonicalHome, '.eliza-worker-ipc');
  if (Buffer.byteLength(selected) > SOCKET_ROOT_BYTE_LIMIT) {
    selected = path.join(canonicalHome, '.ew');
  }
  if (Buffer.byteLength(selected) > SOCKET_ROOT_BYTE_LIMIT) {
    // Android must never move its lease outside its application sandbox.
    if (platform !== 'darwin' && platform !== 'linux') {
      throw Error('Application-private worker socket root is too long');
    }
    const temporary = fs.realpathSync('/tmp');
    const stat = fs.lstatSync(temporary);
    if (
      !stat.isDirectory() ||
      !(
        (stat.uid === 0 && (stat.mode & 0o1000) !== 0) ||
        (stat.uid === process.getuid?.() && (stat.mode & 0o022) === 0)
      )
    ) {
      throw Error('Untrusted short worker socket base');
    }
    selected = path.join(
      temporary,
      `.ew-${process.getuid?.()}-${digest(canonicalHome).slice(0, 32)}`
    );
  }
  if (Buffer.byteLength(selected) > SOCKET_ROOT_BYTE_LIMIT) {
    throw Error('Worker socket root exceeds address budget');
  }
  try {
    fs.mkdirSync(selected, { mode: 0o700 });
    syncDirectory(path.dirname(selected));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  ownedDirectory(selected);
  return selected;
}
