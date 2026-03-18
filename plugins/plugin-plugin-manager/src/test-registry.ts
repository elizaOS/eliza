/**
 * Test script for plugin manager integration with API service
 */

import {
  searchPluginsByContent,
  getPluginDetails,
  getAllPlugins,
} from './services/pluginRegistryService.js';

async function testPluginManagerIntegration() {
  console.log('🔍 Testing Plugin Manager Integration with API Service...\n');

  try {
    // Test 1: Search for plugins
    console.log('Test 1: Searching for plugins with "blockchain"...');
    const searchResult = await searchPluginsByContent('blockchain');
    const searchResults = searchResult.data;
    console.log(`Found ${searchResults.length} plugins:`);
    searchResults.forEach((plugin, index) => {
      console.log(`${index + 1}. ${plugin.name} - ${plugin.description}`);
      if (plugin.score) console.log(`   Score: ${plugin.score}`);
      if (plugin.tags) console.log(`   Tags: ${plugin.tags.join(', ')}`);
    });
    console.log('');

    // Test 2: Get plugin details
    if (searchResults.length > 0) {
      const pluginName = searchResults[0].name;
      console.log(`Test 2: Getting details for "${pluginName}"...`);
      const detailsResult = await getPluginDetails(pluginName);
      const details = detailsResult.data;
      if (details) {
        console.log(`Details for ${details.name}:`);
        console.log(`  Description: ${details.description}`);
        console.log(`  Version: ${details.latestVersion}`);
        console.log(`  Repository: ${details.repository || 'N/A'}`);
      } else {
        console.log('❌ Failed to get plugin details');
      }
      console.log('');
    }

    // Test 3: Get all plugins
    console.log('Test 3: Getting all plugins...');
    const allPluginsResult = await getAllPlugins();
    const allPlugins = allPluginsResult.data;
    console.log(`Total plugins in registry: ${allPlugins.length}`);
    allPlugins.forEach((plugin, index) => {
      console.log(`${index + 1}. ${plugin.name} (${plugin.latestVersion})`);
    });
    console.log('');

    console.log('✅ All tests completed successfully!');
  } catch (error) {
    console.error('❌ Test failed:', error);
  }
}

// Run if called directly
if (import.meta.main) {
  testPluginManagerIntegration().catch(console.error);
}
