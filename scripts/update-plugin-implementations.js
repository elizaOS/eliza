#!/usr/bin/env node
/**
 * Update plugin implementations to use centralized specs
 * 
 * For each action/provider file, adds the import and updates name/similes/description
 */

import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function updateActionFile(filePath, actionName) {
  let content = fs.readFileSync(filePath, "utf-8");
  
  // Skip if already updated
  if (content.includes("requireActionSpec")) {
    return false;
  }
  
  // Add import after @elizaos/core imports
  const importMatch = content.match(/(import.*from "@elizaos\/core";)/);
  if (importMatch) {
    const importLine = importMatch[1];
    const newImport = `${importLine}\nimport { requireActionSpec } from "../generated/specs/spec-helpers";`;
    content = content.replace(importLine, newImport);
  }
  
  // Add spec constant before export
  const exportMatch = content.match(/(export\s+(?:const|default)\s+\w+:\s*Action\s*=\s*\{)/);
  if (exportMatch) {
    const exportLine = exportMatch[1];
    const specLine = `const spec = requireActionSpec("${actionName}");\n\n${exportLine}`;
    content = content.replace(exportLine, specLine);
  }
  
  // Update name
  content = content.replace(/name:\s*["'][^"']+["']/, `name: spec.name`);
  
  // Update similes
  const similesMatch = content.match(/similes:\s*\[([\s\S]*?)\]/);
  if (similesMatch) {
    content = content.replace(/similes:\s*\[[\s\S]*?\]/, `similes: spec.similes ?? []`);
  }
  
  // Update description
  content = content.replace(/description:\s*["'][^"']+["']/, `description: spec.description`);
  
  // Update examples if present
  if (content.includes("examples:")) {
    const examplesMatch = content.match(/examples:\s*(\[[\s\S]*?\])\s*as\s*ActionExample\[\]\[\]/);
    if (examplesMatch) {
      content = content.replace(examplesMatch[0], `examples: (spec.examples ?? []) as ActionExample[][]`);
    }
  }
  
  fs.writeFileSync(filePath, content);
  return true;
}

function updateProviderFile(filePath, providerName) {
  let content = fs.readFileSync(filePath, "utf-8");
  
  // Skip if already updated
  if (content.includes("requireProviderSpec")) {
    return false;
  }
  
  // Add import after @elizaos/core imports
  const importMatch = content.match(/(import.*from "@elizaos\/core";)/);
  if (importMatch) {
    const importLine = importMatch[1];
    const newImport = `${importLine}\nimport { requireProviderSpec } from "../generated/specs/spec-helpers";`;
    content = content.replace(importLine, newImport);
  }
  
  // Add spec constant before export
  const exportMatch = content.match(/(export\s+(?:const|default)\s+\w+:\s*Provider\s*=\s*\{)/);
  if (exportMatch) {
    const exportLine = exportMatch[1];
    const specLine = `const spec = requireProviderSpec("${providerName}");\n\n${exportLine}`;
    content = content.replace(exportLine, specLine);
  }
  
  // Update name
  content = content.replace(/name:\s*["'][^"']+["']/, `name: spec.name`);
  
  fs.writeFileSync(filePath, content);
  return true;
}

function processPlugin(pluginName) {
  const pluginPath = path.join(REPO_ROOT, "plugins", pluginName);
  const actionsPath = path.join(pluginPath, "typescript", "actions");
  const providersPath = path.join(pluginPath, "typescript", "providers");
  
  let updated = 0;
  
  // Process actions
  if (fs.existsSync(actionsPath)) {
    const actionFiles = fs.readdirSync(actionsPath)
      .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("__"));
    
    for (const file of actionFiles) {
      const filePath = path.join(actionsPath, file);
      // Extract action name from file (e.g., sendMessage.ts -> SEND_MESSAGE)
      const baseName = file.replace(/\.ts$/, "");
      // Convert camelCase to UPPER_SNAKE_CASE
      const actionName = baseName
        .replace(/([A-Z])/g, "_$1")
        .replace(/^_/, "")
        .toUpperCase();
      
      if (updateActionFile(filePath, actionName)) {
        updated++;
        console.log(`  Updated action: ${file} (${actionName})`);
      }
    }
  }
  
  // Process providers
  if (fs.existsSync(providersPath)) {
    const providerFiles = fs.readdirSync(providersPath)
      .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("__"));
    
    for (const file of providerFiles) {
      const filePath = path.join(providersPath, file);
      // Extract provider name from file (e.g., channelState.ts -> channelState)
      const baseName = file.replace(/\.ts$/, "");
      const providerName = baseName;
      
      if (updateProviderFile(filePath, providerName)) {
        updated++;
        console.log(`  Updated provider: ${file} (${providerName})`);
      }
    }
  }
  
  return updated;
}

function main() {
  const pluginName = process.argv[2] || "plugin-discord";
  
  console.log(`\n=== Updating implementations for ${pluginName} ===\n`);
  
  const updated = processPlugin(pluginName);
  
  console.log(`\n✅ Updated ${updated} files`);
}

main();
