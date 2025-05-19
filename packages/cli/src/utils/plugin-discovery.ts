import { join } from 'node:path';
import { homedir } from 'node:os';
import { execa } from 'execa';
import { CachedRegistry } from '../types/plugins';
import { promises as fs } from 'node:fs';

const CACHE_PATH = join(homedir(), '.eliza', 'cached-registry.json');

/** Read and parse the cached registry file */
export async function readCache(): Promise<CachedRegistry | null> {
  try {
    if (
      !(await fs
        .access(CACHE_PATH)
        .then(() => true)
        .catch(() => false))
    )
      return null;
    const raw = await fs.readFile(CACHE_PATH, 'utf8');
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
