import { fetchPluginRegistry } from '@/src/utils/plugin-discovery';
import { logHeader } from '@/src/utils';
import { logger } from '@elizaos/core';
import { ListPluginsOptions } from '../types';

/**
 * List available plugins from the registry
 */
export async function listAvailablePlugins(opts: ListPluginsOptions): Promise<void> {
  const cachedRegistry = await fetchPluginRegistry();

  if (
    !cachedRegistry ||
    !cachedRegistry.registry ||
    Object.keys(cachedRegistry.registry).length === 0
  ) {
    logger.info('Plugin cache is empty or not found.');
    console.log('\nPlease run "elizaos plugins update" to fetch the latest plugin registry.');
    return;
  }

  let availablePluginsToDisplay: string[] = [];
  const allPlugins = cachedRegistry ? Object.entries(cachedRegistry.registry) : [];
  let displayTitle = 'Available v1.x plugins';

  if (opts.all) {
    displayTitle = 'All plugins in local cache (detailed view)';
    if (allPlugins.length === 0) {
      console.log('No plugins found in the registry.');
    }
    allPlugins.forEach(([name, info]) => {
      console.log(`\nPlugin: ${name}`);
      const repoInfo = info.git?.repo || info.npm?.repo;
      console.log(`  Repository: ${repoInfo || 'N/A'}`);
      console.log(`  v0 Compatible: ${info.supports.v0 ? 'Yes' : 'No'}`);
      if (info.npm?.v0 || info.git?.v0?.version) {
        const ver = info.npm?.v0 || info.git?.v0?.version;
        const branch = info.git?.v0?.branch;
        console.log(`    Version: ${ver || 'N/A'}${branch ? ` (branch: ${branch})` : ''}`);
      }
      console.log(`  v1 Compatible: ${info.supports.v1 ? 'Yes' : 'No'}`);
      if (info.npm?.v1 || info.git?.v1?.version) {
        const ver = info.npm?.v1 || info.git?.v1?.version;
        const branch = info.git?.v1?.branch;
        console.log(`    Version: ${ver || 'N/A'}${branch ? ` (branch: ${branch})` : ''}`);
      }
    });
    console.log('');
    return;
  } else if (opts.v0) {
    displayTitle = 'Available v0.x plugins';
    availablePluginsToDisplay = allPlugins
      .filter(([, info]) => info.supports.v0)
      .map(([name]) => name);
  } else {
    // Default to v1.x
    availablePluginsToDisplay = allPlugins
      .filter(([, info]) => info.supports.v1)
      .map(([name]) => name);
  }

  logHeader(displayTitle);
  if (availablePluginsToDisplay.length === 0) {
    console.log('No plugins found matching the criteria in the registry.');
  } else {
    for (const pluginName of availablePluginsToDisplay) {
      console.log(`${pluginName}`);
    }
  }
  console.log('');
}


