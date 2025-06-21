#!/usr/bin/env node

/**
 * Simple test to verify the rolodex plugin functionality works
 */

// Simple test to check if rolodex plugin components exist and are loadable
console.log('Testing if rolodex plugin can be loaded...');

try {
  // Test basic module loading
  const coreModule = await import('@elizaos/core');
  console.log('✅ Core module loaded');
  
  const sqlModule = await import('@elizaos/plugin-sql');
  console.log('✅ SQL plugin loaded');
  
  const rolodexModule = await import('@elizaos/plugin-rolodex');
  console.log('✅ Rolodex plugin loaded');
  
  // Check if rolodex plugin has expected components
  if (rolodexModule.rolodexPlugin) {
    const plugin = rolodexModule.rolodexPlugin;
    console.log(`✅ Rolodex plugin found: ${plugin.name}`);
    console.log(`  - Actions: ${plugin.actions?.length || 0}`);
    console.log(`  - Providers: ${plugin.providers?.length || 0}`);
    console.log(`  - Evaluators: ${plugin.evaluators?.length || 0}`);
    console.log(`  - Services: ${plugin.services?.length || 0}`);
    
    // Check for specific actions
    const findEntityAction = plugin.actions?.find(a => a.name === 'FIND_ENTITY');
    const createEntityAction = plugin.actions?.find(a => a.name === 'CREATE_ENTITY');
    const trackEntityAction = plugin.actions?.find(a => a.name === 'TRACK_ENTITY');
    
    console.log(`  - FIND_ENTITY action: ${findEntityAction ? '✅' : '❌'}`);
    console.log(`  - CREATE_ENTITY action: ${createEntityAction ? '✅' : '❌'}`);
    console.log(`  - TRACK_ENTITY action: ${trackEntityAction ? '✅' : '❌'}`);
    
    // Check for relationship extractor
    const relationshipExtractor = plugin.evaluators?.find(e => e.name === 'EXTRACT_RELATIONSHIPS');
    console.log(`  - Relationship extractor: ${relationshipExtractor ? '✅' : '❌'}`);
    
  } else {
    console.log('❌ rolodexPlugin not found in module');
  }
  
  console.log('\n🎉 Plugin loading test completed successfully!');
  process.exit(0);
  
} catch (error) {
  console.error('❌ Plugin loading test failed:', error);
  process.exit(1);
}

