#!/usr/bin/env bun
/**
 * Migrate plugin package.json files from root to typescript/ folder
 * Updates all paths accordingly
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';

const pluginsDir = join(import.meta.dir, '..', 'plugins');

interface PackageJson {
  name: string;
  scripts?: Record<string, string>;
  exports?: Record<string, unknown>;
  files?: string[];
  main?: string;
  module?: string;
  types?: string;
  browser?: string;
  [key: string]: unknown;
}

function updateScripts(scripts: Record<string, string>): Record<string, string> {
  const updated: Record<string, string> = {};
  
  for (const [key, value] of Object.entries(scripts)) {
    let newValue = value;
    
    // Remove "cd typescript && " prefix
    newValue = newValue.replace(/cd typescript && /g, '');
    
    // Update test paths from "typescript/__tests__/" to "__tests__/"
    newValue = newValue.replace(/typescript\/__tests__\//g, '__tests__/');
    
    // Update paths like "./typescript" to "."
    newValue = newValue.replace(/\.\/typescript\b/g, '.');
    
    // Update paths that go up to rust/python
    newValue = newValue.replace(/cd rust\b/g, 'cd ../rust');
    newValue = newValue.replace(/cd python\b/g, 'cd ../python');
    
    updated[key] = newValue;
  }
  
  return updated;
}

function updateExports(exports: Record<string, unknown>): Record<string, unknown> {
  const updated: Record<string, unknown> = {};
  
  for (const [key, value] of Object.entries(exports)) {
    if (typeof value === 'string') {
      // Update paths like "./typescript/dist/" to "./dist/"
      let newValue = value.replace(/\.\/typescript\/dist\//g, './dist/');
      // Update rust paths
      newValue = newValue.replace(/\.\/rust\//g, '../rust/');
      updated[key] = newValue;
    } else if (typeof value === 'object' && value !== null) {
      updated[key] = updateExports(value as Record<string, unknown>);
    } else {
      updated[key] = value;
    }
  }
  
  return updated;
}

function updateFiles(files: string[]): string[] {
  return files.map(file => {
    // Update paths like "typescript/dist" to "dist"
    let newFile = file.replace(/^typescript\/dist/, 'dist');
    // Update rust paths
    newFile = newFile.replace(/^rust\//, '../rust/');
    return newFile;
  });
}

function updateMainPaths(pkg: PackageJson): PackageJson {
  const pathFields = ['main', 'module', 'types', 'browser'];
  
  for (const field of pathFields) {
    if (pkg[field] && typeof pkg[field] === 'string') {
      pkg[field] = (pkg[field] as string).replace(/^typescript\/dist\//, 'dist/');
    }
  }
  
  return pkg;
}

function migratePlugin(pluginName: string): boolean {
  const pluginDir = join(pluginsDir, pluginName);
  const rootPackageJson = join(pluginDir, 'package.json');
  const typescriptDir = join(pluginDir, 'typescript');
  const typescriptPackageJson = join(typescriptDir, 'package.json');
  
  // Skip if no root package.json
  if (!existsSync(rootPackageJson)) {
    console.log(`⏭️  ${pluginName}: No root package.json, skipping`);
    return false;
  }
  
  // Skip if already has typescript/package.json
  if (existsSync(typescriptPackageJson)) {
    console.log(`⏭️  ${pluginName}: Already has typescript/package.json, skipping`);
    return false;
  }
  
  // Skip if no typescript directory
  if (!existsSync(typescriptDir)) {
    console.log(`⏭️  ${pluginName}: No typescript directory, skipping`);
    return false;
  }
  
  try {
    // Read and parse root package.json
    const content = readFileSync(rootPackageJson, 'utf-8');
    const pkg: PackageJson = JSON.parse(content);
    
    // Update scripts
    if (pkg.scripts) {
      pkg.scripts = updateScripts(pkg.scripts);
    }
    
    // Update exports
    if (pkg.exports) {
      pkg.exports = updateExports(pkg.exports as Record<string, unknown>);
    }
    
    // Update files
    if (pkg.files) {
      pkg.files = updateFiles(pkg.files);
    }
    
    // Update main/module/types paths
    updateMainPaths(pkg);
    
    // Write to typescript/package.json
    writeFileSync(typescriptPackageJson, JSON.stringify(pkg, null, 2) + '\n');
    
    // Delete root package.json
    unlinkSync(rootPackageJson);
    
    // Delete bun.lock if exists
    const bunLock = join(pluginDir, 'bun.lock');
    if (existsSync(bunLock)) {
      unlinkSync(bunLock);
    }
    
    console.log(`✅ ${pluginName}: Migrated successfully`);
    return true;
  } catch (error) {
    console.error(`❌ ${pluginName}: Migration failed - ${error}`);
    return false;
  }
}

// Get list of plugins
const plugins = readdirSync(pluginsDir, { withFileTypes: true })
  .filter(dirent => dirent.isDirectory() && dirent.name.startsWith('plugin-'))
  .map(dirent => dirent.name);

console.log(`Found ${plugins.length} plugins\n`);

let migrated = 0;
let skipped = 0;
let failed = 0;

for (const plugin of plugins) {
  const result = migratePlugin(plugin);
  if (result) {
    migrated++;
  } else {
    skipped++;
  }
}

console.log(`\n📊 Migration complete:`);
console.log(`   ✅ Migrated: ${migrated}`);
console.log(`   ⏭️  Skipped: ${skipped}`);
console.log(`   ❌ Failed: ${failed}`);

