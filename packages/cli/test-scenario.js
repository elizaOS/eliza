#!/usr/bin/env node

import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log('🚀 Starting CLI scenario testing...\n');

// Test basic conversation scenario (00)
console.log('📝 Testing basic conversation scenario (00)...');
try {
  const result = execSync('bun run dist/index.js scenario run 00 --verbose', {
    cwd: __dirname,
    timeout: 120000, // 2 minutes
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  console.log('✅ Basic conversation test completed');
  console.log('📊 Output length:', result.length, 'characters');
  
  // Check for success indicators
  if (result.includes('passed')) {
    console.log('✅ Test appears to have passed');
  } else if (result.includes('failed')) {
    console.log('❌ Test appears to have failed');
  }
  
  // Extract key metrics if available
  const durationMatch = result.match(/Duration:\s*(\d+)ms/);
  if (durationMatch) {
    console.log('⏱️  Duration:', durationMatch[1], 'ms');
  }
  
} catch (error) {
  console.error('❌ Basic conversation test failed:', error.message);
  if (error.stdout) {
    console.log('📝 Stdout:', error.stdout.toString().slice(-500)); // Last 500 chars
  }
  if (error.stderr) {
    console.log('📝 Stderr:', error.stderr.toString().slice(-500)); // Last 500 chars  
  }
}

console.log('\n🏁 Test script completed');