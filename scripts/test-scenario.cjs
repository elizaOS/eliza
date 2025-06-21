#!/usr/bin/env node

// Simple test to verify our rolodex actions work with trust integration
const { spawn } = require('child_process');
const fs = require('fs');

console.log('Testing Rolodex with Trust Integration...\n');

// Test by starting the agent and attempting to run a simple CREATE_ENTITY action
const testCharacter = './test-trust-rolodex-character.json';

if (!fs.existsSync(testCharacter)) {
  console.error('Test character file not found:', testCharacter);
  process.exit(1);
}

console.log('✓ Character file exists');

// Try to start the agent
console.log('Starting agent with trust and rolodex plugins...');

const elizaos = spawn('elizaos', ['start', '--character', testCharacter], {
  stdio: 'pipe',
  env: { ...process.env, NODE_ENV: 'test' }
});

let output = '';
let errorOutput = '';

elizaos.stdout.on('data', (data) => {
  const text = data.toString();
  output += text;
  console.log('[STDOUT]', text.trim());
});

elizaos.stderr.on('data', (data) => {
  const text = data.toString();
  errorOutput += text;
  console.log('[STDERR]', text.trim());
});

elizaos.on('close', (code) => {
  console.log(`\nAgent process exited with code ${code}`);
  
  // Check if trust services started
  if (output.includes('TrustService') || output.includes('trust') || output.includes('SecurityModule')) {
    console.log('✓ Trust services detected in output');
  } else {
    console.log('✗ Trust services not found in output');
  }
  
  // Check if rolodex services started
  if (output.includes('rolodex') || output.includes('entity') || output.includes('relationship')) {
    console.log('✓ Rolodex services detected in output');
  } else {
    console.log('✗ Rolodex services not found in output');
  }
  
  // Check for specific actions
  if (output.includes('CREATE_ENTITY') || output.includes('CREATE_RELATIONSHIP') || output.includes('QUERY_RELATIONSHIPS')) {
    console.log('✓ Required actions detected');
  } else {
    console.log('✗ Required actions not found');
  }
  
  if (code === 0) {
    console.log('\n✅ Test completed successfully');
  } else {
    console.log('\n❌ Test failed with errors');
  }
});

// Kill the process after 10 seconds
setTimeout(() => {
  elizaos.kill('SIGTERM');
}, 10000);