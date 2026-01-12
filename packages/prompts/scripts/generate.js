#!/usr/bin/env node

/**
 * Prompt Generator Script
 *
 * Generates native code from .txt prompt templates for:
 * - TypeScript
 * - Python
 * - Rust
 *
 * Usage:
 *   node scripts/generate.js              # Generate all targets
 *   node scripts/generate.js --target typescript
 *   node scripts/generate.js --target python
 *   node scripts/generate.js --target rust
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const PROMPTS_DIR = path.join(ROOT_DIR, "prompts");
const DIST_DIR = path.join(ROOT_DIR, "dist");

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
function loadPrompts() {
  const prompts = [];
  const files = fs.readdirSync(PROMPTS_DIR);

  for (const file of files) {
    if (!file.endsWith(".txt")) continue;

    const filepath = path.join(PROMPTS_DIR, file);
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
function generateTypeScript(prompts) {
  const outputDir = path.join(DIST_DIR, "typescript");
  fs.mkdirSync(outputDir, { recursive: true });

  let output = `/**
 * Auto-generated prompt templates for elizaOS
 * DO NOT EDIT - Generated from packages/prompts/prompts/*.txt
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

  // Add a boolean footer export for backwards compatibility
  output += `export const booleanFooter = "Respond with only a YES or a NO.";\n\n`;
  output += `export const BOOLEAN_FOOTER = booleanFooter;\n`;

  fs.writeFileSync(path.join(outputDir, "index.ts"), output);

  // Also generate a simple .d.ts file
  let dts = `/**
 * Auto-generated type definitions for elizaOS prompts
 */

`;
  for (const prompt of prompts) {
    dts += `export declare const ${prompt.camelName}: string;\n`;
    dts += `export declare const ${prompt.constName}: string;\n`;
  }
  dts += `export declare const booleanFooter: string;\n`;
  dts += `export declare const BOOLEAN_FOOTER: string;\n`;

  fs.writeFileSync(path.join(outputDir, "index.d.ts"), dts);

  console.log(`Generated TypeScript output: ${outputDir}/index.ts`);
}

/**
 * Generate Python output
 */
function generatePython(prompts) {
  const outputDir = path.join(DIST_DIR, "python");
  fs.mkdirSync(outputDir, { recursive: true });

  let output = `"""
Auto-generated prompt templates for elizaOS Python runtime.
DO NOT EDIT - Generated from packages/prompts/prompts/*.txt

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

  // Add boolean footer
  output += `BOOLEAN_FOOTER = "Respond with only a YES or a NO."\n`;

  // Add __all__ for explicit exports
  output += `\n__all__ = [\n`;
  for (const prompt of prompts) {
    output += `    "${prompt.constName}",\n`;
  }
  output += `    "BOOLEAN_FOOTER",\n`;
  output += `]\n`;

  fs.writeFileSync(path.join(outputDir, "prompts.py"), output);

  // Create __init__.py for package import
  fs.writeFileSync(
    path.join(outputDir, "__init__.py"),
    `"""elizaOS Prompts Package"""\nfrom .prompts import *\n`,
  );

  console.log(`Generated Python output: ${outputDir}/prompts.py`);
}

/**
 * Generate Rust output
 */
function generateRust(prompts) {
  const outputDir = path.join(DIST_DIR, "rust");
  fs.mkdirSync(outputDir, { recursive: true });

  let output = `//! Auto-generated prompt templates for elizaOS Rust runtime.
//! DO NOT EDIT - Generated from packages/prompts/prompts/*.txt
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

  // Add boolean footer
  output += `pub const BOOLEAN_FOOTER: &str = "Respond with only a YES or a NO.";\n`;

  fs.writeFileSync(path.join(outputDir, "prompts.rs"), output);

  // Also create a mod.rs that re-exports
  fs.writeFileSync(
    path.join(outputDir, "mod.rs"),
    `//! elizaOS Prompts Module\nmod prompts;\npub use prompts::*;\n`,
  );

  console.log(`Generated Rust output: ${outputDir}/prompts.rs`);
}

/**
 * Main entry point
 */
function main() {
  const args = process.argv.slice(2);
  const targetIndex = args.indexOf("--target");
  const target = targetIndex !== -1 ? args[targetIndex + 1] : "all";

  console.log("Loading prompts...");
  const prompts = loadPrompts();
  console.log(`Found ${prompts.length} prompt templates`);

  // Ensure dist directory exists
  fs.mkdirSync(DIST_DIR, { recursive: true });

  switch (target) {
    case "typescript":
      generateTypeScript(prompts);
      break;
    case "python":
      generatePython(prompts);
      break;
    case "rust":
      generateRust(prompts);
      break;
    default:
      generateTypeScript(prompts);
      generatePython(prompts);
      generateRust(prompts);
      break;
  }

  console.log("Done!");
}

main();
