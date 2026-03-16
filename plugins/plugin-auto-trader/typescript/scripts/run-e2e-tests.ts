#!/usr/bin/env bun

import { autoTraderPlugin } from '../src/index.js';

console.log('\n🧪 Auto-Trader Plugin E2E Test Summary');
console.log('=====================================\n');

if (autoTraderPlugin.tests && autoTraderPlugin.tests.length > 0) {
  console.log(`Found ${autoTraderPlugin.tests.length} test suites:\n`);
  
  let totalTests = 0;
  autoTraderPlugin.tests.forEach((suite, index) => {
    const testCount = suite.tests?.length || 0;
    totalTests += testCount;
    console.log(`${index + 1}. ${suite.name} (${testCount} tests)`);
    if (suite.tests && suite.tests.length > 0) {
      suite.tests.forEach((test) => {
        console.log(`   • ${test.name}`);
      });
    }
    console.log('');
  });
  
  console.log(`\n📊 Total: ${totalTests} tests across ${autoTraderPlugin.tests.length} suites`);
  
  console.log('\n✅ Tests are properly configured and ready to run!');
  console.log('\nTo run these tests, use:');
  console.log('  elizaos test\n');
} else {
  console.log('❌ No tests found in plugin');
  console.log('\nTests should be exported in the plugin\'s tests property');
} 