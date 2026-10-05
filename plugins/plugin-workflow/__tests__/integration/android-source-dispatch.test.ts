// Android publication uses POSIX ownership/mode admission; Windows has a separate native backend.
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishWorkflowSource } from '../../src/services/smithers-runtime';

test.skipIf(process.platform === 'win32')(
  'production publisher dispatches both Android environment aliases through reservation admission',
  async () => {
    const original = {
      platform: process.env.ELIZA_PLATFORM,
      mobile: process.env.ELIZA_MOBILE_PLATFORM,
    };
    const root = await realpath(await mkdtemp(join(tmpdir(), 'eliza-source-dispatch-')));
    try {
      for (const key of ['ELIZA_PLATFORM', 'ELIZA_MOBILE_PLATFORM'] as const) {
        delete process.env.ELIZA_PLATFORM;
        delete process.env.ELIZA_MOBILE_PLATFORM;
        process.env[key] = 'android';
        const path = join(root, `${key}.ts`),
          reservation = `${path}.publication`;
        await writeFile(reservation, 'not a reservation directory');
        await expect(publishWorkflowSource(path, 'export default 1;')).rejects.toThrow(
          'Untrusted workflow source reservation'
        );
        await rm(reservation);
        await publishWorkflowSource(path, 'export default 1;');
        await publishWorkflowSource(path, 'export default 1;');
        await expect(publishWorkflowSource(path, 'export default 2;')).rejects.toThrow(
          'identity mismatch'
        );
        expect(await readFile(path, 'utf8')).toBe('export default 1;');
      }
      delete process.env.ELIZA_PLATFORM;
      delete process.env.ELIZA_MOBILE_PLATFORM;
      const desktop = join(root, 'desktop.ts');
      await writeFile(
        `${desktop}.publication`,
        'Android-only reservation is not consumed on desktop'
      );
      await publishWorkflowSource(desktop, 'export default 3;');
      expect(await readFile(desktop, 'utf8')).toBe('export default 3;');
    } finally {
      if (original.platform === undefined) delete process.env.ELIZA_PLATFORM;
      else process.env.ELIZA_PLATFORM = original.platform;
      if (original.mobile === undefined) delete process.env.ELIZA_MOBILE_PLATFORM;
      else process.env.ELIZA_MOBILE_PLATFORM = original.mobile;
      await rm(root, { recursive: true, force: true });
    }
  }
);
