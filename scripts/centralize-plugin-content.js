#!/usr/bin/env node
/**
 * Plugin Content Centralization Script
 *
 * For a given plugin, extracts action/provider/evaluator text content from
 * TypeScript implementations and creates JSON specs, then generates language-specific code.
 *
 * Usage: node scripts/centralize-plugin-content.js <plugin-name>
 * Example: node scripts/centralize-plugin-content.js plugin-discord
 */

import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, "..");
const PLUGINS_ROOT = path.join(REPO_ROOT, "plugins");

/**
 * Extract action object from TypeScript file
 */
function extractActionFromTS(filePath) {
  if (!fs.existsSync(filePath)) return null;
  
  const content = fs.readFileSync(filePath, "utf-8");
  
  // Find export const X: Action = { ... }
  const actionMatch = content.match(/export\s+(?:const|default)\s+(\w+):\s*Action\s*=\s*\{([\s\S]*?)\n\};/);
  if (!actionMatch) return null;
  
  const actionObj = actionMatch[2];
  
  // Extract name
  const nameMatch = actionObj.match(/name:\s*["']([^"']+)["']/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  
  // Extract description
  const descMatch = actionObj.match(/description:\s*["']([^"']+)["']/);
  const description = descMatch ? descMatch[1] : "";
  
  // Extract similes
  const similesMatch = actionObj.match(/similes:\s*\[([\s\S]*?)\]/);
  let similes = [];
  if (similesMatch) {
    const similesContent = similesMatch[1];
    const simileMatches = similesContent.matchAll(/["']([^"']+)["']/g);
    similes = Array.from(simileMatches, m => m[1]);
  }
  
  // Extract examples (simplified - looks for examples: [ ... ])
  const examplesMatch = actionObj.match(/examples:\s*(\[[\s\S]*?\])/);
  let examples = [];
  if (examplesMatch) {
    try {
      // Try to parse as JSON (may need cleanup)
      const examplesStr = examplesMatch[1];
      examples = JSON.parse(examplesStr);
    } catch (e) {
      // If parsing fails, return empty array
      examples = [];
    }
  }
  
  return { name, description, similes, examples, parameters: [] };
}

/**
 * Extract provider from TypeScript file
 */
function extractProviderFromTS(filePath) {
  if (!fs.existsSync(filePath)) return null;
  
  const content = fs.readFileSync(filePath, "utf-8");
  
  // Find export const X: Provider = { ... }
  const providerMatch = content.match(/export\s+(?:const|default)\s+(\w+):\s*Provider\s*=\s*\{([\s\S]*?)\n\};/);
  if (!providerMatch) return null;
  
  const providerObj = providerMatch[2];
  
  // Extract name
  const nameMatch = providerObj.match(/name:\s*["']([^"']+)["']/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  
  // Extract description (may be in comment or property)
  const descMatch = providerObj.match(/description:\s*["']([^"']+)["']/) || 
                    content.match(/@property\s+\{string\}\s+description\s+-\s+(.+)/);
  const description = descMatch ? descMatch[1].trim() : "";
  
  // Extract dynamic (defaults to true if not specified)
  const dynamicMatch = providerObj.match(/dynamic:\s*(true|false)/);
  const dynamic = dynamicMatch ? dynamicMatch[1] === "true" : true;
  
  return { name, description, dynamic };
}

/**
 * Scan plugin directory for actions and providers
 */
function scanPlugin(pluginName) {
  const pluginPath = path.join(PLUGINS_ROOT, pluginName);
  if (!fs.existsSync(pluginPath)) {
    console.error(`Plugin ${pluginName} not found at ${pluginPath}`);
    process.exit(1);
  }
  
  const tsActionsPath = path.join(pluginPath, "typescript", "actions");
  const tsProvidersPath = path.join(pluginPath, "typescript", "providers");
  
  const actions = [];
  const providers = [];
  
  // Scan actions
  if (fs.existsSync(tsActionsPath)) {
    const actionFiles = fs.readdirSync(tsActionsPath)
      .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    
    for (const file of actionFiles) {
      const action = extractActionFromTS(path.join(tsActionsPath, file));
      if (action) {
        actions.push(action);
      }
    }
  }
  
  // Scan providers
  if (fs.existsSync(tsProvidersPath)) {
    const providerFiles = fs.readdirSync(tsProvidersPath)
      .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    
    for (const file of providerFiles) {
      const provider = extractProviderFromTS(path.join(tsProvidersPath, file));
      if (provider) {
        providers.push(provider);
      }
    }
  }
  
  return { actions, providers };
}

/**
 * Create specs directory structure
 */
function createSpecsStructure(pluginName) {
  const pluginPath = path.join(PLUGINS_ROOT, pluginName);
  const specsPath = path.join(pluginPath, "prompts", "specs");
  
  fs.mkdirSync(path.join(specsPath, "actions"), { recursive: true });
  fs.mkdirSync(path.join(specsPath, "providers"), { recursive: true });
  fs.mkdirSync(path.join(specsPath, "evaluators"), { recursive: true });
  
  return specsPath;
}

/**
 * Write JSON spec file
 */
function writeSpecFile(specsPath, kind, items) {
  const spec = {
    version: "1.0.0",
    [kind]: items,
  };
  
  const filePath = path.join(specsPath, kind, "core.json");
  fs.writeFileSync(filePath, JSON.stringify(spec, null, 2) + "\n");
  console.log(`Created ${filePath} with ${items.length} ${kind}`);
}

function main() {
  const pluginName = process.argv[2];
  
  if (!pluginName) {
    console.error("Usage: node scripts/centralize-plugin-content.js <plugin-name>");
    process.exit(1);
  }
  
  console.log(`\n=== Centralizing content for ${pluginName} ===\n`);
  
  // Scan plugin
  const { actions, providers } = scanPlugin(pluginName);
  
  console.log(`Found ${actions.length} actions, ${providers.length} providers\n`);
  
  // Create specs structure
  const specsPath = createSpecsStructure(pluginName);
  
  // Write spec files
  if (actions.length > 0) {
    writeSpecFile(specsPath, "actions", actions);
  }
  
  if (providers.length > 0) {
    writeSpecFile(specsPath, "providers", providers);
  }
  
  // Write empty evaluators spec
  writeSpecFile(specsPath, "evaluators", []);
  
  console.log(`\n✅ Specs created for ${pluginName}`);
  console.log(`\nNext steps:`);
  console.log(`1. Review and refine the generated specs in ${specsPath}`);
  console.log(`2. Run the plugin's generate-specs.js script to generate language code`);
  console.log(`3. Update implementations to use centralized specs`);
}

main();
