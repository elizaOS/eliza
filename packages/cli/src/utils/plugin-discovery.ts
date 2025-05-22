import { join } from 'node:path';
import parseRegistry from './parse-registry';
import { CachedRegistry } from '../types/plugins';
import { promises as fs } from 'node:fs';

const CACHE_PATH = join(process.cwd(), '.eliza', 'cached-registry.json');

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
  try {
    await parseRegistry();
    return true;
  } catch (error) {
    console.error('Failed to update plugin registry cache:', error);
    return false;
  }
}
