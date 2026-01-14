#!/usr/bin/env bun

import { autoTraderPlugin } from '../src/index.js';

console.log('\n🧪 Auto-Trader Plugin Test Scenarios');
console.log('=====================================\n');

if (autoTraderPlugin.tests && autoTraderPlugin.tests.length > 0) {
  console.log('Available test suites:\n');
  
  autoTraderPlugin.tests.forEach((suite, index) => {
    console.log(`${index + 1}. ${suite.name}`);
    if (suite.tests && suite.tests.length > 0) {
      suite.tests.forEach((test) => {
        console.log(`   • ${test.name}`);
      });
      console.log(''); // Add spacing between suites
    }
  });
  
  console.log('\n📚 How to run tests:\n');
  
  console.log('Run all E2E tests:');
  console.log('  elizaos test --e2e\n');
  
  console.log('Run specific test suite:');
  console.log('  elizaos test --name "<test suite name>"\n');
  
  console.log('Examples:');
  console.log('  # Mock testing (no real funds needed)');
  console.log('  elizaos test --name "Mock Trading Scenarios"\n');
  
  console.log('  # Agent conversation testing');
  console.log('  elizaos test --name "Agent Live Trading Scenario"\n');
  
  console.log('  # Live trading tests (requires wallet setup)');
  console.log('  elizaos test --name "Live Trading E2E Tests"\n');
  
  console.log('💡 Tip: Start with mock tests for development!\n');
} else {
  console.log('❌ No tests found in plugin');
  console.log('\nMake sure the plugin is built:');
  console.log('  bun run build\n');
} 