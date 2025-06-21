#!/usr/bin/env node

// Test script to verify plugin loading
const { loadPluginModule } = require('../cli/dist/utils-GMGEYQ25.js');

async function testPluginLoading() {
  console.log('Testing plugin loading...\n');
  
  const plugins = [
    '@elizaos/plugin-autocoder',
    '@elizaos/plugin-secrets-manager',
    '@elizaos/plugin-research'
  ];
  
  for (const plugin of plugins) {
    console.log(`Testing: ${plugin}`);
    try {
      const result = await loadPluginModule(plugin);
      if (result) {
        console.log(`✅ Successfully loaded ${plugin}`);
      } else {
        console.log(`❌ Failed to load ${plugin}`);
      }
    } catch (error) {
      console.log(`❌ Error loading ${plugin}:`, error.message);
    }
    console.log('');
  }
}

testPluginLoading().catch(console.error); 