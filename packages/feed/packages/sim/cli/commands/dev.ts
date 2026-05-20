/**
 * `babylon dev` — Start the runtime in development mode with hot-reload.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { watch } from 'chokidar';
import { defineCommand } from 'citty';
import consola from 'consola';
import {
  type BabylonRuntimeConfig,
  loadBabylonConfig,
  watchBabylonConfig,
} from '../../core/config';
import { buildEngine, parseInterval } from '../shared';

interface SystemsWatcher {
  on(
    event: 'all',
    listener: (event: string, path: string) => void
  ): SystemsWatcher;
  close(): Promise<void>;
}

export default defineCommand({
  meta: {
    name: 'dev',
    description:
      'Start Babylon Runtime in development mode with watch & hot-reload',
  },
  args: {
    rootDir: {
      type: 'string',
      description: 'Project root directory',
      default: '.',
    },
    interval: {
      type: 'string',
      description: 'Tick interval in seconds (0 = single tick)',
      default: '60',
    },
    legacy: {
      type: 'boolean',
      description: 'Include legacy game-tick bridge system',
      default: false,
    },
  },
  async run({ args }) {
    const rootDir = resolve(args.rootDir);
    consola.box('Babylon Runtime — dev mode');

    const loaded = await loadBabylonConfig(rootDir);
    let currentConfig: BabylonRuntimeConfig = loaded.config;
    consola.info(`Config: ${loaded.configFile ?? 'defaults'}`);

    let engine = await buildEngine(currentConfig, rootDir, args.legacy);
    const intervalSec = parseInterval(args.interval, 'interval');

    // Serialize ticks + reloads to avoid shutdown() racing tick()
    let op = Promise.resolve<void>(undefined);
    const enqueue = (fn: () => Promise<void>) => {
      op = op.then(fn, fn);
      return op;
    };

    let reloadQueued = false;
    const queueReload = (reason: string) => {
      if (reloadQueued) return;
      reloadQueued = true;
      void enqueue(async () => {
        reloadQueued = false;
        consola.start(`Reloading engine (${reason})...`);

        try {
          const next = await buildEngine(currentConfig, rootDir, args.legacy);
          const prev = engine;
          engine = next;
          await prev.shutdown();
          consola.success('Engine reloaded');
        } catch (err) {
          consola.error('Reload failed:', err);
        }
      });
    };

    const watchState: {
      systemsWatcher: SystemsWatcher | null;
      watchedSystemsDir: string | null;
    } = { systemsWatcher: null, watchedSystemsDir: null };

    const resetSystemsWatcher = async () => {
      const watchEnabled = currentConfig.dev?.watch !== false;
      const nextDir = watchEnabled
        ? resolve(rootDir, currentConfig.systemsDir ?? './systems')
        : null;

      if (nextDir === watchState.watchedSystemsDir) return;

      if (watchState.systemsWatcher) await watchState.systemsWatcher.close();
      watchState.systemsWatcher = null;
      watchState.watchedSystemsDir = null;

      if (!nextDir) {
        consola.info('System watcher disabled by config');
        return;
      }

      if (!existsSync(nextDir)) {
        consola.info(
          `No systems directory at ${nextDir} — skipping file watcher`
        );
        return;
      }

      watchState.watchedSystemsDir = nextDir;
      watchState.systemsWatcher = watch(nextDir, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200 },
      }) as unknown as SystemsWatcher;

      watchState.systemsWatcher.on('all', (event, path) => {
        consola.info(`System ${event}: ${path}`);
        queueReload('systems changed');
      });

      consola.success(`Watching ${nextDir} for changes`);
    };

    await resetSystemsWatcher();

    const configWatcher =
      currentConfig.dev?.watchConfig === false
        ? null
        : await watchBabylonConfig(rootDir, (nextConfig) => {
            currentConfig = nextConfig;
            void enqueue(resetSystemsWatcher);
            queueReload('config changed');
          });

    // Tick loop
    let running = true;
    let tickCount = 0;

    const cleanup = async () => {
      if (!running) return;
      running = false;
      consola.info('Shutting down...');
      if (configWatcher) await configWatcher.unwatch();
      if (watchState.systemsWatcher) await watchState.systemsWatcher.close();
      await engine.shutdown();
      consola.success(`Stopped after ${tickCount} ticks`);
      process.exit(0);
    };

    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);

    if (intervalSec <= 0) {
      // Single tick mode
      tickCount++;
      await enqueue(async () => {
        try {
          const metrics = await engine.tick();
          consola.success('Tick completed', metrics);
        } catch (err) {
          consola.error('Tick failed:', err);
        }
      });
      if (configWatcher) await configWatcher.unwatch();
      if (watchState.systemsWatcher) await watchState.systemsWatcher.close();
      await enqueue(async () => engine.shutdown());
      return;
    }

    while (running) {
      tickCount++;
      consola.start(`Tick #${tickCount}`);
      const start = Date.now();
      await enqueue(async () => {
        try {
          await engine.tick();
          const ms = Date.now() - start;
          consola.success(`Tick #${tickCount} completed in ${ms}ms`);
        } catch (err) {
          consola.error(`Tick #${tickCount} failed:`, err);
        }
      });

      if (running) {
        consola.info(`Next tick in ${intervalSec}s...`);
        await new Promise((r) => setTimeout(r, intervalSec * 1000));
      }
    }
  },
});
