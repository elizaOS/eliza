import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execa } from 'execa';
import {
  GitResolutionDetail,
  NpmResolutionDetail,
  VersionResolution,
  PluginInfo,
  CachedRegistry,
} from '../types/plugins';

const CACHE_PATH = join(homedir(), '.eliza', 'cached-registry.json');

/** Read and parse the cached registry file */
export async function readCache(): Promise<CachedRegistry | null> {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const raw = readFileSync(CACHE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as { lastUpdatedAt: string; registry: any };
    const plugins: Record<string, PluginInfo> = {};

    for (const [key, info] of Object.entries(parsed.registry || {})) {
      const git = (info as any).git || {};
      const npm = (info as any).npm || {};
      const isOfficial = key.startsWith('@elizaos/');

      const v0Ver = git.v0?.version ?? npm.v0 ?? null;
      const v1Ver = git.v1?.version ?? npm.v1 ?? null;

      const v0Source = v0Ver ? (git.v0?.version ? 'git' : 'npm') : null;
      const v1Source = v1Ver ? (git.v1?.version ? 'git' : 'npm') : null;

      const v0Detail = git.v0?.version
        ? ({
            kind: 'github',
            branch: git.v0.branch ?? null,
            coreDependency: null,
          } as GitResolutionDetail)
        : npm.v0
          ? ({ kind: 'npm', npmVersion: npm.v0 ?? null } as NpmResolutionDetail)
          : undefined;

      const v1Detail = git.v1?.version
        ? ({
            kind: 'github',
            branch: git.v1.branch ?? null,
            coreDependency: null,
          } as GitResolutionDetail)
        : npm.v1
          ? ({ kind: 'npm', npmVersion: npm.v1 ?? null } as NpmResolutionDetail)
          : undefined;

      plugins[key] = {
        registryKey: key,
        npmQueryName: key,
        githubLocator: null,
        isOfficialRepo: isOfficial,
        versions: {
          v0: { version: v0Ver, source: v0Source, resolutionDetail: v0Detail },
          v1: { version: v1Ver, source: v1Source, resolutionDetail: v1Detail },
        },
        errors: [],
      };
    }

    return { lastUpdatedAt: parsed.lastUpdatedAt, plugins };
  } catch {
    return null;
  }
}

/** Run the parse-registry script to refresh the cache */
export async function updatePluginRegistryCache(): Promise<boolean> {
  const scriptPath = join(__dirname, 'parse-registry.ts');
  try {
    await execa('bunx', ['tsx', scriptPath], { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}
