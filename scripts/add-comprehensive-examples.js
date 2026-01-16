#!/usr/bin/env node
/**
 * Add comprehensive examples to plugin actions.json files
 * 
 * For each action, adds:
 * - 2-6 turn conversation examples showing correct usage
 * - Examples where the action should NOT be used (negative examples)
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

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function hasExamples(action) {
  return action.examples && Array.isArray(action.examples) && action.examples.length > 0;
}

function needsExamples(pluginName, actionsJson) {
  if (!actionsJson || !actionsJson.actions) return false;
  
  const actionsWithoutExamples = actionsJson.actions.filter(a => !hasExamples(a));
  return actionsWithoutExamples.length > 0;
}

function main() {
  const plugins = getAllPlugins();
  console.log(`\n=== Checking plugins for missing examples ===\n`);
  
  const needsWork = [];
  
  for (const plugin of plugins) {
    const actionsPath = path.join(REPO_ROOT, "plugins", plugin, "prompts", "actions.json");
    const actionsJson = readJson(actionsPath);
    
    if (needsExamples(plugin, actionsJson)) {
      const actionsWithoutExamples = actionsJson.actions.filter(a => !hasExamples(a));
      needsWork.push({
        plugin,
        count: actionsWithoutExamples.length,
        actions: actionsWithoutExamples.map(a => a.name),
      });
    }
  }
  
  console.log(`Found ${needsWork.length} plugins needing examples:\n`);
  needsWork.forEach(({ plugin, count, actions }) => {
    console.log(`  ${plugin}: ${count} actions without examples`);
    console.log(`    Actions: ${actions.join(", ")}\n`);
  });
  
  console.log(`\n⚠️  Note: Examples should include:`);
  console.log(`  - 2-6 turn conversations showing correct usage`);
  console.log(`  - Examples where the action should NOT be used (even if it seems like it should)`);
}

main();
