#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

console.log('Testing workspace plugin loading...\n');

// Test 1: Check if plugins are built
const plugins = [
  '@elizaos/plugin-autocoder',
  '@elizaos/plugin-secrets-manager', 
  '@elizaos/plugin-research'
];

console.log('1. Checking if plugins are built:');
for (const plugin of plugins) {
  const pluginName = plugin.replace('@elizaos/', '');
  const distPath = path.resolve(__dirname, '..', pluginName, 'dist', 'index.js');
  const exists = fs.existsSync(distPath);
  console.log(`   ${plugin}: ${exists ? '✅ Built' : '❌ Not built'} (${distPath})`);
}

// Test 2: Check current working directory
console.log('\n2. Current working directory:', process.cwd());
console.log('   Script directory:', __dirname);

// Test 3: Try direct imports
console.log('\n3. Testing direct imports:');
for (const plugin of plugins) {
  const pluginName = plugin.replace('@elizaos/', '');
  const distPath = path.resolve(__dirname, '..', pluginName, 'dist', 'index.js');
  
  try {
    const module = require(distPath);
    console.log(`   ${plugin}: ✅ Can import directly`);
    if (module.default || module[pluginName + 'Plugin']) {
      console.log(`      - Has default export or named plugin export`);
    }
  } catch (error) {
    console.log(`   ${plugin}: ❌ Cannot import - ${error.message}`);
  }
}

// Test 4: Check package.json workspace configuration
console.log('\n4. Checking workspace configuration:');
const rootPackageJsonPath = path.resolve(__dirname, '..', '..', 'package.json');
if (fs.existsSync(rootPackageJsonPath)) {
  const rootPackageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, 'utf8'));
  console.log('   Workspaces:', rootPackageJson.workspaces || 'Not configured');
}

// Test 5: Check node_modules symlinks
console.log('\n5. Checking node_modules for workspace symlinks:');
for (const plugin of plugins) {
  const nodeModulesPath = path.resolve(__dirname, 'node_modules', plugin);
  if (fs.existsSync(nodeModulesPath)) {
    const stats = fs.lstatSync(nodeModulesPath);
    if (stats.isSymbolicLink()) {
      const target = fs.readlinkSync(nodeModulesPath);
      console.log(`   ${plugin}: ✅ Symlinked to ${target}`);
    } else {
      console.log(`   ${plugin}: ⚠️  Exists but not a symlink`);
    }
  } else {
    console.log(`   ${plugin}: ❌ Not in node_modules`);
  }
} 