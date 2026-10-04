import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  acquireWorkerLease,
  inspectWorkerLease,
  resolveWorkerSocketRoot,
} from '../../src/services/workflow-worker-lease';

test.skipIf(process.platform === 'win32')(
  'source-bound owner records immutable executable identity on Linux and rejects source drift before admission',
  async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'worker-owner-')));
    try {
      const socketRoot = resolveWorkerSocketRoot(root);
      const sourcePath = path.join(root, 'source.ts');
      const source = 'export default {};';
      fs.writeFileSync(sourcePath, source, { mode: 0o600 });
      const input = {
        rootDir: root,
        socketRoot,
        sourcePath,
        sourceSha256: createHash('sha256').update(source).digest('hex'),
        runId: 'synthetic',
        versionId: 'v1',
      };
      await expect(acquireWorkerLease({ ...input, sourceSha256: '0'.repeat(64) })).rejects.toThrow(
        'source identity mismatch'
      );
      expect(fs.existsSync(path.join(root, '.worker-owners'))).toBe(false);
      const lease = await acquireWorkerLease(input);
      try {
        const runHash = createHash('sha256').update(input.runId).digest('hex');
        const owner = JSON.parse(
          fs.readFileSync(path.join(root, '.worker-owners', runHash, 'owner.json'), 'utf8')
        );
        expect((await inspectWorkerLease(input)).state).toBe('live');
        expect(owner.schemaVersion).toBe(process.platform === 'linux' ? 2 : 1);
        if (process.platform === 'linux') {
          expect(owner.sourcePath).toBe(sourcePath);
          expect(owner.nativeIdentity.pid).toBe(process.pid);
          expect(owner.nativeIdentity.uid).toBe(process.getuid?.());
          expect(owner.nativeIdentity.startTicks).toMatch(/^\d+$/);
          expect(owner.nativeIdentity.executable).toBe(fs.realpathSync('/proc/self/exe'));
          expect(owner.nativeIdentity.sha256).toBe(
            createHash('sha256').update(fs.readFileSync('/proc/self/exe')).digest('hex')
          );
        }
      } finally {
        await lease.finishCanonicalResult();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
);
