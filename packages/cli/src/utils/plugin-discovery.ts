import { logger } from '@elizaos/core';
import { CachedRegistry } from '../types/plugins';

export async function fetchPluginRegistry(): Promise<CachedRegistry | null> {
  try {
    const resp = await fetch(
      'https://raw.githubusercontent.com/elizaos-plugins/registry/refs/heads/main/generated-registry.json'
    );
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
