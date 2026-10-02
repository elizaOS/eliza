import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  acquireWorkerLease,
  inspectWorkerLease,
  resolveWorkerSocketRoot,
} from '../../src/services/workflow-worker-lease';

test('long desktop homes use an owned bounded root and a real authenticated socket', async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'worker-long-home-')));
  const nested = path.join(home, 'h'.repeat(100));
  fs.mkdirSync(nested);
  let root: string | undefined;
  try {
    root = resolveWorkerSocketRoot(nested, 'darwin');
    expect(Buffer.byteLength(root) + 26).toBeLessThanOrEqual(100);
    expect(fs.statSync(root).uid).toBe(process.getuid?.());
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    expect(resolveWorkerSocketRoot(nested, 'darwin')).toBe(root);
    const input = {
      rootDir: nested,
      socketRoot: root,
      runId: 'synthetic',
      versionId: 'v1',
      sourceSha256: 'a'.repeat(64),
    };
    const lease = await acquireWorkerLease(input);
    expect((await inspectWorkerLease(input)).state).toBe('live');
    await lease.finishCanonicalResult();
    expect((await inspectWorkerLease(input)).state).toBe('absent');
    expect(() => resolveWorkerSocketRoot(nested, 'android')).toThrow('Application-private');
  } finally {
    if (root) fs.rmdirSync(root);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Android keeps a compact application-private socket root and rejects symlink occupancy', () => {
  const home = fs.realpathSync(fs.mkdtempSync('/tmp/w-'));
  try {
    const compactHome = path.join(home, 'h'.repeat(65 - Buffer.byteLength(home) - 1));
    fs.mkdirSync(compactHome);
    expect(resolveWorkerSocketRoot(compactHome, 'android')).toBe(path.join(compactHome, '.ew'));
    const poisoned = path.join(home, 'poisoned');
    fs.mkdirSync(poisoned);
    fs.symlinkSync(home, path.join(poisoned, '.eliza-worker-ipc'));
    expect(() => resolveWorkerSocketRoot(poisoned, 'android')).toThrow('Untrusted worker lease');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
