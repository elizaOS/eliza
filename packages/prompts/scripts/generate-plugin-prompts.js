#!/usr/bin/env node

/**
 * Plugin Prompt Generator Script
 *
 * Generates native code from .txt prompt templates for plugins.
 * Can be used by any plugin to generate TypeScript, Python, and Rust exports.
 *
 * Usage:
 *   node generate-plugin-prompts.js <prompts-dir> <output-base-dir> [--target typescript|python|rust|all]
 *
 * Example:
 *   node generate-plugin-prompts.js ./prompts ./dist --target all
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Convert filename to constant name
 * e.g., "should_respond.txt" -> "SHOULD_RESPOND_TEMPLATE"
 */
function fileToConstName(filename) {
  const name = path.basename(filename, ".txt");
  return `${name.toUpperCase().replace(/-/g, "_")}_TEMPLATE`;
}

/**
 * Convert filename to camelCase name for TypeScript exports
 * e.g., "should_respond.txt" -> "shouldRespondTemplate"
 */
function fileToCamelCase(filename) {
  const name = path.basename(filename, ".txt");
  const parts = name.split("_");
  return (
    parts[0] +
    parts
      .slice(1)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join("") +
    "Template"
  );
}

/**
 * Escape a string for use in TypeScript template literal
 */
function escapeTypeScript(content) {
  return content
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

/**
 * Escape a string for use in Python triple-quoted string
 */
function escapePython(content) {
  return content.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
}

/**
 * Escape a string for use in Rust raw string literal
 * Rust raw strings r#"..."# don't need escaping except for the delimiter itself
 */
function escapeRust(content) {
  // Check if content contains "# - if so, we need more # in our delimiter
  let hashCount = 1;
  while (content.includes(`"${"#".repeat(hashCount)}`)) {
    hashCount++;
  }
  return { content, hashCount };
}

/**
 * Load all prompts from the prompts directory
 */
function loadPrompts(promptsDir) {
  if (!fs.existsSync(promptsDir)) {
    console.warn(`Warning: Prompts directory does not exist: ${promptsDir}`);
    return [];
  }

  const prompts = [];
  const files = fs.readdirSync(promptsDir);

  for (const file of files) {
    if (!file.endsWith(".txt")) continue;

    const filepath = path.join(promptsDir, file);
    const content = fs.readFileSync(filepath, "utf-8");

    prompts.push({
      filename: file,
      constName: fileToConstName(file),
      camelName: fileToCamelCase(file),
      content: content.trim(),
    });
  }

  return prompts.sort((a, b) => a.constName.localeCompare(b.constName));
}

/**
 * Generate TypeScript output
 */
function generateTypeScript(prompts, outputBaseDir, sourcePath) {
  const outputDir = path.join(outputBaseDir, "typescript");
  fs.mkdirSync(outputDir, { recursive: true });

  const relativeSourcePath = path
    .relative(outputDir, sourcePath)
    .replace(/\\/g, "/");

  let output = `/**
 * Auto-generated prompt templates
 * DO NOT EDIT - Generated from ${relativeSourcePath}/*.txt
 *
 * These prompts use Handlebars-style template syntax:
 * - {{variableName}} for simple substitution
 * - {{#each items}}...{{/each}} for iteration
 * - {{#if condition}}...{{/if}} for conditionals
 */

`;

  // Export each prompt as both const name and camelCase
  for (const prompt of prompts) {
    const escaped = escapeTypeScript(prompt.content);
    output += `export const ${prompt.camelName} = \`${escaped}\`;\n\n`;
    // Also export with uppercase name for backwards compatibility
    output += `export const ${prompt.constName} = ${prompt.camelName};\n\n`;
  }

  fs.writeFileSync(path.join(outputDir, "prompts.ts"), output);

  // Also generate a simple .d.ts file
  let dts = `/**
 * Auto-generated type definitions for prompts
 */

`;
  for (const prompt of prompts) {
    dts += `export declare const ${prompt.camelName}: string;\n`;
    dts += `export declare const ${prompt.constName}: string;\n`;
  }

  fs.writeFileSync(path.join(outputDir, "prompts.d.ts"), dts);

  console.log(`Generated TypeScript output: ${outputDir}/prompts.ts`);
}

/**
 * Generate Python output
 */
function generatePython(prompts, outputBaseDir, sourcePath) {
  const outputDir = path.join(outputBaseDir, "python");
  fs.mkdirSync(outputDir, { recursive: true });

  const relativeSourcePath = path
    .relative(outputDir, sourcePath)
    .replace(/\\/g, "/");

  let output = `"""
Auto-generated prompt templates
DO NOT EDIT - Generated from ${relativeSourcePath}/*.txt

These prompts use Handlebars-style template syntax:
- {{variableName}} for simple substitution
- {{#each items}}...{{/each}} for iteration
- {{#if condition}}...{{/if}} for conditionals
"""

from __future__ import annotations

`;

  for (const prompt of prompts) {
    const escaped = escapePython(prompt.content);
    output += `${prompt.constName} = """${escaped}"""\n\n`;
  }

  // Add __all__ for explicit exports
  output += `__all__ = [\n`;
  for (const prompt of prompts) {
    output += `    "${prompt.constName}",\n`;
  }
  output += `]\n`;

  fs.writeFileSync(path.join(outputDir, "prompts.py"), output);

  console.log(`Generated Python output: ${outputDir}/prompts.py`);

  // Try to copy to Python package directory if it exists
  // Look for python/elizaos_plugin_*/ directory structure
  const pluginRoot = path.resolve(outputBaseDir, "../..");
  const pythonDir = path.join(pluginRoot, "python");

  if (fs.existsSync(pythonDir)) {
    // Find elizaos_plugin_* directory
    const pythonPkgDirs = fs
      .readdirSync(pythonDir)
      .filter(
        (dir) =>
          dir.startsWith("elizaos_plugin_") &&
          fs.statSync(path.join(pythonDir, dir)).isDirectory(),
      );

    if (pythonPkgDirs.length > 0) {
      const pythonPkgDir = path.join(pythonDir, pythonPkgDirs[0]);
      const targetFile = path.join(pythonPkgDir, "_generated_prompts.py");

      // Copy generated prompts to Python package as _generated_prompts.py
      fs.copyFileSync(path.join(outputDir, "prompts.py"), targetFile);
      console.log(`Copied Python prompts to ${targetFile}`);
    }
  }
}

/**
 * Generate Rust output
 */
function generateRust(prompts, outputBaseDir, sourcePath) {
  const outputDir = path.join(outputBaseDir, "rust");
  fs.mkdirSync(outputDir, { recursive: true });

  const relativeSourcePath = path
    .relative(outputDir, sourcePath)
    .replace(/\\/g, "/");

  let output = `//! Auto-generated prompt templates
//! DO NOT EDIT - Generated from ${relativeSourcePath}/*.txt
//!
//! These prompts use Handlebars-style template syntax:
//! - {{variableName}} for simple substitution
//! - {{#each items}}...{{/each}} for iteration
//! - {{#if condition}}...{{/if}} for conditionals

`;

  for (const prompt of prompts) {
    const { content, hashCount } = escapeRust(prompt.content);
    const delimiter = "#".repeat(hashCount);
    output += `pub const ${prompt.constName}: &str = r${delimiter}"${content}"${delimiter};\n\n`;
  }

  fs.writeFileSync(path.join(outputDir, "prompts.rs"), output);

  console.log(`Generated Rust output: ${outputDir}/prompts.rs`);
}

/**
 * Main entry point
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(
      "Usage: generate-plugin-prompts.js <prompts-dir> <output-base-dir> [--target typescript|python|rust|all]",
    );
    process.exit(1);
  }

  const promptsDir = path.resolve(args[0]);
  const outputBaseDir = path.resolve(args[1]);
  const targetIndex = args.indexOf("--target");
  const target = targetIndex !== -1 ? args[targetIndex + 1] : "all";

  console.log(`Loading prompts from: ${promptsDir}`);
  const prompts = loadPrompts(promptsDir);
  console.log(`Found ${prompts.length} prompt templates`);

  if (prompts.length === 0) {
    console.warn("No prompts found. Exiting.");
    return;
  }

  // Ensure output directory exists
  fs.mkdirSync(outputBaseDir, { recursive: true });

  switch (target) {
    case "typescript":
      generateTypeScript(prompts, outputBaseDir, promptsDir);
      break;
    case "python":
      generatePython(prompts, outputBaseDir, promptsDir);
      break;
    case "rust":
      generateRust(prompts, outputBaseDir, promptsDir);
      break;
    default:
      generateTypeScript(prompts, outputBaseDir, promptsDir);
      generatePython(prompts, outputBaseDir, promptsDir);
      generateRust(prompts, outputBaseDir, promptsDir);
      break;
  }

  console.log("Done!");
}

main();
