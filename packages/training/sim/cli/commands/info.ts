/**
 * `babylon info` — Show runtime configuration and discovered systems.
 */

import { resolve } from 'node:path';
import { defineCommand } from 'citty';
import consola from 'consola';
import { loadBabylonConfig } from '../../core/config';
import { scanSystems } from '../../core/scanner';
import { phaseName } from '../shared';

export default defineCommand({
  meta: {
    name: 'info',
    description: 'Show runtime configuration and discovered systems',
  },
  args: {
    rootDir: {
      type: 'string',
      description: 'Project root directory',
      default: '.',
    },
  },
  async run({ args }) {
    const rootDir = resolve(args.rootDir);
    const { config, configFile } = await loadBabylonConfig(rootDir);

    consola.box('Babylon Runtime — Info');

    consola.info('Configuration');
    consola.log(`  Config file:  ${configFile ?? '(none, using defaults)'}`);
    consola.log(`  Root dir:     ${rootDir}`);
    consola.log(
      `  Systems dir:  ${resolve(rootDir, config.systemsDir ?? './systems')}`
    );
    consola.log(`  Budget:       ${config.budgetMs ?? 60_000}ms`);
    consola.log(`  .env loaded:  ${process.env.DATABASE_URL ? 'yes' : 'no'}`);
    consola.log('');

    const { systems, files } = await scanSystems(
      config.systemsDir ?? './systems',
      rootDir
    );

    consola.info(
      `Discovered ${systems.length} system(s) from ${files.length} file(s)`
    );
    consola.log('');

    if (systems.length > 0) {
      // Group by phase
      const byPhase = new Map<number, typeof systems>();
      for (const sys of systems) {
        const group = byPhase.get(sys.phase) ?? [];
        group.push(sys);
        byPhase.set(sys.phase, group);
      }

      const phases = [...byPhase.keys()].sort((a, b) => a - b);
      for (const phase of phases) {
        const name = phaseName(phase);
        const group = byPhase.get(phase);
        if (!group) continue;
        consola.log(`  [${phase}] ${name}`);
        for (const sys of group) {
          const flags = [
            sys.skipDeadlineCheck ? 'critical' : '',
            sys.dependencies?.length
              ? `deps: ${sys.dependencies.join(', ')}`
              : '',
          ].filter(Boolean);
          const suffix = flags.length > 0 ? ` (${flags.join(', ')})` : '';
          consola.log(`    - ${sys.id} — ${sys.name}${suffix}`);
        }
      }
    }

    if (config.disabledSystems?.length) {
      consola.log('');
      consola.warn(`Disabled systems: ${config.disabledSystems.join(', ')}`);
    }
  },
});
