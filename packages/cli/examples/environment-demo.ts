#!/usr/bin/env bun

/**
 * Demo script to show environment normalization in action
 *
 * Run this with:
 * - bun run examples/environment-demo.ts (TypeScript environment)
 * - node dist/examples/environment-demo.js (JavaScript environment)
 */

import {
  detectRuntimeEnvironment,
  getEnvironmentConfig,
  normalizeImportPath,
  isMonorepoContext,
} from '../src/utils/environment-normalization';

console.log('=== ElizaOS Environment Normalization Demo ===\n');

// Detect runtime environment
const runtime = detectRuntimeEnvironment();
console.log(`Runtime Environment: ${runtime}`);
console.log(`Running with: ${process.execPath}\n`);

// Get full environment config
const config = getEnvironmentConfig();
console.log('Environment Configuration:');
console.log(`- TypeScript Support: ${config.isTypeScript}`);
console.log(`- Monorepo Context: ${config.isMonorepo}`);
console.log(`- Requires .js Extensions: ${config.requiresJsExtensions}`);
console.log(`- Can Run TypeScript: ${config.canRunTypeScriptDirectly}\n`);

// Show import path normalization
console.log('Import Path Normalization Examples:');
const testPaths = [
  './utils',
  '../lib/helper',
  './actions/myAction',
  '@elizaos/core',
  'lodash',
  './data.json',
  './script.js',
];

testPaths.forEach((path) => {
  const normalized = normalizeImportPath(path);
  if (path !== normalized) {
    console.log(`  ${path} → ${normalized} ✓`);
  } else {
    console.log(`  ${path} (unchanged)`);
  }
});

// Show practical example
console.log('\n=== Practical Example ===\n');

if (config.isTypeScript) {
  console.log('You are in TypeScript environment. You can:');
  console.log('- Import .ts files directly without extensions');
  console.log('- Use bun run for development');
  console.log('- Access TypeScript source files');
  console.log('\nExample:');
  console.log("  import { myAction } from './actions/myAction';");
  console.log('  This will work and load ./actions/myAction.ts');
} else {
  console.log('You are in JavaScript environment. You must:');
  console.log('- Add .js extensions to all relative imports');
  console.log('- Use the built CLI (elizaos command)');
  console.log('- Work with compiled JavaScript files');
  console.log('\nExample:');
  console.log("  import { myAction } from './actions/myAction.js';");
  console.log('  The .js extension is required!');
}

// Show context-specific recommendations
console.log('\n=== Recommendations ===\n');

if (config.isMonorepo) {
  console.log('Monorepo Development:');
  console.log('- Use workspace: protocol for local packages');
  console.log('- Run from monorepo root for best results');
  console.log('- Local plugins will be resolved automatically');
} else {
  console.log('Standalone Project:');
  console.log('- Install packages from npm registry');
  console.log('- Build TypeScript before distribution');
  console.log('- Test with both bun and elizaos commands');
}

// Show current working directory context
console.log(`\nCurrent Directory: ${process.cwd()}`);
console.log(`Script Location: ${import.meta.url}\n`);

// Exit message
console.log('=== Demo Complete ===');
console.log('\nTo see different behavior, try running this script:');
console.log('1. With bun: bun run examples/environment-demo.ts');
console.log('2. After building: node dist/examples/environment-demo.js');
console.log('3. From different directories (monorepo root vs package)');
