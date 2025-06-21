#!/usr/bin/env node

// Simple test to verify the loadProject behavior
import fs from 'fs';
import path from 'path';

// Mock logger
const logger = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.log('[WARN]', ...args),
  error: (...args) => console.log('[ERROR]', ...args),
  debug: (...args) => console.log('[DEBUG]', ...args),
};

// Simplified version of loadProject to test the logic
async function testLoadProject(dir) {
  try {
    // Get the package.json and get the main field
    const packageJson = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const main = packageJson.main;
    
    if (!main) {
      logger.warn('No main field found in package.json');
      throw new Error('No main field in package.json');
    }

    // Only try the main field entry point - no fallbacks to source files
    const entryPoint = path.join(dir, main);
    
    if (!fs.existsSync(entryPoint)) {
      logger.error(`Module entry point not found: ${entryPoint}`);
      logger.error(`The main field in package.json points to "${main}" but this file doesn't exist.`);
      logger.error('Please build your project first. Try running:');
      logger.error('  npm run build');
      logger.error('  or');
      logger.error('  bun run build');
      throw new Error(`Module not found: ${main}. Please build your project first.`);
    }

    logger.info(`Module found at: ${entryPoint}`);
    return { success: true, entryPoint };
  } catch (error) {
    throw error;
  }
}

// Run the test
async function runTest() {
  console.log('Testing loadProject behavior with missing dist directory...\n');
  
  try {
    const result = await testLoadProject(process.cwd());
    console.log('\n❌ FAIL: Should have thrown an error for missing dist');
  } catch (error) {
    console.log('\n✅ SUCCESS: Got expected error');
    console.log('Error message:', error.message);
    
    // Verify the error message is correct
    if (error.message.includes('Module not found') && error.message.includes('Please build your project first')) {
      console.log('✅ Error message format is correct!');
    } else {
      console.log('❌ Error message format is incorrect');
    }
  }
}

runTest(); 