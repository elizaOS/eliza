#!/usr/bin/env node
/**
 * Fix type errors across all plugins
 * 
 * Common fixes:
 * - Add missing imports for spec-helpers
 * - Fix readonly array issues with similes
 * - Fix duplicate imports
 */

import fs from "node:fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function getAllPlugins() {
  const pluginsPath = path.join(REPO_ROOT, "plugins");
  return fs.readdirSync(pluginsPath)
    .filter(f => {
      const fullPath = path.join(pluginsPath, f);
      return fs.statSync(fullPath).isDirectory() && f.startsWith("plugin-");
    })
    .sort();
}

function fixPluginTypes(pluginName) {
  const pluginPath = path.join(REPO_ROOT, "plugins", pluginName);
  const tsPath = path.join(pluginPath, "typescript");
  
  if (!fs.existsSync(tsPath)) {
    return { fixed: 0, errors: [] };
  }
  
  const actionsPath = path.join(tsPath, "actions");
  const providersPath = path.join(tsPath, "providers");
  
  let fixed = 0;
  const errors = [];
  
  // Fix action files
  if (fs.existsSync(actionsPath)) {
    const actionFiles = fs.readdirSync(actionsPath)
      .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    
    for (const file of actionFiles) {
      const filePath = path.join(actionsPath, file);
      let content = fs.readFileSync(filePath, "utf-8");
      let modified = false;
      
      // Fix duplicate imports
      const importMatches = content.matchAll(/import\s+.*requireActionSpec.*from.*spec-helpers/g);
      const imports = Array.from(importMatches);
      if (imports.length > 1) {
        // Keep only the first import
        const firstImport = imports[0][0];
        content = content.replace(new RegExp(`import\\s+.*requireActionSpec.*from.*spec-helpers[^;]*;`, 'g'), '');
        // Find a good place to insert (after @elizaos/core imports)
        const coreImportMatch = content.match(/(import.*from "@elizaos\/core";)/);
        if (coreImportMatch) {
          content = content.replace(coreImportMatch[1], `${coreImportMatch[1]}\nimport { requireActionSpec } from "../generated/specs/spec-helpers";`);
        }
        modified = true;
      }
      
      // Fix readonly similes
      if (content.includes('similes: spec.similes ?? []') && !content.includes('[...spec.similes]')) {
        content = content.replace(/similes:\s*spec\.similes\s*\?\?\s*\[\]/g, 'similes: spec.similes ? [...spec.similes] : []');
        modified = true;
      }
      
      // Add missing import if requireActionSpec is used but not imported
      if (content.includes('requireActionSpec') && !content.includes('from "../generated/specs/spec-helpers"')) {
        const coreImportMatch = content.match(/(import.*from "@elizaos\/core";)/);
        if (coreImportMatch) {
          content = content.replace(coreImportMatch[1], `${coreImportMatch[1]}\nimport { requireActionSpec } from "../generated/specs/spec-helpers";`);
          modified = true;
        }
      }
      
      if (modified) {
        fs.writeFileSync(filePath, content);
        fixed++;
      }
    }
  }
  
  // Fix provider files
  if (fs.existsSync(providersPath)) {
    const providerFiles = fs.readdirSync(providersPath)
      .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    
    for (const file of providerFiles) {
      const filePath = path.join(providersPath, file);
      let content = fs.readFileSync(filePath, "utf-8");
      let modified = false;
      
      // Add missing import if requireProviderSpec is used but not imported
      if (content.includes('requireProviderSpec') && !content.includes('from "../generated/specs/spec-helpers"')) {
        const coreImportMatch = content.match(/(import.*from "@elizaos\/core";)/);
        if (coreImportMatch) {
          content = content.replace(coreImportMatch[1], `${coreImportMatch[1]}\nimport { requireProviderSpec } from "../generated/specs/spec-helpers";`);
          modified = true;
        }
      }
      
      if (modified) {
        fs.writeFileSync(filePath, content);
        fixed++;
      }
    }
  }
  
  return { fixed, errors };
}

function checkTypeErrors(pluginName) {
  const pluginPath = path.join(REPO_ROOT, "plugins", pluginName);
  const tsConfig = path.join(pluginPath, "typescript", "tsconfig.json");
  
  if (!fs.existsSync(tsConfig)) {
    return 0;
  }
  
  try {
    const output = execSync(`npx tsc --noEmit --project ${tsConfig}`, {
      cwd: path.join(pluginPath, "typescript"),
      stdio: 'pipe',
      encoding: 'utf-8'
    });
    return 0;
  } catch (e) {
    const errorOutput = e.stdout + e.stderr;
    const errorCount = (errorOutput.match(/error TS\d+/g) || []).length;
    return errorCount;
  }
}

function main() {
  const plugins = getAllPlugins();
  console.log(`\n=== Fixing type errors across ${plugins.length} plugins ===\n`);
  
  const results = {
    total: plugins.length,
    fixed: 0,
    withErrors: 0,
    errorDetails: [],
  };
  
  for (const plugin of plugins) {
    const { fixed } = fixPluginTypes(plugin);
    if (fixed > 0) {
      results.fixed += fixed;
      console.log(`[${plugin}] Fixed ${fixed} files`);
    }
    
    const errorCount = checkTypeErrors(plugin);
    if (errorCount > 0) {
      results.withErrors++;
      results.errorDetails.push({ plugin, errors: errorCount });
      console.log(`[${plugin}] ⚠️  ${errorCount} type errors remaining`);
    }
  }
  
  console.log(`\n\n=== Summary ===`);
  console.log(`Total plugins: ${results.total}`);
  console.log(`Files fixed: ${results.fixed}`);
  console.log(`Plugins with errors: ${results.withErrors}`);
  
  if (results.errorDetails.length > 0) {
    console.log(`\nPlugins needing attention:`);
    results.errorDetails.slice(0, 10).forEach(({ plugin, errors }) => {
      console.log(`  - ${plugin}: ${errors} errors`);
    });
  }
}

main();
