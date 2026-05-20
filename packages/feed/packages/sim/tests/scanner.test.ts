import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSystems } from '../core/scanner';

describe('scanSystems', () => {
  it('returns empty when directory does not exist', async () => {
    const result = await scanSystems('./nonexistent', '/tmp');
    expect(result.systems).toEqual([]);
    expect(result.files).toEqual([]);
  });

  it('returns empty for an empty directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sim-scan-'));
    try {
      const result = await scanSystems('.', dir);
      expect(result.systems).toEqual([]);
      expect(result.files).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('discovers a valid system from a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sim-scan-'));
    const systemFile = join(dir, 'test-system.ts');
    await writeFile(
      systemFile,
      `export default {
        id: 'test',
        name: 'Test System',
        phase: 100,
        onTick: async () => ({}),
      };`,
      'utf-8'
    );

    try {
      const result = await scanSystems('.', dir);
      expect(result.systems.length).toBe(1);
      expect(result.systems[0]!.id).toBe('test');
      expect(result.systems[0]!.name).toBe('Test System');
      expect(result.systems[0]!.phase).toBe(100);
      expect(result.files.length).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('skips files that do not export a valid system', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sim-scan-'));
    await writeFile(
      join(dir, 'not-a-system.ts'),
      `export const helper = () => 42;`,
      'utf-8'
    );

    try {
      const result = await scanSystems('.', dir);
      expect(result.systems).toEqual([]);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('deduplicates systems with the same id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sim-scan-'));
    // File exports the same system as default and named
    await writeFile(
      join(dir, 'dupe.ts'),
      `const sys = {
        id: 'dupe',
        name: 'Dupe',
        phase: 100,
        onTick: async () => ({}),
      };
      export default sys;
      export { sys };`,
      'utf-8'
    );

    try {
      const result = await scanSystems('.', dir);
      expect(result.systems.length).toBe(1);
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
