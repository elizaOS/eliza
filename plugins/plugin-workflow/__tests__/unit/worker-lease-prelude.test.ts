import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireWorkerLease } from '../../src/services/workflow-worker-lease';
import { workerLeasePrelude } from '../../src/services/workflow-worker-lease-prelude';

// The worker runs the generated prelude, not the source its other tests
// import. Load it as a module the way smithers-runtime embeds it and check
// that state-root admission behaves the same as the source.
type Acquire = typeof acquireWorkerLease;
const work = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'lease-prelude-')));
let preludeAcquire: Acquire;

beforeAll(async () => {
  const file = path.join(work, 'prelude.mjs');
  fs.writeFileSync(file, workerLeasePrelude);
  await import(pathToFileURL(file).href);
  preludeAcquire = (globalThis as { __elizaAcquireWorkerLease?: Acquire })
    .__elizaAcquireWorkerLease as Acquire;
});
afterAll(() => fs.rmSync(work, { recursive: true, force: true }));

async function admit(acquire: Acquire, rootMode: number | 'file') {
  const base = fs.mkdtempSync(path.join(work, 'r-'));
  const rootDir = path.join(base, 'state');
  if (rootMode === 'file') fs.writeFileSync(rootDir, '');
  else {
    fs.mkdirSync(rootDir);
    fs.chmodSync(rootDir, rootMode);
  }
  // Short and owner-only, like the runtime's socket root.
  const socketRoot = fs.mkdtempSync('/tmp/wl-');
  fs.chmodSync(socketRoot, 0o700);
  try {
    const lease = await acquire({
      rootDir,
      socketRoot,
      runId: 'synthetic',
      versionId: 'v1',
      sourceSha256: 'a'.repeat(64),
    });
    await lease.finishCanonicalResult();
    return { admitted: true, mode: fs.statSync(rootDir).mode & 0o7777 };
  } catch (error) {
    return { admitted: false, error: (error as Error).message };
  } finally {
    fs.rmSync(socketRoot, { recursive: true, force: true });
  }
}

test('the prelude loads and installs the lease entry point', () => {
  expect(typeof preludeAcquire).toBe('function');
});

test('an owner-only state root is admitted unchanged by source and prelude', async () => {
  const source = await admit(acquireWorkerLease, 0o755);
  expect(source).toEqual({ admitted: true, mode: 0o755 });
  expect(await admit(preludeAcquire, 0o755)).toEqual(source);
});

test('a group-writable state root is tightened, not refused, by source and prelude', async () => {
  const source = await admit(acquireWorkerLease, 0o775);
  expect(source).toEqual({ admitted: true, mode: 0o755 });
  expect(await admit(preludeAcquire, 0o775)).toEqual(source);
});

test('a regular file as state root is refused by source and prelude', async () => {
  const source = await admit(acquireWorkerLease, 'file');
  expect(source).toEqual({ admitted: false, error: 'Untrusted workflow state root' });
  expect(await admit(preludeAcquire, 'file')).toEqual(source);
});
