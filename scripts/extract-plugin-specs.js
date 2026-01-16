#!/usr/bin/env node
/**
 * Extract plugin specs from TypeScript implementations
 * 
 * This script reads TypeScript action/provider files and extracts:
 * - name, description, similes, examples for actions
 * - name, description, dynamic for providers
 * 
 * Outputs JSON spec files ready for code generation.
 */

import fs from "node:fs";
import path from "path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

/**
 * Extract action spec from TypeScript file content
 */
function extractActionSpec(filePath, content) {
  // Match: export const X: Action = { ... }
  const actionRegex = /export\s+(?:const|default)\s+\w+:\s*Action\s*=\s*\{([\s\S]*?)\n\};/;
  const match = content.match(actionRegex);
  if (!match) return null;
  
  const actionBody = match[1];
  
  // Extract name
  const nameMatch = actionBody.match(/name:\s*["']([^"']+)["']/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  
  // Extract description (handle multi-line)
  let descMatch = actionBody.match(/description:\s*["']([^"']+)["']/);
  if (!descMatch) {
    // Try template literal
    descMatch = actionBody.match(/description:\s*`([^`]+)`/);
  }
  const description = descMatch ? descMatch[1].trim() : "";
  
  // Extract similes array
  const similesMatch = actionBody.match(/similes:\s*\[([\s\S]*?)\]/);
  const similes = [];
  if (similesMatch) {
    const similesContent = similesMatch[1];
    const simileRegex = /["']([^"']+)["']/g;
    let simileMatch;
    while ((simileMatch = simileRegex.exec(similesContent)) !== null) {
      similes.push(simileMatch[1]);
    }
  }
  
  // Extract examples (look for examples: [ ... ] as ActionExample[][])
  let examples = [];
  const examplesMatch = content.match(/examples:\s*(\[[\s\S]*?\])\s*as\s*ActionExample\[\]\[\]/);
  if (examplesMatch) {
    try {
      // Try to evaluate the examples array
      const examplesStr = examplesMatch[1];
      // Replace template strings with placeholders for JSON parsing
      const cleaned = examplesStr
        .replace(/\{\{name\d+\}\}/g, '"{{name}}"')
        .replace(/content:\s*\{/g, '"content": {')
        .replace(/text:\s*([^,}]+)/g, '"text": $1')
        .replace(/actions:\s*\[([^\]]+)\]/g, '"actions": [$1]')
        .replace(/(\w+):/g, '"$1":')
        .replace(/'/g, '"');
      
      // Try to parse as JSON
      try {
        examples = JSON.parse(cleaned);
      } catch (e) {
        // If parsing fails, leave empty - will need manual extraction
        examples = [];
      }
    } catch (e) {
      examples = [];
    }
  }
  
  return {
    name,
    description,
    similes: similes.length > 0 ? similes : undefined,
    parameters: [],
    examples: examples.length > 0 ? examples : undefined,
  };
}

/**
 * Extract provider spec from TypeScript file content
 */
function extractProviderSpec(filePath, content) {
  // Match: export const X: Provider = { ... }
  const providerRegex = /export\s+(?:const|default)\s+\w+:\s*Provider\s*=\s*\{([\s\S]*?)\n\};/;
  const match = content.match(providerRegex);
  if (!match) return null;
  
  const providerBody = match[1];
  
  // Extract name
  const nameMatch = providerBody.match(/name:\s*["']([^"']+)["']/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  
  // Extract description
  let descMatch = providerBody.match(/description:\s*["']([^"']+)["']/);
  if (!descMatch) {
    // Check JSDoc comment
    const jsdocMatch = content.match(/@property\s+\{string\}\s+description\s+-\s+(.+)/);
    if (jsdocMatch) {
      descMatch = [null, jsdocMatch[1].trim()];
    }
  }
  const description = descMatch ? descMatch[1].trim() : "";
  
  // Extract dynamic (defaults to true)
  const dynamicMatch = providerBody.match(/dynamic:\s*(true|false)/);
  const dynamic = dynamicMatch ? dynamicMatch[1] === "true" : true;
  
  return {
    name,
    description,
    dynamic,
  };
}

/**
 * Process a plugin directory
 */
function processPlugin(pluginName) {
  const pluginPath = path.join(REPO_ROOT, "plugins", pluginName);
  
  if (!fs.existsSync(pluginPath)) {
    console.error(`Plugin ${pluginName} not found`);
    return null;
  }
  
  const actionsPath = path.join(pluginPath, "typescript", "actions");
  const providersPath = path.join(pluginPath, "typescript", "providers");
  
  const actions = [];
  const providers = [];
  
  // Process actions
  if (fs.existsSync(actionsPath)) {
    const actionFiles = fs.readdirSync(actionsPath)
      .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("__"));
    
    for (const file of actionFiles) {
      const filePath = path.join(actionsPath, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const spec = extractActionSpec(filePath, content);
      if (spec) {
        actions.push(spec);
      }
    }
  }
  
  // Process providers
  if (fs.existsSync(providersPath)) {
    const providerFiles = fs.readdirSync(providersPath)
      .filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.includes("__"));
    
    for (const file of providerFiles) {
      const filePath = path.join(providersPath, file);
      const content = fs.readFileSync(filePath, "utf-8");
      const spec = extractProviderSpec(filePath, content);
      if (spec) {
        providers.push(spec);
      }
    }
  }
  
  return { actions, providers };
}

/**
 * Write spec files
 */
function writeSpecs(pluginName, actions, providers) {
  const pluginPath = path.join(REPO_ROOT, "plugins", pluginName);
  const promptsPath = path.join(pluginPath, "prompts");
  
  // Create prompts directory
  fs.mkdirSync(promptsPath, { recursive: true });
  
  // Write actions spec
  if (actions.length > 0) {
    const actionsSpec = {
      version: "1.0.0",
      actions: actions.sort((a, b) => a.name.localeCompare(b.name)),
    };
    fs.writeFileSync(
      path.join(promptsPath, "actions.json"),
      JSON.stringify(actionsSpec, null, 2) + "\n"
    );
  }
  
  // Write providers spec
  if (providers.length > 0) {
    const providersSpec = {
      version: "1.0.0",
      providers: providers.sort((a, b) => a.name.localeCompare(b.name)),
    };
    fs.writeFileSync(
      path.join(promptsPath, "providers.json"),
      JSON.stringify(providersSpec, null, 2) + "\n"
    );
  }
  
  // Write empty evaluators spec
  const evaluatorsSpec = {
    version: "1.0.0",
    evaluators: [],
  };
  fs.writeFileSync(
    path.join(promptsPath, "evaluators.json"),
    JSON.stringify(evaluatorsSpec, null, 2) + "\n"
  );
}

function main() {
  const pluginName = process.argv[2] || "plugin-discord";
  
  console.log(`\n=== Extracting specs for ${pluginName} ===\n`);
  
  const { actions, providers } = processPlugin(pluginName);
  
  if (!actions && !providers) {
    console.error("Failed to process plugin");
    process.exit(1);
  }
  
  console.log(`Found ${actions.length} actions, ${providers.length} providers`);
  
  writeSpecs(pluginName, actions, providers);
  
  console.log(`\n✅ Specs written to plugins/${pluginName}/prompts/specs/`);
  console.log(`\nNext: Run the plugin's generate-specs.js script`);
}

main();
