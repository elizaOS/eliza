/**
 * The workflow state root must not be writable by other users, but a root this
 * process created under a group-writable umask (002, the default on
 * user-private-group Linux desktops) is still its own. Every workflow run first
 * inspects its worker lease there, so refusing such a root failed every run.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { inspectWorkerLease } from '../../src/services/workflow-worker-lease';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function leaseInput(rootDir: string) {
  return {
    rootDir,
    socketRoot: rootDir,
    runId: 'run-permissions',
    versionId: 'version-permissions',
    sourceSha256: 'a'.repeat(64),
  };
}

describe.skipIf(process.platform === 'win32')('workflow state root permissions', () => {
  test('a group-writable root owned by this process is tightened, not refused', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-root-')));
    roots.push(root);
    // What mkdir produces under umask 002, independent of this process's umask.
    fs.chmodSync(root, 0o775);

    expect(await inspectWorkerLease(leaseInput(root))).toEqual({ state: 'absent' });
    expect(fs.statSync(root).mode & 0o022).toBe(0);
  });
});
