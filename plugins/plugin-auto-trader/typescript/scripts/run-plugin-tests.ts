#!/usr/bin/env bun

import { elizaLogger } from '@elizaos/core';
import autoTraderPlugin from '../src/index.ts';

async function runPluginTests() {
  console.log('\n🔍 Checking plugin tests...\n');
  
  console.log('Plugin name:', autoTraderPlugin.name);
  console.log('Plugin description:', autoTraderPlugin.description);
  console.log('Number of tests:', autoTraderPlugin.tests?.length || 0);
  
  if (autoTraderPlugin.tests && autoTraderPlugin.tests.length > 0) {
    console.log('\n📋 Available test suites:');
    autoTraderPlugin.tests.forEach((suite, index) => {
      console.log(`  ${index + 1}. ${suite.name} (${suite.tests.length} tests)`);
    });
    
    console.log('\n✅ Plugin tests are properly configured!');
    console.log('\nTo run these tests, use:');
    console.log('  elizaos test');
    console.log('  elizaos test --name "Auto Trading Core Scenarios"');
    console.log('  elizaos test --name "Mock Trading"');
  } else {
    console.log('\n❌ No tests found in plugin!');
  }
}

runPluginTests().catch(console.error); 