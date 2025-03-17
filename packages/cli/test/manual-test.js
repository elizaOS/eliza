#!/usr/bin/env node

/**
 * Manual test script for plugin publishing
 *
 * This script:
 * 1. Creates a test plugin
 * 2. Sets up package.json with required fields
 * 3. Tests the publishing command with dry run
 *
 * Usage:
 *   node test/manual-test.js
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_PLUGIN_DIR = path.resolve(__dirname, '../.test-plugin');

/**
 * Create a test plugin directory
 */
async function createTestPlugin() {
  console.log('Creating test plugin...');

  // Create plugin directory
  try {
    await fs.mkdir(TEST_PLUGIN_DIR, { recursive: true });
  } catch (err) {
    // Directory already exists
  }

  // Create package.json
  const packageJson = {
    name: '@elizaos/plugin-test-publish',
    version: '1.0.0',
    description: 'Test plugin for publish command',
    author: 'Test Author',
    keywords: ['test', 'elizaos-plugin'],
    categories: ['test', 'utility'],
    platform: 'universal',
    repository: {
      type: 'git',
      url: 'github:elizaos/plugin-test-publish',
    },
    main: 'dist/index.js',
    scripts: {
      build: 'echo "Build completed"',
    },
  };

  await fs.writeFile(
    path.join(TEST_PLUGIN_DIR, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  );

  // Create an index.js file
  await fs.writeFile(
    path.join(TEST_PLUGIN_DIR, 'index.js'),
    `console.log('Test plugin loaded');
module.exports = {
  name: 'test-plugin',
  actions: []
};`
  );

  console.log('Test plugin created at:', TEST_PLUGIN_DIR);
}

/**
 * Test publish command
 */
async function testPublishCommand() {
  console.log('\nTesting plugin publish command (dry run)...');

  try {
    execSync('npx @elizaos/cli plugin publish --test --platform universal', {
      cwd: TEST_PLUGIN_DIR,
      stdio: 'inherit',
    });
    console.log('Publish test completed successfully!');
  } catch (error) {
    console.error('Publish test failed:', error.message);
    process.exit(1);
  }
}

/**
 * Run manual test
 */
async function runManualTest() {
  try {
    await createTestPlugin();
    await testPublishCommand();

    console.log('\nAll manual tests completed successfully!');
    console.log(`You can find the test plugin at: ${TEST_PLUGIN_DIR}`);
    console.log('To remove the test plugin, run: rm -rf', TEST_PLUGIN_DIR);
  } catch (error) {
    console.error('Manual test failed:', error.message);
    process.exit(1);
  }
}

runManualTest();
