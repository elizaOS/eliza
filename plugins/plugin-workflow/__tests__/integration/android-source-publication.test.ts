// Android publication uses POSIX ownership/mode admission; Windows has a separate native backend.
import { afterEach, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishAndroidWorkflowSource } from '../../src/services/workflow-source-publication';

const owned: string[] = [];
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'eliza-source-publication-')));
  owned.push(root);
  await chmod(root, 0o700);
  return root;
}
afterEach(async () => {
  await Promise.all(owned.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const modulePath = fileURLToPath(
  new URL('../../src/services/workflow-source-publication.ts', import.meta.url)
);
function child(path: string, source: string): Promise<{ code: number | null; error: string }> {
  const program = `import {publishAndroidWorkflowSource} from ${JSON.stringify(modulePath)}; try { await publishAndroidWorkflowSource(${JSON.stringify(path)}, ${JSON.stringify(source)}); } catch(error) { console.error(String(error)); process.exitCode=1; }`;
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--eval', program], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let error = '';
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (text) => {
      error += text;
    });
    process.on('error', reject);
    process.on('close', (code) => resolve({ code, error }));
  });
}
test.skipIf(process.platform === 'win32')(
  'competing processes publish a complete immutable file and identical retries preserve identity',
  async () => {
    const root = await directory(),
      path = join(root, 'version.ts'),
      source = `export default ${JSON.stringify('完整🌍'.repeat(12000))};`;
    let finished = false,
      observations = 0;
    const writers = Promise.all(Array.from({ length: 6 }, () => child(path, source))).finally(
      () => {
        finished = true;
      }
    );
    while (!finished) {
      try {
        expect(await readFile(path, 'utf8')).toBe(source);
        observations++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    for (const result of await writers)
      expect(result, result.error).toEqual({ code: 0, error: '' });
    expect(await readFile(path, 'utf8')).toBe(source);
    const before = await lstat(path);
    expect(before.mode & 0o777).toBe(0o600);
    await publishAndroidWorkflowSource(path, source);
    expect((await lstat(path)).ino).toBe(before.ino);
    expect(await readdir(root)).toEqual(['version.ts']);
    expect(observations).toBeGreaterThan(0);
  },
  15000
);
test.skipIf(process.platform === 'win32')(
  'conflicting concurrent source cannot replace the winning version',
  async () => {
    const root = await directory(),
      path = join(root, 'version.ts');
    const results = await Promise.all([
      child(path, 'export default 1;'),
      child(path, 'export default 2;'),
    ]);
    expect(results.filter((result) => result.code === 0)).toHaveLength(1);
    expect(results.find((result) => result.code !== 0)?.error).toContain('identity mismatch');
    const winner = await readFile(path, 'utf8');
    expect(['export default 1;', 'export default 2;']).toContain(winner);
    await expect(
      publishAndroidWorkflowSource(
        path,
        winner === 'export default 1;' ? 'export default 2;' : 'export default 1;'
      )
    ).rejects.toThrow('identity mismatch');
    expect(await readFile(path, 'utf8')).toBe(winner);
    expect(await readdir(root)).toEqual(['version.ts']);
  }
);
test.skipIf(process.platform === 'win32')(
  'untrusted parent, reservation and target identities fail closed',
  async () => {
    const root = await directory(),
      real = join(root, 'real');
    await mkdir(real, { mode: 0o700 });
    const alias = join(root, 'alias');
    await symlink(real, alias);
    await expect(publishAndroidWorkflowSource(join(alias, 'version.ts'), 'one')).rejects.toThrow(
      'Untrusted'
    );
    await chmod(real, 0o777);
    await expect(publishAndroidWorkflowSource(join(real, 'version.ts'), 'one')).rejects.toThrow(
      'Untrusted'
    );
    await chmod(real, 0o700);
    const path = join(real, 'version.ts');
    await writeFile(`${path}.publication`, 'occupied');
    await expect(publishAndroidWorkflowSource(path, 'one')).rejects.toThrow('Untrusted');
    expect(await readFile(`${path}.publication`, 'utf8')).toBe('occupied');
    await rm(`${path}.publication`);
    const other = join(root, 'other.ts');
    await writeFile(other, 'one', { mode: 0o600 });
    await symlink(other, path);
    await expect(publishAndroidWorkflowSource(path, 'one')).rejects.toThrow();
    expect(await readFile(other, 'utf8')).toBe('one');
    await rm(path);
    await writeFile(path, 'one', { mode: 0o644 });
    await expect(publishAndroidWorkflowSource(path, 'one')).rejects.toThrow('identity mismatch');
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
  }
);
test.skipIf(process.platform === 'win32')(
  'an abandoned reservation is never stolen, but an already published identical version remains readable',
  async () => {
    const root = await directory(),
      path = join(root, 'version.ts'),
      reservation = `${path}.publication`;
    await mkdir(reservation, { mode: 0o700 });
    const identity = await lstat(reservation);
    await expect(publishAndroidWorkflowSource(path, 'one')).rejects.toThrow('unresolved');
    expect((await lstat(reservation)).ino).toBe(identity.ino);
    expect(await readdir(root)).toEqual(['version.ts.publication']);
    await writeFile(path, 'one', { mode: 0o600 });
    await publishAndroidWorkflowSource(path, 'one');
    expect((await lstat(reservation)).ino).toBe(identity.ino);
  },
  10000
);
