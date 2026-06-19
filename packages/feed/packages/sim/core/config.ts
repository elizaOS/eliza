/**
 * Config loading via c12 — loads feed.config.ts (or .js/.json/etc.)
 *
 * Automatically loads .env from the repo root before evaluating the config file,
 * so process.env is populated and available inside feed.config.ts.
 */

import { execSync } from "node:child_process";
import { type ConfigWatcher, loadConfig, watchConfig } from "c12";
import type { FeedConfig } from "./augments";
import type { TickPhase } from "./types";

type IsEmpty<T> = keyof T extends never ? true : false;

let _repoRoot: string | undefined | null = null;

function findRepoRoot(from?: string): string | undefined {
  if (_repoRoot !== null) return _repoRoot;
  try {
    _repoRoot = execSync("git rev-parse --show-toplevel", {
      cwd: from ?? process.cwd(),
      encoding: "utf-8",
      timeout: 3000,
    }).trim();
  } catch {
    _repoRoot = undefined;
  }
  return _repoRoot;
}

interface FeedRuntimeConfigBase {
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

export type FeedRuntimeConfig = FeedRuntimeConfigBase &
  (IsEmpty<FeedConfig> extends true
    ? { [key: string]: unknown }
    : FeedConfig & { [key: string]: unknown });

export const defaultConfig: FeedRuntimeConfig = {
  systemsDir: "./systems",
  budgetMs: 60_000,
  dev: {
    watch: true,
    watchConfig: true,
  },
};

export async function loadFeedConfig(
  cwd?: string,
): Promise<{ config: FeedRuntimeConfig; configFile?: string }> {
  const configCwd = cwd ?? process.cwd();
  const repoRoot = findRepoRoot(configCwd);

  const resolved = await loadConfig<FeedRuntimeConfig>({
    name: "feed",
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

export async function watchFeedConfig(
  cwd?: string,
  onUpdate?: (config: FeedRuntimeConfig) => void,
): Promise<ConfigWatcher<FeedRuntimeConfig>> {
  const configCwd = cwd ?? process.cwd();
  const repoRoot = findRepoRoot(configCwd);

  const watcher = await watchConfig<FeedRuntimeConfig>({
    name: "feed",
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

export function defineFeedConfig(config: FeedRuntimeConfig): FeedRuntimeConfig {
  return config;
}
