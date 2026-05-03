#!/usr/bin/env node

/**
 * Prompt Generator Script
 *
 * Generates TypeScript code from .txt prompt templates.
 *
 * Usage:
 *   node scripts/generate.js
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
 * Main entry point
 */
function main() {
  console.log("Loading prompts...");
  const prompts = loadPrompts();
  console.log(`Found ${prompts.length} prompt templates`);

  fs.mkdirSync(DIST_DIR, { recursive: true });
  generateTypeScript(prompts);

  console.log("Done!");
}

main();
