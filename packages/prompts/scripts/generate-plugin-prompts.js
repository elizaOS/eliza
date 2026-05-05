#!/usr/bin/env node

/**
 * Plugin Prompt Generator Script
 *
 * Generates a TypeScript prompts.ts module from .txt prompt templates for plugins.
 *
 * Usage:
 *   node generate-plugin-prompts.js <prompts-dir> <output-base-dir>
 *
 * Example:
 *   node generate-plugin-prompts.js ./prompts ./dist
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function biomeFormat(filePaths) {
  if (filePaths.length === 0) return;
  const result = spawnSync(
    "bunx",
    [
      "--bun",
      "@biomejs/biome",
      "format",
      "--write",
      "--no-errors-on-unmatched",
      ...filePaths,
    ],
    { stdio: "inherit", shell: false },
  );
  if (result.status !== 0) {
    console.warn(
      `Warning: biome format exited with status ${result.status} for generated prompts`,
    );
  }
}

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

  const tsFile = path.join(outputDir, "prompts.ts");
  fs.writeFileSync(tsFile, output);

  // Also generate a simple .d.ts file
  let dts = `/**
 * Auto-generated type definitions for prompts
 */

`;
  for (const prompt of prompts) {
    dts += `export declare const ${prompt.camelName}: string;\n`;
    dts += `export declare const ${prompt.constName}: string;\n`;
  }

  const dtsFile = path.join(outputDir, "prompts.d.ts");
  fs.writeFileSync(dtsFile, dts);

  biomeFormat([tsFile, dtsFile]);

  console.log(`Generated TypeScript output: ${outputDir}/prompts.ts`);
}

/**
 * Main entry point
 */
function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.error(
      "Usage: generate-plugin-prompts.js <prompts-dir> <output-base-dir>",
    );
    process.exit(1);
  }

  const promptsDir = path.resolve(args[0]);
  const outputBaseDir = path.resolve(args[1]);

  console.log(`Loading prompts from: ${promptsDir}`);
  const prompts = loadPrompts(promptsDir);
  console.log(`Found ${prompts.length} prompt templates`);

  if (prompts.length === 0) {
    console.warn("No prompts found. Exiting.");
    return;
  }

  fs.mkdirSync(outputBaseDir, { recursive: true });
  generateTypeScript(prompts, outputBaseDir, promptsDir);

  console.log("Done!");
}

main();
