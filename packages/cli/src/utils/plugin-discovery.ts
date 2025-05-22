import { promises as fs } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { CachedRegistry } from '../types/plugins';
import parseRegistry from './parse-registry';

/** Read and parse the cached registry file */
export async function readCache(): Promise<CachedRegistry | null> {
  try {
    const elizaDir = join(os.homedir(), '.eliza');
    const raw = await fs.readFile(join(elizaDir, 'cached-registry.json'), 'utf8');
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
