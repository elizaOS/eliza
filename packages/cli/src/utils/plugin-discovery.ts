import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execa } from 'execa';
import { CachedRegistry } from '../types/plugins';

const CACHE_PATH = join(homedir(), '.eliza', 'cached-registry.json');

/** Read and parse the cached registry file */
export async function readCache(): Promise<CachedRegistry | null> {
  try {
    if (!existsSync(CACHE_PATH)) return null;
    const raw = readFileSync(CACHE_PATH, 'utf-8');
    return JSON.parse(raw) as CachedRegistry;
  } catch {
    return null;
  }
}

/** Run the parse-registry script to refresh the cache */
export async function updatePluginRegistryCache(): Promise<boolean> {
  const scriptPath = join(__dirname, 'parse-registry.ts');
  try {
    await execa('bun', ['run', scriptPath], { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}
