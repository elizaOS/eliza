#!/usr/bin/env node
/**
 * Batch process all plugins to centralize content
 * 
 * For each plugin:
 * 1. Extract specs from TypeScript files
 * 2. Generate language-specific code
 * 3. Update implementations (manual step - requires review)
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

function extractSpecs(pluginName) {
  console.log(`\n[${pluginName}] Extracting specs...`);
  try {
    execSync(`node scripts/extract-plugin-specs.js ${pluginName}`, {
      cwd: REPO_ROOT,
      stdio: 'inherit'
    });
    return true;
  } catch (e) {
    console.error(`Failed to extract specs for ${pluginName}:`, e.message);
    return false;
  }
}

function generateCode(pluginName) {
  const pluginPath = path.join(REPO_ROOT, "plugins", pluginName);
  const generateScript = path.join(pluginPath, "prompts", "scripts", "generate-specs.js");
  
  if (!fs.existsSync(generateScript)) {
    // Copy template generation script
    const templateScript = path.join(REPO_ROOT, "plugins", "plugin-discord", "prompts", "scripts", "generate-specs.js");
    if (fs.existsSync(templateScript)) {
      const scriptsDir = path.dirname(generateScript);
      fs.mkdirSync(scriptsDir, { recursive: true });
      let scriptContent = fs.readFileSync(templateScript, "utf-8");
      // Update plugin name in script
      scriptContent = scriptContent.replace(/plugin-discord/g, pluginName);
      fs.writeFileSync(generateScript, scriptContent);
      fs.chmodSync(generateScript, 0o755);
    } else {
      console.log(`  ⚠️  No generation script template found, skipping code generation`);
      return false;
    }
  }
  
  console.log(`[${pluginName}] Generating code...`);
  try {
    execSync(`node prompts/scripts/generate-specs.js`, {
      cwd: pluginPath,
      stdio: 'inherit'
    });
    return true;
  } catch (e) {
    console.error(`Failed to generate code for ${pluginName}:`, e.message);
    return false;
  }
}

function main() {
  const plugins = getAllPlugins();
  console.log(`Found ${plugins.length} plugins\n`);
  
  const results = {
    total: plugins.length,
    extracted: 0,
    generated: 0,
    skipped: 0,
    failed: [],
  };
  
  for (const plugin of plugins) {
    const pluginPath = path.join(REPO_ROOT, "plugins", plugin);
    
    if (!hasTypeScript(pluginPath)) {
      console.log(`[${plugin}] ⏭️  Skipping (no TypeScript)`);
      results.skipped++;
      continue;
    }
    
    // Extract specs
    if (extractSpecs(plugin)) {
      results.extracted++;
      
      // Generate code
      if (generateCode(plugin)) {
        results.generated++;
      } else {
        results.failed.push({ plugin, step: 'generation' });
      }
    } else {
      results.failed.push({ plugin, step: 'extraction' });
    }
  }
  
  console.log(`\n\n=== Summary ===`);
  console.log(`Total plugins: ${results.total}`);
  console.log(`Extracted specs: ${results.extracted}`);
  console.log(`Generated code: ${results.generated}`);
  console.log(`Skipped: ${results.skipped}`);
  console.log(`Failed: ${results.failed.length}`);
  
  if (results.failed.length > 0) {
    console.log(`\nFailed plugins:`);
    results.failed.forEach(({ plugin, step }) => {
      console.log(`  - ${plugin} (${step})`);
    });
  }
  
  console.log(`\n⚠️  Next steps:`);
  console.log(`1. Review generated specs in each plugin's prompts/specs/`);
  console.log(`2. Manually add examples and refine descriptions`);
  console.log(`3. Update TypeScript/Python/Rust implementations to use centralized specs`);
  console.log(`4. Fix type, lint, and build issues`);
}

main();
