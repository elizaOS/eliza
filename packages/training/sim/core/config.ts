/**
 * Config loading via c12 — loads babylon.config.ts (or .js/.json/etc.)
 *
 * Automatically loads .env from the repo root before evaluating the config file,
 * so process.env is populated and available inside babylon.config.ts.
 */

import { execSync } from 'node:child_process';
import { type ConfigWatcher, loadConfig, watchConfig } from 'c12';
import type { BabylonConfig } from './augments';
import type { TickPhase } from './types';

type IsEmpty<T> = keyof T extends never ? true : false;

let _repoRoot: string | undefined | null = null;

function findRepoRoot(from?: string): string | undefined {
  if (_repoRoot !== null) return _repoRoot;
  try {
    _repoRoot = execSync('git rev-parse --show-toplevel', {
      cwd: from ?? process.cwd(),
      encoding: 'utf-8',
      timeout: 3000,
    }).trim();
  } catch {
    _repoRoot = undefined;
  }
  return _repoRoot;
}

interface BabylonRuntimeConfigBase {
  /** Directory to scan for systems (relative to rootDir) */
  systemsDir?: string;

  /** Tick budget in milliseconds */
  budgetMs?: number;

  /** System ordering overrides — map of system id to phase */
  systemPhases?: Record<string, TickPhase>;

  /** Systems to disable by id */
  disabledSystems?: string[];

  /**
   * Legacy subsystem IDs that have been migrated to new sim systems.
   * These are passed to executeGameTick() as a skip set. Today this is
   * primarily used for observability (logging) — executeGameTick() does
   * not yet universally gate subsystems by this set.
   *
   * Only relevant when using --legacy.
   */
  migratedSubsystems?: string[];

  /** Dev server options */
  dev?: {
    /** Watch for system file changes */
    watch?: boolean;
    /** Auto-restart on config change */
    watchConfig?: boolean;
  };
}

export type BabylonRuntimeConfig = BabylonRuntimeConfigBase &
  (IsEmpty<BabylonConfig> extends true
    ? { [key: string]: unknown }
    : BabylonConfig & { [key: string]: unknown });

export const defaultConfig: BabylonRuntimeConfig = {
  systemsDir: './systems',
  budgetMs: 60_000,
  dev: {
    watch: true,
    watchConfig: true,
  },
};

export async function loadBabylonConfig(
  cwd?: string
): Promise<{ config: BabylonRuntimeConfig; configFile?: string }> {
  const configCwd = cwd ?? process.cwd();
  const repoRoot = findRepoRoot(configCwd);

  const resolved = await loadConfig<BabylonRuntimeConfig>({
    name: 'babylon',
    cwd: configCwd,
    defaults: defaultConfig,
    rcFile: false,
    packageJson: false,
    dotenv: repoRoot ? { cwd: repoRoot } : true,
  });

  return {
    config: resolved.config ?? defaultConfig,
    configFile: resolved.configFile ?? undefined,
  };
}

export async function watchBabylonConfig(
  cwd?: string,
  onUpdate?: (config: BabylonRuntimeConfig) => void
): Promise<ConfigWatcher<BabylonRuntimeConfig>> {
  const configCwd = cwd ?? process.cwd();
  const repoRoot = findRepoRoot(configCwd);

  const watcher = await watchConfig<BabylonRuntimeConfig>({
    name: 'babylon',
    cwd: configCwd,
    defaults: defaultConfig,
    rcFile: false,
    packageJson: false,
    dotenv: repoRoot ? { cwd: repoRoot } : true,
    onUpdate: (ctx) => {
      if (onUpdate && ctx.newConfig.config) {
        onUpdate(ctx.newConfig.config);
      }
    },
  });

  return watcher;
}

export function defineBabylonConfig(
  config: BabylonRuntimeConfig
): BabylonRuntimeConfig {
  return config;
}
