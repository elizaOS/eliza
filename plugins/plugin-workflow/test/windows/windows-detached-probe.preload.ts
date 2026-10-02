// Diagnostic-only preload: alter one real OS spawn, without modifying production source.
import { plugin } from 'bun';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

if (process.platform !== 'win32') throw Error('Windows diagnostic only');
const expected = realpathSync(resolve(import.meta.dir, '../../src/services/smithers-runtime.ts'));
plugin({
  name: 'owned-survivor-detachment-probe',
  setup(build) {
    build.onLoad({ filter: /smithers-runtime\.ts$/ }, async ({ path }) => {
      if (realpathSync(path) !== expected) throw Error('Unexpected diagnostic source');
      const source = await Bun.file(path).text();
      const boundary =
        'const worker = spawn(command.executable, command.args, {\n    cwd: command.cwd,';
      if (source.split(boundary).length !== 2) throw Error('Worker spawn boundary changed');
      process.stderr.write('[survivor-spawn-probe:detached]\n');
      return {
        contents: source.replace(boundary, boundary + '\n    detached: true,'),
        loader: 'ts',
      };
    });
  },
});
