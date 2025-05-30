import { logger } from '@elizaos/core';
import { CachedRegistry } from '../types/plugins';

export async function fetchPluginRegistry(): Promise<CachedRegistry | null> {
  try {
    const resp = await fetch('https://vercel-api-psi.vercel.app/api/plugins/registry');
    if (!resp.ok) {
      logger.error(`Failed to fetch plugin registry: ${resp.statusText}`);
      throw new Error(`Failed to fetch registry: ${resp.statusText}`);
    }
    const raw = await resp.json();
    return raw as CachedRegistry;
  } catch {
    return null;
  }
}
