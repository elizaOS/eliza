#!/usr/bin/env node

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

console.log('🧪 Direct Rolodex Plugin Test');
console.log('===============================');

// Change to the plugin directory
const pluginDir = join(__dirname, 'packages', 'plugin-rolodex');

console.log(`📁 Testing plugin at: ${pluginDir}`);
console.log('');

// Run the test with direct bun execution
const testProcess = spawn('bun', ['run', 'test'], {
  cwd: pluginDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_ENV: 'test',
    PGLITE_DATA_DIR: join(pluginDir, '.test-db'),
  }
});

testProcess.on('close', (code) => {
  console.log('');
  if (code === 0) {
    console.log('✅ Rolodex plugin tests passed!');
  } else {
    console.log('❌ Rolodex plugin tests failed with code:', code);
  }
  
  process.exit(code);
});

testProcess.on('error', (error) => {
  console.error('❌ Error running tests:', error);
  process.exit(1);
});