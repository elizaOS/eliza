#!/usr/bin/env node
/**
 * Process all plugins to centralize content
 * 
 * For each plugin:
 * 1. Extract specs from TypeScript files
 * 2. Generate language-specific code
 * 3. Update implementations
 * 4. Report status
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

function hasTypeScript(pluginPath) {
  const tsPath = path.join(pluginPath, "typescript");
  return fs.existsSync(tsPath);
}

function copyGenerationScript(pluginName) {
  const pluginPath = path.join(REPO_ROOT, "plugins", pluginName);
  const generateScript = path.join(pluginPath, "prompts", "scripts", "generate-specs.js");
  
  if (fs.existsSync(generateScript)) {
    return true;
  }
  
  // Copy template from plugin-discord
  const templateScript = path.join(REPO_ROOT, "plugins", "plugin-discord", "prompts", "scripts", "generate-specs.js");
  if (!fs.existsSync(templateScript)) {
    return false;
  }
  
  const scriptsDir = path.dirname(generateScript);
  fs.mkdirSync(scriptsDir, { recursive: true });
  
  let scriptContent = fs.readFileSync(templateScript, "utf-8");
  // Update plugin name references
  scriptContent = scriptContent.replace(/plugin-discord/g, pluginName);
  fs.writeFileSync(generateScript, scriptContent);
  fs.chmodSync(generateScript, 0o755);
  
  return true;
}

function processPlugin(pluginName) {
  const pluginPath = path.join(REPO_ROOT, "plugins", pluginName);
  
  if (!hasTypeScript(pluginPath)) {
    return { status: "skipped", reason: "no-typescript" };
  }
  
  try {
    // Step 1: Extract specs
    console.log(`  [1/3] Extracting specs...`);
    execSync(`node scripts/extract-plugin-specs.js ${pluginName}`, {
      cwd: REPO_ROOT,
      stdio: 'pipe'
    });
    
    // Step 2: Copy generation script if needed
    if (!copyGenerationScript(pluginName)) {
      return { status: "error", reason: "failed-to-create-generation-script" };
    }
    
    // Step 3: Generate code
    console.log(`  [2/3] Generating code...`);
    execSync(`node prompts/scripts/generate-specs.js`, {
      cwd: pluginPath,
      stdio: 'pipe'
    });
    
    // Step 4: Update implementations
    console.log(`  [3/3] Updating implementations...`);
    execSync(`node scripts/update-plugin-implementations.js ${pluginName}`, {
      cwd: REPO_ROOT,
      stdio: 'pipe'
    });
    
    return { status: "success" };
  } catch (e) {
    return { status: "error", reason: e.message };
  }
}

function main() {
  const plugins = getAllPlugins();
  console.log(`\n=== Processing ${plugins.length} plugins ===\n`);
  
  const results = {
    total: plugins.length,
    success: 0,
    skipped: 0,
    errors: [],
  };
  
  for (const plugin of plugins) {
    console.log(`\n[${plugin}]`);
    const result = processPlugin(plugin);
    
    if (result.status === "success") {
      results.success++;
      console.log(`  ✅ Complete`);
    } else if (result.status === "skipped") {
      results.skipped++;
      console.log(`  ⏭️  Skipped: ${result.reason}`);
    } else {
      results.errors.push({ plugin, reason: result.reason });
      console.log(`  ❌ Error: ${result.reason}`);
    }
  }
  
  console.log(`\n\n=== Summary ===`);
  console.log(`Total: ${results.total}`);
  console.log(`✅ Success: ${results.success}`);
  console.log(`⏭️  Skipped: ${results.skipped}`);
  console.log(`❌ Errors: ${results.errors.length}`);
  
  if (results.errors.length > 0) {
    console.log(`\nFailed plugins:`);
    results.errors.forEach(({ plugin, reason }) => {
      console.log(`  - ${plugin}: ${reason}`);
    });
  }
  
  console.log(`\n⚠️  Next steps for each plugin:`);
  console.log(`1. Review and add comprehensive examples to prompts/actions.json`);
  console.log(`2. Add examples showing when NOT to use each action`);
  console.log(`3. Fix any type/lint/build issues`);
  console.log(`4. Update Python/Rust implementations if they exist`);
}

main();
