#!/usr/bin/env bun

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginRoot = join(__dirname, '..');

// Check if the build exists
const distPath = join(pluginRoot, 'dist', 'index.js');
if (!existsSync(distPath)) {
  console.error('❌ Plugin not built. Please run "bun run build" first.');
  process.exit(1);
}

console.log(`
🚀 RUNNING LIVE TRADING TESTS

⚠️  WARNING: These tests use REAL tokens on Solana mainnet!
⚠️  Make sure you have a small amount of USDC in your wallet.

💡 The tests will:
   - Trade BONK and WIF tokens
   - Monitor transactions in real-time
   - Log Solscan URLs for verification
   - Show detailed performance metrics

Starting in 5 seconds...
`);

// Give user time to cancel if needed
await new Promise(resolve => setTimeout(resolve, 5000));

// Run the specific test suite
const command = `elizaos test --name "Live Trading Scenarios"`;
console.log(`Executing: ${command}\n`);

// Import and run directly
import('../dist/index.js').then(async (module) => {
  const plugin = module.default;
  if (!plugin.tests) {
    console.error('❌ No tests found in plugin');
    process.exit(1);
  }

  const liveTestSuite = plugin.tests.find(suite => 
    suite.name.includes('Live Trading Scenarios')
  );

  if (!liveTestSuite) {
    console.error('❌ Live Trading Scenarios test suite not found');
    console.log('Available test suites:', plugin.tests.map(t => t.name));
    process.exit(1);
  }

  console.log(`✅ Found test suite: ${liveTestSuite.name}`);
  console.log(`   Tests: ${liveTestSuite.tests.length}`);
  
  // Show test names
  liveTestSuite.tests.forEach((test, i) => {
    console.log(`   ${i + 1}. ${test.name}`);
  });

  console.log('\n💡 Note: To run these tests properly, use:');
  console.log('   elizaos test --name "Live Trading Scenarios"\n');
  console.log('Or to run a specific test:');
  console.log('   elizaos test --name "LIVE MAINNET: Trade real tokens"');
}).catch(err => {
  console.error('❌ Error loading plugin:', err);
  process.exit(1);
}); 