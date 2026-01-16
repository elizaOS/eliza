#!/usr/bin/env node
/**
 * Update all plugin generate-specs.js scripts to include spec-helpers generation
 */

import fs from "node:fs";
import path from "path";
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

function updateGenerateScript(pluginPath, pluginName) {
  const scriptPath = path.join(pluginPath, "prompts", "scripts", "generate-specs.js");
  const templatePath = path.join(REPO_ROOT, "plugins", "plugin-discord", "prompts", "scripts", "generate-specs.js");
  
  if (!fs.existsSync(scriptPath)) {
    console.log(`  ⚠️  No generate-specs.js found, skipping`);
    return false;
  }
  
  if (fs.existsSync(templatePath)) {
    let content = fs.readFileSync(templatePath, "utf-8");
    // Replace plugin-discord with the current plugin name
    content = content.replace(/plugin-discord/g, pluginName);
    // Replace elizaos_plugin_discord with elizaos_<plugin-name>
    const pythonModuleName = pluginName.replace("plugin-", "elizaos_plugin_");
    content = content.replace(/elizaos_plugin_discord/g, pythonModuleName);
    
    fs.writeFileSync(scriptPath, content);
    return true;
  }
  
  return false;
}

function main() {
  const plugins = getAllPlugins();
  console.log(`\n=== Updating generate-specs.js scripts for all plugins ===\n`);
  
  let updated = 0;
  let skipped = 0;
  
  for (const plugin of plugins) {
    const pluginPath = path.join(REPO_ROOT, "plugins", plugin);
    console.log(`Processing ${plugin}...`);
    
    if (updateGenerateScript(pluginPath, plugin)) {
      updated++;
      console.log(`  ✅ Updated`);
    } else {
      skipped++;
    }
  }
  
  console.log(`\n=== Summary ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`\nNext step: Run generate-specs.js for each plugin to regenerate code with spec-helpers`);
}

main();
